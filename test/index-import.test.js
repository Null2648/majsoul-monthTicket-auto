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
