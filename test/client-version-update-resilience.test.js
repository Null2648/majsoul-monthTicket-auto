const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MajsoulRpcError,
  buildClientAuthenticationAttempts,
  isClientVersionProbeError,
  isConnectionQueueError
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
