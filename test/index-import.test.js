const assert = require('node:assert/strict');
const test = require('node:test');

test('src/index can be imported without starting the automation', () => {
  const index = require('../src/index');

  assert.equal(typeof index.createSession, 'function');
  assert.equal(typeof index.loadRuntimeConfig, 'function');
  assert.equal(typeof index.loadServerContext, 'function');
  assert.equal(typeof index.runActions, 'function');
});

test('Majsoul oauth error 151 remains a typed RPC error without guessing its cause', () => {
  const {
    isVersionStringError,
    MajsoulRpcError,
    requireRpcSuccess
  } = require('../src/index');
  const response = { error: { code: 151 } };

  assert.throws(
    () => requireRpcSuccess('oauth2Auth', response),
    error => error instanceof MajsoulRpcError && error.rpcCode === 151
  );

  try {
    requireRpcSuccess('oauth2Auth', response);
  } catch (error) {
    assert.equal(isVersionStringError(error), false);
    assert.doesNotMatch(error.message, /token was rejected|repository secret ACCESS_TOKEN/);
  }
});

test('an unusable configured access token falls back to existing UID/TOKEN credentials', () => {
  const { shouldRetryWithOauthCode } = require('../src/index');
  const credentials = { uid: 'uid-value', token: 'login-token-value' };

  assert.equal(
    shouldRetryWithOauthCode({ error: { code: 151 } }, credentials),
    true
  );
  assert.equal(
    shouldRetryWithOauthCode({ has_account: false }, credentials),
    true
  );
  assert.equal(
    shouldRetryWithOauthCode({ has_account: true }, credentials),
    false
  );
  assert.equal(
    shouldRetryWithOauthCode({ error: { code: 151 } }, { token: 'only-token' }),
    false
  );
});

test('explicit client version errors are treated as version mismatches', () => {
  const { isVersionStringError, requireRpcSuccess } = require('../src/index');

  try {
    requireRpcSuccess('oauth2Auth', { error: { code: 103 } });
  } catch (error) {
    assert.equal(isVersionStringError(error), false);
  }

  assert.equal(
    isVersionStringError(new Error('invalid client_version_string')),
    true
  );
});

test('oauth2Auth code 151 can trigger bounded client version recovery', () => {
  const {
    isClientVersionProbeError,
    requireRpcSuccess
  } = require('../src/index');

  let authError;
  let checkError;

  try {
    requireRpcSuccess('oauth2Auth', { error: { code: 151 } });
  } catch (error) {
    authError = error;
  }

  try {
    requireRpcSuccess('oauth2Check', { error: { code: 151 } });
  } catch (error) {
    checkError = error;
  }

  assert.equal(isClientVersionProbeError(authError), true);
  assert.equal(isClientVersionProbeError(checkError), false);
});

test('exhausted metadata candidates are marked as non-retryable', async () => {
  const { createSession } = require('../src/index');
  const context = {
    server: { key: 'jp' },
    clientVersionStringCandidates: []
  };

  await assert.rejects(
    createSession(context, {}),
    error =>
      error.retryable === false &&
      /All supported client metadata candidates were rejected/.test(error.message)
  );
});

test('a metadata update keeps bounded Unity resource recovery candidates', () => {
  const { getClientVersionStringCandidates } = require('../src/index');
  const previousResourceVersion = process.env.MS_RESOURCE_VERSION;

  process.env.MS_RESOURCE_VERSION = '0.16.260';

  try {
    const candidates = getClientVersionStringCandidates({
      serverKey: 'jp-test-recovery',
      detectedClientVersionStrings: ['WebGL_2022-4.0.11'],
      webResourceVersion: '0.11.252.w',
      productVersion: '4.0.11',
      buildId: 'jp-WebGL-release-4.0.11(12)'
    });

    assert.deepEqual(candidates.slice(0, 6), [
      'WebGL_2022-4.0.11',
      'web-0.11.252',
      'WebGL_2022-0.16.260',
      'WebGL_2022-0.16.261',
      'WebGL_2022-0.16.262',
      'WebGL_2022-0.16.263'
    ]);
    assert.ok(candidates.length > 96);
  } finally {
    if (previousResourceVersion === undefined) {
      delete process.env.MS_RESOURCE_VERSION;
    } else {
      process.env.MS_RESOURCE_VERSION = previousResourceVersion;
    }
  }
});

test('YoStar refresh is limited to JP authentication rejection with base secrets', () => {
  const { shouldRefreshYostarCredentials } = require('../src/index');
  const error = { yostarAuthRejected: true };
  const credentials = {
    uid: 'uid',
    token: 'active-token',
    baseUid: 'uid',
    baseToken: 'base-token',
    server: { key: 'jp' }
  };

  assert.equal(shouldRefreshYostarCredentials(error, credentials), true);
  assert.equal(
    shouldRefreshYostarCredentials(error, {
      ...credentials,
      server: { key: 'en' }
    }),
    false
  );
  assert.equal(
    shouldRefreshYostarCredentials({}, credentials),
    false
  );
});

test('official YoStar account token is tried before quick-login cache token', () => {
  const { buildYostarCredentialCandidates } = require('../src/index');
  const credentials = {
    uid: '123',
    token: 'configured-token',
    accessToken: 'stale-access-token',
    server: { key: 'jp' }
  };

  const candidates = buildYostarCredentialCandidates(credentials, {
    uid: '123',
    token: 'configured-token',
    responseUid: '123',
    responseToken: 'quick-login-cache-token'
  });

  assert.deepEqual(
    candidates.map(candidate => ({
      uid: candidate.uid,
      token: candidate.token,
      accessToken: candidate.accessToken
    })),
    [
      {
        uid: '123',
        token: 'configured-token',
        accessToken: null
      },
      {
        uid: '123',
        token: 'quick-login-cache-token',
        accessToken: null
      }
    ]
  );
});

test('copied credential labels, quotes, and surrounding whitespace are removed', () => {
  const { normalizeSecretCredential } = require('../src/index');

  assert.equal(
    normalizeSecretCredential(' UID: 12345\nTOKEN: abc ', 'UID'),
    '12345'
  );
  assert.equal(
    normalizeSecretCredential('UID: 12345\nTOKEN: abc', 'TOKEN'),
    'abc'
  );
  assert.equal(
    normalizeSecretCredential('  "abc-token"  ', 'TOKEN'),
    'abc-token'
  );
  assert.equal(normalizeSecretCredential('   ', 'TOKEN'), undefined);
});
