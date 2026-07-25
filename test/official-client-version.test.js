const assert = require('node:assert/strict');
const test = require('node:test');

const {
  discoverOfficialClientVersionStrings,
  extractOfficialJavaScriptAssetUrls,
  mergeDiscoveredClientVersionStrings,
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
    ['https://game.example/v0.20.1/code.js', 'client_version_string:"WebGL_2023-0.20.1"'],
    ['https://game.example/Build/client.loader.js', 'const fallback="web-0.20.1";']
  ]);
  const result = await discoverOfficialClientVersionStrings({
    base: 'https://game.example/',
    versionInfo: { code: 'v0.20.1/code.js' },
    indexHtml: '<script src="Build/client.loader.js"></script>',
    fetchImpl: async url => response(bodies.get(String(url)) || '', {
      status: bodies.has(String(url)) ? 200 : 404
    }),
    logger: { warn() {} }
  });

  assert.deepEqual(result.strings, [
    'WebGL_2023-0.20.1',
    'web-0.20.1'
  ]);
  assert.equal(result.sources['WebGL_2023-0.20.1'], '/v0.20.1/code.js');
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
