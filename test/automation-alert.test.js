const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FALLBACK_SCHEDULE,
  PRIMARY_SCHEDULE,
  buildFailureBody,
  classifyAutomationError,
  readJsonFile,
  sanitizeText,
  shouldNotifyFailure,
  writeAutomationFailureReport
} = require('../src/automation-alert');

test('structural failures are classified for immediate notification', () => {
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

test('morning transient failures wait for later retries, while structural failures notify immediately', () => {
  assert.equal(
    shouldNotifyFailure({
      eventName: 'schedule',
      schedule: PRIMARY_SCHEDULE,
      classification: 'network-or-gateway'
    }),
    false
  );
  assert.equal(
    shouldNotifyFailure({
      eventName: 'schedule',
      schedule: PRIMARY_SCHEDULE,
      classification: 'official-metadata'
    }),
    true
  );
  assert.equal(
    shouldNotifyFailure({
      eventName: 'schedule',
      schedule: FALLBACK_SCHEDULE,
      classification: 'network-or-gateway'
    }),
    true
  );
  assert.equal(
    shouldNotifyFailure({
      eventName: 'workflow_dispatch',
      schedule: '',
      classification: 'runtime'
    }),
    true
  );
});

test('failure reports redact configured credentials and email addresses', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'majsoul-alert-'));
  const reportPath = path.join(directory, 'failure.json');
  const env = {
    TOKEN: 'private-login-token',
    ACCESS_TOKEN: 'private-access-token',
    UID: '12345678',
    EMAIL: 'owner@example.com'
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

test('issue body contains actionable final recovery status without raw secrets', () => {
  const body = buildFailureBody({
    classification: 'protocol-breaking',
    summary: sanitizeText('token=secret-value protocol changed', {
      env: { TOKEN: 'secret-value' }
    }),
    protocolBreaking: ['Protocol method lq.Lobby.payMonthTicket is missing'],
    eventName: 'schedule',
    schedule: FALLBACK_SCHEDULE,
    stage: 'final-recovery',
    runUrl: 'https://github.com/example/repo/actions/runs/1',
    sha: '1234567890abcdef',
    lastSuccess: '2026-07-25',
    outcomes: {
      tests: 'success',
      automation: 'failure',
      cache: 'skipped'
    },
    occurredAt: new Date('2026-07-26T03:13:00.000Z')
  });

  assert.match(body, /12:13 최종 복구 실행/);
  assert.match(body, /payMonthTicket/);
  assert.match(body, /GitHub Actions 실행 열기/);
  assert.doesNotMatch(body, /secret-value/);
});
