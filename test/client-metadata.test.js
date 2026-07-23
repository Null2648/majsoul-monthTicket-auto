const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_RESOURCE_VERSION,
  buildClientMetadata,
  buildResourceVersionCandidates,
  buildPasswordLoginPayload,
  buildOauth2AuthPayload,
  buildOauth2LoginPayload,
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
