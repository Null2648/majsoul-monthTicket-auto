const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertBoundedJsonValue,
  assertBoundedProtocolReferences,
  isUnsafeNetworkHostname
} = require('../src/network-hardening');
const {
  readTokenCache,
  saveTokenCache,
  validateEncryptedCacheEnvelope
} = require('../src/auth-cache-hardening');
const {
  normalizeCredentialHost
} = require('../src/yostar-websdk-safe');
const {
  INSTALL_STATE,
  MAX_GATEWAY_CONNECTION_ATTEMPTS,
  assertScheduledGatewayWindow,
  consumeGatewayAttempt,
  installHardenedWebSocket,
  resetGatewayAttemptBudget,
  validateGatewayEndpoint
} = require('../src/websocket-hardening');
const {
  wrapProtocolSafetyError
} = require('../src/bootstrap');
const {
  verifyStartupPaths
} = require('../scripts/verify-startup-paths');

test('remote JSON traversal is rejected when depth or node budgets are exceeded', () => {
  const root = {};
  let cursor = root;
  for (let index = 0; index < 20; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.throws(
    () => assertBoundedJsonValue(root, { maxDepth: 8, maxNodes: 100, maxCollection: 20 }),
    /exceeds depth 8/
  );
  assert.throws(
    () => assertBoundedJsonValue(new Array(21).fill(0), {
      maxDepth: 8,
      maxNodes: 100,
      maxCollection: 20
    }),
    /collection exceeds 20/
  );
});

test('protocol message reference chains have an explicit traversal ceiling', () => {
  const nested = {};
  for (let index = 0; index < 20; index += 1) {
    nested[`Type${index}`] = {
      fields: index === 19
        ? { value: { id: 1, type: 'string' } }
        : { next: { id: 1, type: `Type${index + 1}` } }
    };
  }
  assert.throws(
    () => assertBoundedProtocolReferences({ nested: { lq: { nested } } }, 8),
    /reference chain exceeds depth 8/
  );
});

test('credential and gateway destinations reject local, reserved, and malformed endpoints', () => {
  for (const hostname of [
    'localhost', '127.0.0.1', '10.0.0.1', '100.64.0.1',
    '169.254.169.254', '192.168.0.1', '198.51.100.1', 'example.test', '::1'
  ]) {
    assert.equal(isUnsafeNetworkHostname(hostname), true, hostname);
  }
  assert.equal(isUnsafeNetworkHostname('game.mahjongsoul.com'), false);
  assert.equal(normalizeCredentialHost('https://169.254.169.254'), null);
  assert.equal(normalizeCredentialHost('https://unrelated.vendor-cdn.com'), null);
  assert.equal(
    normalizeCredentialHost('https://sdk-api.yostar.net'),
    'https://sdk-api.yostar.net'
  );
  assert.equal(
    validateGatewayEndpoint('wss://mjusgs.mahjongsoul.com/gateway'),
    'wss://mjusgs.mahjongsoul.com/gateway'
  );
  assert.throws(() => validateGatewayEndpoint('ws://mjusgs.mahjongsoul.com/gateway'), /must use wss/);
  assert.throws(() => validateGatewayEndpoint('wss://127.0.0.1/gateway'), /unsafe host/);
  assert.throws(() => validateGatewayEndpoint('wss://mjusgs.mahjongsoul.com/other'), /exact \/gateway/);
  assert.throws(() => validateGatewayEndpoint('wss://mjusgs.mahjongsoul.com/gateway?x=1'), /exact \/gateway/);
});

test('scheduled gateway authentication is rechecked at connection time and bounded', () => {
  const scheduleEnv = { GITHUB_EVENT_NAME: 'schedule' };
  assert.doesNotThrow(() => assertScheduledGatewayWindow(
    new Date('2026-07-25T21:24:59.000Z'),
    scheduleEnv
  ));
  assert.throws(
    () => assertScheduledGatewayWindow(new Date('2026-07-25T21:25:00.000Z'), scheduleEnv),
    error => error.code === 'OUTSIDE_SAFE_LOGIN_WINDOW' && error.retryable === false
  );

  resetGatewayAttemptBudget();
  const now = Date.parse('2026-07-25T21:05:00.000Z');
  for (let index = 0; index < MAX_GATEWAY_CONNECTION_ATTEMPTS; index += 1) {
    consumeGatewayAttempt({ now: now + index, env: scheduleEnv });
  }
  assert.throws(
    () => consumeGatewayAttempt({ now: now + 1000, env: scheduleEnv }),
    error => error.code === 'GATEWAY_ATTEMPT_BUDGET_EXCEEDED' && error.retryable === false
  );
  resetGatewayAttemptBudget();
});

test('encrypted authentication cache is bounded, validated, and round-trips atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'majsoul-auth-cache-'));
  const cachePath = path.join(directory, 'auth-cache.json');
  const payload = {
    uid: '12345678',
    token: 'login-token-value',
    deviceId: '00000000-0000-4000-8000-000000000000',
    webSdkMetadata: {
      hosts: ['https://sdk-api.yostar.net'],
      pid: '1',
      version: '1.2.3',
      signingSecret: 'a'.repeat(40),
      strategy: 'strict-config+strict-regex'
    },
    updatedAt: new Date().toISOString()
  };
  saveTokenCache(payload, payload.uid, 'base-token-value', cachePath);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(validateEncryptedCacheEnvelope(cache), true);
  assert.deepEqual(readTokenCache(payload.uid, 'base-token-value', cachePath), payload);
  assert.equal(readTokenCache(payload.uid, 'wrong-token', cachePath), null);
  assert.equal(
    fs.readdirSync(directory).some(name => name.endsWith('.tmp')),
    false
  );
});

test('protocol safety failures are fail-closed and non-retryable', () => {
  const cause = new Error('schema parser failed');
  const error = wrapProtocolSafetyError(cause);
  assert.equal(error.code, 'PROTOCOL_SAFETY_UNAVAILABLE');
  assert.equal(error.retryable, false);
  assert.match(error.message, /could not complete before attendance/);

  const breaking = Object.assign(new Error('breaking'), { code: 'PROTOCOL_BREAKING_CHANGE' });
  assert.equal(wrapProtocolSafetyError(breaking), breaking);
});

test('manual and single scheduled startup paths verify without performing a game login', () => {
  const report = verifyStartupPaths();
  assert.equal(report.noLoginPerformed, true);
  assert.equal(report.automaticSchedule.cron, '5 21 * * *');
  assert.equal(report.automaticSchedule.kst, '06:05');
  assert.equal(report.automaticSchedule.attemptsPerDay, 1);
  assert.equal(report.cases.scheduled0605.shouldRun, true);
  assert.equal(report.cases.delayed0625.shouldRun, false);
  assert.equal(report.cases.rejectedFormerMultiSchedule.shouldRun, false);
  assert.equal(report.cases.manualConfirmed.shouldRun, true);
  assert.equal(report.cases.manualUnconfirmed.shouldRun, false);
});

test('the ws module can be replaced without losing its public static API', () => {
  const modulePath = require.resolve('ws');
  const OriginalWebSocket = require(modulePath);
  const state = installHardenedWebSocket();
  try {
    assert.equal(require(modulePath), state.HardenedWebSocket);
    assert.equal(state.HardenedWebSocket.OPEN, OriginalWebSocket.OPEN);
    assert.throws(
      () => new state.HardenedWebSocket('ws://127.0.0.1/gateway'),
      /must use wss/
    );
  } finally {
    require.cache[modulePath].exports = OriginalWebSocket;
    delete globalThis[INSTALL_STATE];
    resetGatewayAttemptBudget();
  }
});
