const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mergeWebSdkMetadataCandidates,
  parseJpSdkConfig,
  parseWebSdkRuntimeCandidates
} = require('../src/yostar-websdk-parser');
const {
  refreshYostarCredentials
} = require('../src/yostar-websdk');

test('strict YoStar runtime syntax remains the first strategy', () => {
  const script =
    'const Dt={version:"4.16.0"};' +
    'GK=(e,t)=>{const n="347467131a466f6865d7f2662e38841fbe2adb23";}';
  const candidates = parseWebSdkRuntimeCandidates(script);

  assert.equal(candidates[0].version, '4.16.0');
  assert.equal(
    candidates[0].signingSecret,
    '347467131a466f6865d7f2662e38841fbe2adb23'
  );
  assert.equal(candidates[0].strategy, 'strict-regex');
});

test('partial AST resolves indirect version and signing-secret bindings', () => {
  const script =
    'const sdkVersion="4.17.2";' +
    'const secret="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";' +
    'const runtime={version:sdkVersion};' +
    'function buildSign(){return MD5(JSON.stringify(Head)+' +
    'JSON.stringify(body)+secret)}';
  const candidate = parseWebSdkRuntimeCandidates(script)[0];

  assert.equal(candidate.version, '4.17.2');
  assert.equal(candidate.signingSecret, 'a'.repeat(40));
  assert.equal(candidate.strategy, 'partial-ast');
});

test('context-scored string candidates survive renamed runtime fields', () => {
  const script =
    'const release="4.18.0";' +
    'function q(){return JSON.stringify(Head)+JSON.stringify(body)+' +
    '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';
  const candidate = parseWebSdkRuntimeCandidates(script)[0];

  assert.equal(candidate.version, '4.18.0');
  assert.equal(candidate.signingSecret, 'b'.repeat(40));
});

test('alternate nested JP SDK configuration is structurally parsed', () => {
  assert.deepEqual(
    parseJpSdkConfig({
      regions: {
        japan: {
          apiEndpoint: 'https://sdk.example/',
          backupServer: 'https://backup.example',
          productId: 'JP-MJ'
        }
      }
    }),
    {
      hosts: ['https://sdk.example', 'https://backup.example'],
      pid: 'JP-MJ'
    }
  );
});

test('previous cached metadata remains the first validation candidate', () => {
  const candidates = mergeWebSdkMetadataCandidates({
    cachedMetadata: {
      hosts: ['https://cached.example'],
      pid: 'JP-MJ',
      version: '4.15.0',
      signingSecret: 'c'.repeat(40)
    },
    configCandidates: [{
      hosts: ['https://live.example'],
      pid: 'JP-MJ',
      strategy: 'structural-config',
      confidence: 100
    }],
    runtimeCandidates: [{
      version: '4.16.0',
      signingSecret: 'd'.repeat(40),
      strategy: 'partial-ast',
      confidence: 100
    }]
  });

  assert.equal(candidates[0].strategy, 'cached');
  assert.equal(candidates[1].version, '4.16.0');
});

test('quick-login advances to the next parsed metadata candidate', async () => {
  const originalFetch = global.fetch;
  let quickLoginAttempts = 0;
  const config = {
    Regions: {
      Jp: {
        Sdk_Url: 'https://sdk.example',
        Sdk_Pid: 'JP-MJ'
      }
    }
  };
  const script =
    'const sdkVersion="4.17.0";' +
    'const backupVersion="4.16.0";' +
    'const primarySecret="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";' +
    'function buildSign(){return MD5(JSON.stringify(Head)+' +
    'JSON.stringify(body)+primarySecret)}' +
    'const backupSecret="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";';

  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/config.json')) {
      return { ok: true, text: async () => JSON.stringify(config) };
    }
    if (value.endsWith('/index.js.txt')) {
      return { ok: true, text: async () => script };
    }

    quickLoginAttempts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(
        quickLoginAttempts === 1
          ? { Code: 100001, Message: 'candidate rejected' }
          : {
              Code: 200,
              Data: {
                UserInfo: {
                  ID: '123',
                  Token: 'quick-login-cache-token'
                }
              }
            }
      )
    };
  };

  try {
    const refreshed = await refreshYostarCredentials({
      gameBase: 'https://game.example/',
      uid: '123',
      token: 'official-login-token',
      deviceId: 'device-id'
    });

    assert.equal(quickLoginAttempts, 2);
    assert.equal(refreshed.uid, '123');
    assert.equal(refreshed.token, 'official-login-token');
    assert.notEqual(refreshed.metadata.strategy, 'cached');
  } finally {
    global.fetch = originalFetch;
  }
});
