const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MajsoulRpcError,
  buildClientAuthenticationAttempts,
  isClientVersionProbeError,
  isConnectionQueueError,
  shouldForceClientVersionRefresh
} = require('../src/index');
const {
  mergeDiscoveredClientVersionStrings
} = require('../src/official-client-version');

test('ERR_CLIENT_VERSION is treated as a version probe even when the numeric code changes', () => {
  for (const code of [150, 151, 451]) {
    const error = new MajsoulRpcError('oauth2Auth', {
      error: { code, level: 2, message: 'ERR_CLIENT_VERSION' }
    });
    assert.equal(isClientVersionProbeError(error), true, `code ${code}`);
    assert.equal(isConnectionQueueError(error), false, `code ${code}`);
  }
});

test('version rejection is also detected if it moves from oauth2Auth to oauth2Login', () => {
  const error = new MajsoulRpcError('oauth2Login', {
    error: { code: 451, level: 2, message: 'client_version_string rejected' }
  });
  assert.equal(isClientVersionProbeError(error), true);
});

test('non-version code 151 retains the connection retry path', () => {
  const error = new MajsoulRpcError('oauth2Auth', {
    error: { code: 151, level: 2, message: 'ERR_CONNECTION_QUEUE' }
  });
  assert.equal(isClientVersionProbeError(error), false);
  assert.equal(isConnectionQueueError(error), true);
});

test('current Unity metadata is prioritized ahead of JavaScript resource hints on an update', () => {
  const merged = mergeDiscoveredClientVersionStrings(
    { detectedClientVersionStrings: ['WebGL_2022-4.0.12'] },
    ['web-0.11.252']
  );
  assert.deepEqual(merged.detectedClientVersionStrings, [
    'WebGL_2022-4.0.12',
    'web-0.11.252'
  ]);
});

test('client recovery advances through candidate strings instead of repeating the first one', () => {
  const attempts = buildClientAuthenticationAttempts(
    ['web-0.11.252', 'WebGL_2022-4.0.12'],
    [{ uid: 'u', token: 't' }],
    8
  );
  assert.deepEqual(
    attempts.map(attempt => attempt.clientVersionString),
    ['web-0.11.252', 'WebGL_2022-4.0.12']
  );
});

test('exhausted version candidates trigger one forced official refresh only', () => {
  const error = Object.assign(new Error('all client versions rejected'), {
    code: 'CLIENT_VERSION_CANDIDATES_EXHAUSTED',
    clientVersionCandidatesExhausted: true
  });
  assert.equal(shouldForceClientVersionRefresh(error, false), true);
  assert.equal(shouldForceClientVersionRefresh(error, true), false);
  assert.equal(shouldForceClientVersionRefresh(new Error('network error'), false), false);
});
