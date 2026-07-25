const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SYNTHETIC_LIQI_PREFIX,
  createStructureFetchWrapper,
  extractLiqiUrls,
  extractProductVersion,
  extractReferencedAssetUrls,
  extractUnityBuildId,
  normalizeGatewayConfig,
  normalizeResourceManifest,
  normalizeRoutesPayload,
  prepareOfficialStructureFallbacks
} = require('../src/official-structure-fallbacks');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain' }
  });
}

test('productVersion is discovered from property, meta tag and build filename forms', () => {
  assert.equal(extractProductVersion('{"product_version":"5.1.7"}'), '5.1.7');
  assert.equal(
    extractProductVersion('<meta name="product-version" content="5.2.1">'),
    '5.2.1'
  );
  assert.equal(
    extractProductVersion('<script src="Build/jp-WebGL-release-6.0.3(9).loader.js"></script>'),
    '6.0.3'
  );
});

test('Unity build id is discovered from loader, config property and compressed assets', () => {
  assert.equal(
    extractUnityBuildId('<script src="Build/jp-WebGL-release-4.0.11(12).loader.js"></script>'),
    'jp-WebGL-release-4.0.11(12)'
  );
  assert.equal(
    extractUnityBuildId('const loaderUrl="assets/new-client.loader.js";'),
    'new-client'
  );
  assert.equal(
    extractUnityBuildId('{"frameworkUrl":"Build/build-x.framework.js.gz"}'),
    'build-x'
  );
});

test('same-origin metadata references are collected and external assets are rejected', () => {
  const urls = extractReferencedAssetUrls(`
    <script src="Build/client.loader.js"></script>
    <script src="https://analytics.example/tracker.js"></script>
    const configUrl = "settings/client-config.json";
    const liqiUrl = "/assets/proto/liqi.json";
  `, 'https://game.example/client/');

  assert.deepEqual(urls, [
    'https://game.example/client/Build/client.loader.js',
    'https://game.example/client/settings/client-config.json',
    'https://game.example/assets/proto/liqi.json'
  ]);
});

test('nested gateway config is normalized to the legacy ip.gateways shape', () => {
  const state = { gatewayUrls: [] };
  const normalized = normalizeGatewayConfig({
    regions: {
      jp: {
        clientGateway: {
          endpoint: 'https://gateway.example/v2'
        }
      }
    }
  }, 'https://game.example/config/client.json', state);

  assert.equal(normalized.ip[0].gateways[0].url, 'https://gateway.example/v2');
  assert.deepEqual(state.gatewayUrls, ['https://gateway.example/v2']);
});

test('resource manifest recognizes direct liqi paths and creates a compatible prefix', () => {
  const state = { base: 'https://game.example/', liqiUrls: [] };
  const normalized = normalizeResourceManifest({
    assets: [{ name: 'protocol', url: '/versioned/res/proto/liqi.json' }]
  }, 'https://game.example/manifest.json', state);

  assert.deepEqual(extractLiqiUrls(normalized, 'https://game.example/manifest.json'), [
    'https://game.example/versioned/res/proto/liqi.json'
  ]);
  assert.equal(normalized.res['res/proto/liqi.json'].prefix, 'versioned');
});

test('nonstandard or cross-origin liqi locations use the synthetic intercepted prefix', () => {
  const state = { base: 'https://game.example/', liqiUrls: [] };
  const normalized = normalizeResourceManifest({
    protocol: { liqi: 'https://cdn.example/proto/liqi.json' }
  }, 'https://game.example/manifest.json', state);

  assert.equal(normalized.res['res/proto/liqi.json'].prefix, SYNTHETIC_LIQI_PREFIX);
  assert.deepEqual(state.liqiUrls, ['https://cdn.example/proto/liqi.json']);
});

test('route payload variants are normalized to data.routes', () => {
  const normalized = normalizeRoutesPayload({
    result: {
      servers: [
        { name: 'jp-a', endpoint: 'wss://route-a.example/gateway' },
        { routeId: 9, host: 'route-b.example:443' }
      ]
    }
  });

  assert.deepEqual(normalized.data.routes, [
    { name: 'jp-a', endpoint: 'wss://route-a.example/gateway', id: 'jp-a', domain: 'route-a.example' },
    { routeId: 9, host: 'route-b.example:443', id: '9', domain: 'route-b.example' }
  ]);
});

test('fetch wrapper falls back to moved config, manifest, liqi and route endpoints', async () => {
  const calls = [];
  const responses = new Map([
    ['https://game.example/config/client.json', jsonResponse({
      services: { gateway: { url: 'https://gate.example' } }
    })],
    ['https://game.example/manifests/resources.json', jsonResponse({
      files: { protocol: '/proto/liqi.json' }
    })],
    ['https://game.example/proto/liqi.json', jsonResponse({ nested: { lq: {} } })],
    ['https://gate.example/routes?platform=Web', jsonResponse({
      result: { nodes: [{ key: 'a', address: 'wss://gs-a.example/gateway' }] }
    })]
  ]);
  const originalFetch = async input => {
    const url = String(input);
    calls.push(url);
    return responses.get(url) || textResponse('not found', 404);
  };
  const state = {
    originalFetch,
    logger: { log() {}, warn() {} },
    base: 'https://game.example/',
    configUrls: ['https://game.example/config/client.json'],
    manifestUrls: ['https://game.example/manifests/resources.json'],
    liqiUrls: ['https://game.example/proto/liqi.json'],
    gatewayUrls: ['https://gate.example']
  };
  const wrapped = createStructureFetchWrapper(state);

  const config = await (await wrapped('https://game.example/v1/config.json')).json();
  assert.equal(config.ip[0].gateways[0].url, 'https://gate.example');

  const manifest = await (await wrapped('https://game.example/resversion1.2.3.json')).json();
  assert.equal(manifest.res['res/proto/liqi.json'].prefix, SYNTHETIC_LIQI_PREFIX);

  const liqi = await (await wrapped('https://game.example/__official_structure_liqi__/res/proto/liqi.json')).json();
  assert.deepEqual(liqi.nested, { lq: {} });

  const routes = await (await wrapped('https://gate.example/api/clientgate/routes?platform=Web')).json();
  assert.equal(routes.data.routes[0].domain, 'gs-a.example');
  assert.ok(calls.includes('https://game.example/config/client.json'));
  assert.ok(calls.includes('https://game.example/manifests/resources.json'));
  assert.ok(calls.includes('https://gate.example/routes?platform=Web'));
});

test('prepare discovers external metadata fallbacks, patches parsers and writes reusable hints', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-fallbacks-'));
  const cachePath = path.join(directory, 'resource-version.json');
  const responses = new Map([
    ['https://game.example/version.json', jsonResponse({
      version: '0.20.4.w',
      code: 'assets/runtime.js',
      metadata: 'metadata/client.json'
    })],
    ['https://game.example/index.html', textResponse(`
      <script src="assets/runtime.js"></script>
      <script>const configUrl='metadata/client-config.json';</script>
    `)],
    ['https://game.example/assets/runtime.js', textResponse(`
      const packageVersion='7.1.3';
      const loaderUrl='Build/new-WebGL-release-7.1.3(2).loader.js';
      const manifestUrl='metadata/resource-manifest.json';
    `)],
    ['https://game.example/metadata/client.json', jsonResponse({})]
  ]);
  const fetchImpl = async input => {
    const url = new URL(String(input));
    url.search = '';
    return responses.get(url.toString()) || textResponse('not found', 404);
  };

  const result = await prepareOfficialStructureFallbacks({
    serverKey: 'jp',
    base: 'https://game.example/',
    fetchImpl,
    logger: { log() {}, warn() {} },
    forceRefresh: true,
    cachePath
  });

  assert.equal(result.productVersion, '7.1.3');
  assert.equal(result.buildId, 'new-WebGL-release-7.1.3(2)');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.structureHints.jp.productVersion, '7.1.3');
  assert.ok(cache.structureHints.jp.configUrls.includes('https://game.example/metadata/client-config.json'));
});
