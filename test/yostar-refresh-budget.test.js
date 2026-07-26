const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_HOSTS_PER_CANDIDATE,
  MAX_OFFICIAL_CANDIDATES,
  QUICK_LOGIN_TIMEOUT_MS,
  RECENT_FAILURE_TTL_MS,
  REFRESH_BUDGET_MS,
  getRecentRefreshFailure,
  hardenWebSdkMetadataCandidates,
  refreshAttemptKey,
  rememberRefreshFailure,
  strategyRank,
  tryCandidate
} = require('../src/yostar-websdk-hardened');

function candidate(strategy, version, hosts = ['https://sdk-api.yostar.net']) {
  return {
    strategy,
    version,
    pid: 'mahjongsoul',
    signingSecret: `${version}`.padEnd(40, 'a'),
    hosts
  };
}

test('official candidates are ranked, deduplicated, and bounded', () => {
  const candidates = hardenWebSdkMetadataCandidates([
    candidate('structural-config+partial-ast', '4.0.6'),
    candidate('strict-config+partial-ast', '4.0.2'),
    candidate('strict-config+strict-regex', '4.0.1'),
    candidate('structural-config+strict-regex', '4.0.3'),
    candidate('unknown', '4.0.5'),
    candidate('strict-config+strict-regex', '4.0.1'),
    candidate('strict-config+strict-regex', '4.0.4', [
      'https://one.yostar.net',
      'https://two.yostar.net',
      'https://three.yostar.net'
    ])
  ], { limit: MAX_OFFICIAL_CANDIDATES });

  assert.equal(candidates.length, MAX_OFFICIAL_CANDIDATES);
  assert.equal(candidates[0].strategy, 'strict-config+strict-regex');
  assert.equal(candidates[1].strategy, 'strict-config+strict-regex');
  assert.equal(candidates[1].hosts.length, MAX_HOSTS_PER_CANDIDATE);
  assert.ok(strategyRank(candidates[0].strategy) <= strategyRank(candidates.at(-1).strategy));
});

test('one candidate performs at most one request per bounded host', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      Code: 200,
      Data: { UserInfo: { ID: '1234', Token: 'quick-token' } }
    }), { status: 200 });
  };
  try {
    const result = await tryCandidate({
      uid: '1234',
      token: 'login-token',
      deviceId: 'device-id'
    }, candidate('strict-config+strict-regex', '4.16.0', [
      'https://one.yostar.net',
      'https://two.yostar.net',
      'https://three.yostar.net'
    ]), Date.now() + 10000);
    assert.equal(result.uid, '1234');
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = previousFetch;
  }
});

test('failed candidate cannot exceed two host requests', async () => {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('network unavailable');
  };
  try {
    await assert.rejects(
      () => tryCandidate({
        uid: '1234',
        token: 'login-token',
        deviceId: 'device-id'
      }, candidate('strict-config+strict-regex', '4.16.0', [
        'https://one.yostar.net',
        'https://two.yostar.net',
        'https://three.yostar.net'
      ]), Date.now() + 10000),
      /candidate failed/
    );
    assert.equal(calls, MAX_HOSTS_PER_CANDIDATE);
  } finally {
    global.fetch = previousFetch;
  }
});

test('recent official failure suppresses the immediate duplicate refresh loop', () => {
  const options = {
    gameBase: 'https://game.mahjongsoul.com/',
    uid: '1234',
    token: 'login-token',
    deviceId: 'device-id'
  };
  const key = refreshAttemptKey(options);
  const error = rememberRefreshFailure(key, new Error('official candidates exhausted'), 1000);
  assert.equal(error.officialMetadataAttempted, true);
  assert.equal(getRecentRefreshFailure(key, 1001), error);
  assert.equal(getRecentRefreshFailure(key, 1000 + RECENT_FAILURE_TTL_MS + 1), null);
});

test('refresh limits stay well below the attendance job timeout', () => {
  assert.equal(MAX_OFFICIAL_CANDIDATES, 4);
  assert.equal(MAX_HOSTS_PER_CANDIDATE, 2);
  assert.ok(QUICK_LOGIN_TIMEOUT_MS <= 8000);
  assert.ok(REFRESH_BUDGET_MS <= 60000);
});
