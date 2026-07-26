const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PRIMARY_SCHEDULE,
  buildFailureBody,
  classifyAutomationError,
  describeSchedule,
  readJsonFile,
  sanitizeText,
  shouldNotifyFailure,
  writeAutomationFailureReport
} = require('../src/automation-alert');

test('configuration and structural failures are classified for immediate notification', () => {
  assert.equal(
    classifyAutomationError(new Error('UID and TOKEN must either both be configured or both be omitted.')),
    'configuration'
  );
  assert.equal(
    classifyAutomationError(Object.assign(new Error('Protocol field lq.ReqLogin.tag is missing'), {
      code: 'PROTOCOL_BREAKING_CHANGE'
    })),
    'protocol-breaking'
  );
  assert.equal(
    classifyAutomationError(new Error('Unable to discover Unity productVersion from official metadata sources')),
    'official-metadata'
  );
  assert.equal(
    classifyAutomationError(new Error('Unable to read the current YoStar WebSDK signing metadata')),
    'yostar-metadata'
  );
});

test('safe-window transient failures defer to the non-login watchdog', () => {
  assert.equal(
    shouldNotifyFailure({
      eventName: 'schedule',
      schedule: PRIMARY_SCHEDULE,
      stage: 'safe-morning-window',
      classification: 'network-or-gateway'
    }),
    false
  );
  for (const classification of ['configuration', 'official-metadata']) {
    assert.equal(
      shouldNotifyFailure({
        eventName: 'schedule',
        schedule: PRIMARY_SCHEDULE,
        stage: 'safe-morning-window',
        classification
      }),
      true
    );
  }
  assert.equal(
    shouldNotifyFailure({
      eventName: 'workflow_dispatch',
      schedule: '',
      classification: 'runtime'
    }),
    true
  );
  assert.match(describeSchedule(PRIMARY_SCHEDULE, 'safe-morning-window'), /06:07·06:17/);
  assert.match(describeSchedule('', 'safety-watchdog'), /로그인 없음/);
});

test('failure reports redact legacy and namespaced credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'majsoul-alert-'));
  const reportPath = path.join(directory, 'failure.json');
  const env = {
    MAJSOUL_TOKEN: 'private-login-token',
    MAJSOUL_ACCESS_TOKEN: 'private-access-token',
    MAJSOUL_UID: '12345678',
    MAJSOUL_EMAIL: 'owner@example.com'
  };

  writeAutomationFailureReport(
    new Error(
      'login failed token=private-login-token access_token=private-access-token ' +
      'uid 12345678 for owner@example.com'
    ),
    { filePath: reportPath, env }
  );

  const serialized = JSON.stringify(readJsonFile(reportPath));
  assert.doesNotMatch(serialized, /private-login-token/);
  assert.doesNotMatch(serialized, /private-access-token/);
  assert.doesNotMatch(serialized, /12345678/);
  assert.doesNotMatch(serialized, /owner@example\.com/);
  assert.match(serialized, /REDACTED/);
});

test('issue body explains that late automatic login is intentionally blocked', () => {
  const body = buildFailureBody({
    classification: 'configuration',
    summary: sanitizeText('UID and TOKEN must either both be configured or both be omitted.'),
    eventName: 'schedule',
    schedule: PRIMARY_SCHEDULE,
    stage: 'safe-morning-window',
    runUrl: 'https://github.com/example/repo/actions/runs/1',
    sha: '1234567890abcdef',
    lastSuccess: '2026-07-25',
    outcomes: {
      preflight: 'failure',
      install: 'skipped',
      automation: 'skipped',
      cache: 'skipped'
    },
    occurredAt: new Date('2026-07-25T21:17:00.000Z')
  });

  assert.match(body, /06:07·06:17/);
  assert.match(body, /06:25 이후 자동 로그인은 수행하지 않습니다/);
  assert.match(body, /설정 사전검사/);
  assert.match(body, /UID and TOKEN/);
  assert.match(body, /GitHub Actions 실행 열기/);
});
