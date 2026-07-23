const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAuthorization,
  createStableDeviceId,
  decryptTokenCache,
  encryptTokenCache,
  extractQuickLoginResult,
  parseJpSdkConfig,
  parseWebSdkRuntime,
  refreshYostarCredentials
} = require('../src/yostar-websdk');

test('current YoStar WebSDK runtime metadata is parsed from official script', () => {
  const script =
    'const Dt={version:"4.16.0"};GK=(e,t)=>{const n="347467131a466f6865d7f2662e38841fbe2adb23";}';

  assert.deepEqual(parseWebSdkRuntime(script), {
    version: '4.16.0',
    signingSecret: '347467131a466f6865d7f2662e38841fbe2adb23'
  });
});

test('JP SDK hosts and PID are parsed from official config', () => {
  assert.deepEqual(
    parseJpSdkConfig({
      Regions: {
        Jp: {
          Sdk_Url: 'https://primary.example',
          Sdk_Url_Lb: 'https://backup.example',
          Sdk_Pid: 'JP-MJ'
        }
      }
    }),
    {
      hosts: ['https://primary.example', 'https://backup.example'],
      pid: 'JP-MJ'
    }
  );
});

test('stable device id is a deterministic UUID v4', () => {
  const first = createStableDeviceId('123', 'secret-token');
  const second = createStableDeviceId('123', 'secret-token');

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('refreshed token cache is encrypted and recoverable only with base secret', () => {
  const payload = {
    uid: '123',
    token: 'refreshed-private-token',
    deviceId: 'device-id',
    updatedAt: '2026-07-23T00:00:00.000Z'
  };
  const encrypted = encryptTokenCache(payload, '123', 'base-secret');

  assert.doesNotMatch(JSON.stringify(encrypted), /refreshed-private-token/);
  assert.deepEqual(
    decryptTokenCache(encrypted, '123', 'base-secret'),
    payload
  );
  assert.equal(decryptTokenCache(encrypted, '123', 'wrong-secret'), null);
});

test('authorization matches the official WebSDK MD5 signing layout', () => {
  const authorization = buildAuthorization({
    uid: '123',
    token: 'token',
    deviceId: 'device',
    pid: 'JP-MJ',
    sdkVersion: '4.16.0',
    signingSecret: '347467131a466f6865d7f2662e38841fbe2adb23',
    unixTime: 1
  });

  assert.deepEqual(authorization.Head, {
    Region: 'Jp',
    PID: 'JP-MJ',
    Channel: 'web',
    Platform: 'pc',
    Version: '4.16.0',
    Lang: 'ja',
    DeviceID: 'device',
    UID: '123',
    Token: 'token',
    Time: 1
  });
  assert.equal(authorization.Sign, '6401CAABE15CDE654D37BF77AA67DC5C');
});

test('quick-login response returns the renewed game token', () => {
  assert.deepEqual(
    extractQuickLoginResult({
      Code: 200,
      Data: {
        UserInfo: {
          ID: '123',
          Token: 'renewed'
        }
      }
    }),
    { uid: '123', token: 'renewed' }
  );
});

test('quick-login preserves the official expired-token error code', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    text: async () => JSON.stringify({ Code: 100403 })
  });

  try {
    await assert.rejects(
      refreshYostarCredentials({
        gameBase: 'https://game.example/',
        uid: '123',
        token: 'expired',
        metadata: {
          hosts: ['https://sdk.example'],
          pid: 'JP-MJ',
          version: '4.16.0',
          signingSecret: '347467131a466f6865d7f2662e38841fbe2adb23'
        }
      }),
      error => error.yostarCode === 100403
    );
  } finally {
    global.fetch = originalFetch;
  }
});
