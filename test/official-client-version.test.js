const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  discoverOfficialClientVersionStrings,
  extractComputedClientVersionStrings,
  extractOfficialJavaScriptAssetUrls,
  mergeDiscoveredClientVersionStrings,
  readCurrentSuccessfulClientVersion,
  readResponseTextLimited
} = require('../src/official-client-version');

function response(text, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => headers[String(name).toLowerCase()] || null
    },
    body: null,
    text: async () => text
  };
}

test('official JavaScript assets include version code and Unity loader only once', () => {
  const urls = extractOfficialJavaScriptAssetUrls({
    base: 'https://game.example/client/',
    versionInfo: { code: 'v0.20.1/code.js' },
    indexHtml: `
      <script src="Build/client.loader.js"></script>
      <script src="https://analytics.example/tracker.js"></script>
      <script>const codeUrl = "Build/client.wasm";</script>
      <script>const loaderUrl = "Build/client.loader.js";</script>
      <script>const frameworkUrl = "Build/client.framework.js";</script>
    `
  });

  assert.deepEqual(urls, [
    'https://game.example/client/v0.20.1/code.js',
    'https://game.example/client/Build/client.loader.js'
  ]);
});

test('exact official strings are collected from index, code and loader assets', async () => {
  const bodies = new Map([
    ['https://game.example/v0.20.1/code.js', 'const clientPrefix="WebGL_2023-";'],
    ['https://game.example/Build/client.loader.js', 'const fallback="web-0.20.1";']
  ]);
  const result = await discoverOfficialClientVersionStrings({
    base: 'https://game.example/',
    versionInfo: { code: 'v0.20.1/code.js' },
    indexHtml: '<script>createUnityInstance(canvas,{productVersion:"4.1.2"})</script><script src="Build/client.loader.js"></script>',
    fetchImpl: async url => response(bodies.get(String(url)) || '', {
      status: bodies.has(String(url)) ? 200 : 404
    }),
    logger: { warn() {} }
  });

  assert.deepEqual(result.strings, [
    'WebGL_2023-4.1.2',
    'web-0.20.1'
  ]);
  assert.equal(result.sources['WebGL_2023-4.1.2'], '/v0.20.1/code.js#prefix+productVersion');
});

test('obfuscated client builder resolves its string table prefix safely', () => {
  const source = [
    "$U=$y=$p=['unused'];",
    "$J=$3=$6=['object',/x[y]z/g,'web-','tail'];",
    "v[$6[1]][$x[4901]]=function(){return $J[2]+game[$U[315]][$x[56]][$6[76]]('.w','');};"
  ].join('');

  assert.deepEqual(
    extractComputedClientVersionStrings(source, '0.11.252.w'),
    [{
      value: 'web-0.11.252',
      tableName: '$J',
      index: 2,
      prefix: 'web-',
      offset: source.indexOf('function()')
    }]
  );
});

test('unchanged official metadata reuses the last successful client string', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'majsoul-client-cache-'));
  const cachePath = path.join(directory, 'resource-version.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    clientVersionStrings: { jp: 'web-0.11.252' },
    sourceVersions: { jp: '0.11.252.w' },
    productVersions: { jp: '4.0.11' },
    buildIds: { jp: 'jp-WebGL-release-4.0.11(12)' }
  }));

  try {
    assert.deepEqual(
      readCurrentSuccessfulClientVersion({
        serverKey: 'jp',
        versionInfo: { version: '0.11.252.w' },
        indexHtml: '<script src="Build/jp-WebGL-release-4.0.11(12).loader.js"></script><script>const config={productVersion:"4.0.11"};</script>',
        cachePath
      }),
      {
        clientVersionString: 'web-0.11.252',
        productVersion: '4.0.11',
        buildId: 'jp-WebGL-release-4.0.11(12)'
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('discovered exact strings are inserted ahead of generated detected candidates', () => {
  const merged = mergeDiscoveredClientVersionStrings(
    { detectedClientVersionStrings: ['WebGL_2022-4.0.11'] },
    ['WebGL_2023-0.20.1']
  );

  assert.deepEqual(merged.detectedClientVersionStrings, [
    'WebGL_2023-0.20.1',
    'WebGL_2022-4.0.11'
  ]);
});

test('asset reader rejects responses beyond the configured byte limit', async () => {
  await assert.rejects(
    readResponseTextLimited(response('12345', {
      headers: { 'content-length': '5' }
    }), 4),
    /exceeds 4 bytes/
  );
});
