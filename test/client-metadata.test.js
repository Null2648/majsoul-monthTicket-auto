const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_RESOURCE_VERSION,
  buildClientMetadata,
  buildClientVersionStringCandidates,
  buildResourceVersionCandidates,
  buildPasswordLoginPayload,
  buildOauth2AuthPayload,
  buildOauth2LoginPayload,
  buildWebClientVersionString,
  extractClientVersionStrings,
  normalizeClientVersionString,
  normalizeResourceVersion,
  parseResourceVersion,
  parseProductVersion
} = require('../src/client-metadata');

test('parseProductVersion reads Unity productVersion from index HTML', () => {
  const html = '<script>createUnityInstance(canvas, { productVersion: "4.0.9" })</script>';

  assert.equal(parseProductVersion(html), '4.0.9');
});

test('buildClientMetadata uses WebGL resource string and package product version', () => {
  const metadata = buildClientMetadata({
    productVersion: '4.0.9',
    resourceVersion: '0.16.193'
  });

  assert.deepEqual(metadata, {
    routeVersion: '4.0.9',
    clientVersion: {
      resource: '0.16.193',
      package: '4.0.9'
    },
    clientVersionString: 'WebGL_2022-0.16.193'
  });
});

test('buildClientMetadata falls back to current default resource version', () => {
  const metadata = buildClientMetadata({ productVersion: '4.0.7' });

  assert.equal(metadata.clientVersion.resource, DEFAULT_RESOURCE_VERSION);
  assert.equal(metadata.clientVersionString, `WebGL_2022-${DEFAULT_RESOURCE_VERSION}`);
});

test('official client version strings are extracted without guessing their prefix', () => {
  const script = [
    'const oldVersion = "WebGL_2022-0.16.260";',
    'const currentVersion = "WebGL_2023-0.18.7";',
    'const duplicate = "WebGL_2023-0.18.7";'
  ].join('\n');

  assert.deepEqual(extractClientVersionStrings(script), [
    'WebGL_2022-0.16.260',
    'WebGL_2023-0.18.7'
  ]);
  assert.equal(normalizeClientVersionString('WebGL_2023-0.18.7'), 'WebGL_2023-0.18.7');
  assert.equal(normalizeClientVersionString('desktop-0.18.7'), null);
});

test('exact detected client strings are tried before cached scan candidates', () => {
  const candidates = buildClientVersionStringCandidates({
    overrideClientVersionString: 'WebGL_2024-0.19.1',
    detectedClientVersionStrings: ['WebGL_2023-0.18.7'],
    cachedClientVersionString: 'WebGL_2022-0.16.260',
    resourceVersionCandidates: ['0.16.260', '0.16.261'],
    webResourceVersion: '0.11.252.w'
  });

  assert.deepEqual(candidates, [
    'WebGL_2024-0.19.1',
    'WebGL_2023-0.18.7',
    'web-0.11.252',
    'WebGL_2022-0.16.260',
    'WebGL_2022-0.16.261'
  ]);
});

test('unchanged metadata reuses the last successful client string first', () => {
  const candidates = buildClientVersionStringCandidates({
    detectedClientVersionStrings: ['WebGL_2023-0.18.7'],
    cachedClientVersionString: 'web-0.11.252',
    resourceVersionCandidates: ['0.16.260'],
    webResourceVersion: '0.11.252.w',
    preferCachedClientVersion: true
  });

  assert.deepEqual(candidates, [
    'web-0.11.252',
    'WebGL_2023-0.18.7',
    'WebGL_2022-0.16.260'
  ]);
});

test('buildClientMetadata preserves an exact client string discovered in official assets', () => {
  const metadata = buildClientMetadata({
    productVersion: '4.0.11',
    clientVersionString: 'WebGL_2023-0.18.7'
  });

  assert.deepEqual(metadata, {
    routeVersion: '4.0.11',
    clientVersion: {
      resource: '0.18.7',
      package: '4.0.11'
    },
    clientVersionString: 'WebGL_2023-0.18.7'
  });
});

test('current web metadata matches the official JP login payload', () => {
  const metadata = buildClientMetadata({
    productVersion: '4.0.11',
    resourceVersion: '0.11.252.w',
    clientVersionString: 'web-0.11.252'
  });

  assert.deepEqual(metadata, {
    routeVersion: '4.0.11',
    clientVersion: {
      resource: '0.11.252.w'
    },
    clientVersionString: 'web-0.11.252'
  });
});

test('official JP web client string is derived from version.json resource metadata', () => {
  assert.equal(buildWebClientVersionString('0.11.252.w'), 'web-0.11.252');
  assert.equal(buildWebClientVersionString('v0.12.3.w'), 'web-0.12.3');
  assert.throws(
    () => buildWebClientVersionString('latest'),
    /dotted resource version/
  );
});

test('resource version candidates continue forward from the newest known version', () => {
  const candidates = buildResourceVersionCandidates({
    cachedResourceVersion: '0.16.260',
    detectedResourceVersion: '0.16.258',
    forwardScanLimit: 3,
    nextMinorScanLimit: 1,
    backwardScanLimit: 1
  });

  assert.deepEqual(candidates.slice(0, 6), [
    '0.16.258',
    '0.16.260',
    '0.16.261',
    '0.16.262',
    '0.16.263',
    '0.17.0'
  ]);
  assert.ok(candidates.includes('0.17.1'));
  assert.ok(candidates.includes('0.16.259'));
});

test('resource version recovery checks a new minor before a long patch scan', () => {
  const candidates = buildResourceVersionCandidates({
    cachedResourceVersion: '0.16.260',
    forwardScanLimit: 40,
    nextMinorScanLimit: 1,
    backwardScanLimit: 0
  });

  assert.equal(candidates[0], '0.16.260');
  assert.equal(candidates[32], '0.16.292');
  assert.deepEqual(candidates.slice(33, 35), ['0.17.0', '0.17.1']);
  assert.deepEqual(candidates.slice(35, 37), ['0.16.293', '0.16.294']);
});

test('resource version candidates normalize WebGL prefixes and remove duplicates', () => {
  const candidates = buildResourceVersionCandidates({
    overrideResourceVersion: 'WebGL_2022-0.16.261',
    detectedResourceVersion: 'v0.16.261',
    cachedResourceVersion: '0.16.260',
    forwardScanLimit: 1,
    nextMinorScanLimit: 0,
    backwardScanLimit: 0
  });

  assert.deepEqual(candidates.slice(0, 3), [
    '0.16.261',
    '0.16.260',
    '0.16.262'
  ]);
});

test('resource version parsing rejects malformed values', () => {
  assert.equal(normalizeResourceVersion('WebGL_2022-0.16.261'), '0.16.261');
  assert.deepEqual(parseResourceVersion('0.16.261'), [0, 16, 261]);
  assert.equal(parseResourceVersion('0.16'), null);
  assert.equal(parseResourceVersion('latest'), null);
});

test('buildOauth2AuthPayload sends Yostar token as code with current client version string', () => {
  assert.deepEqual(
    buildOauth2AuthPayload({
      oauthType: 21,
      uid: '14860741831',
      token: 'token-value',
      clientVersionString: 'WebGL_2022-0.16.193'
    }),
    {
      type: 21,
      code: 'token-value',
      uid: '14860741831',
      client_version_string: 'WebGL_2022-0.16.193'
    }
  );
});

test('buildOauth2LoginPayload includes package version and server currency platforms', () => {
  const payload = buildOauth2LoginPayload({
    oauthType: 22,
    accessToken: 'access-token',
    device: { platform: 'pc' },
    randomKey: 'random-key',
    clientVersion: { resource: '0.16.193', package: '4.0.7' },
    clientVersionString: 'WebGL_2022-0.16.193',
    currencyPlatforms: [1, 4, 5, 9, 12],
    tag: 'en'
  });

  assert.deepEqual(payload, {
    type: 22,
    access_token: 'access-token',
    reconnect: false,
    device: { platform: 'pc' },
    random_key: 'random-key',
    client_version: { resource: '0.16.193', package: '4.0.7' },
    client_version_string: 'WebGL_2022-0.16.193',
    currency_platforms: [1, 4, 5, 9, 12],
    tag: 'en'
  });
});

test('buildPasswordLoginPayload includes current client metadata for CN login', () => {
  const payload = buildPasswordLoginPayload({
    account: 'user@example.com',
    password: 'hashed-password',
    device: { platform: 'pc' },
    randomKey: 'random-key',
    clientVersion: { resource: '0.16.193', package: '4.0.44' },
    clientVersionString: 'WebGL_2022-0.16.193',
    currencyPlatforms: [1, 2, 5, 6, 8, 10, 11],
    loginType: 0,
    tag: 'cn'
  });

  assert.deepEqual(payload, {
    account: 'user@example.com',
    password: 'hashed-password',
    reconnect: false,
    device: { platform: 'pc' },
    random_key: 'random-key',
    client_version: { resource: '0.16.193', package: '4.0.44' },
    gen_access_token: true,
    currency_platforms: [1, 2, 5, 6, 8, 10, 11],
    type: 0,
    client_version_string: 'WebGL_2022-0.16.193',
    tag: 'cn'
  });
});
