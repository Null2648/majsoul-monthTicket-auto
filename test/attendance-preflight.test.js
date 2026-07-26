const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  inspectAttendanceConfiguration,
  run
} = require('../scripts/preflight-attendance');
const {
  buildReport
} = require('../scripts/write-attendance-run-report');

test('JP preflight accepts access token or complete UID/TOKEN pairs', () => {
  assert.equal(
    inspectAttendanceConfiguration({ MS_SERVER: 'jp', MAJSOUL_ACCESS_TOKEN: 'access-123456' }).credentialMode,
    'access-token'
  );
  const uidToken = inspectAttendanceConfiguration({
    MS_SERVER: 'jp',
    MAJSOUL_UID: '12345678',
    MAJSOUL_TOKEN: 'login-token-123456',
    MAJSOUL_YOSTAR_DEVICE_ID: 'device-123456'
  });
  assert.equal(uidToken.credentialMode, 'uid-token');
  assert.equal(uidToken.hasDeviceId, true);
});

test('preflight rejects partial, missing, placeholder, and invalid server settings', () => {
  assert.throws(
    () => inspectAttendanceConfiguration({ MS_SERVER: 'jp', MAJSOUL_UID: '12345678' }),
    /UID and TOKEN must either both/
  );
  assert.throws(
    () => inspectAttendanceConfiguration({ MS_SERVER: 'en' }),
    /Set ACCESS_TOKEN/
  );
  assert.throws(
    () => inspectAttendanceConfiguration({ MS_SERVER: 'cn', MAJSOUL_EMAIL: 'a@example.com' }),
    /Set both EMAIL and PASSWORD/
  );
  assert.throws(
    () => inspectAttendanceConfiguration({ MS_SERVER: 'jp', MAJSOUL_ACCESS_TOKEN: 'undefined' }),
    /placeholder/
  );
  assert.throws(
    () => inspectAttendanceConfiguration({ MS_SERVER: 'xx', MAJSOUL_ACCESS_TOKEN: 'token-123456' }),
    /MS_SERVER must be one of/
  );
});

test('preflight failure writes a sanitized structured report', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-preflight-'));
  const failureReportPath = path.join(directory, 'automation-failure-report.json');
  assert.throws(
    () => run(
      { MS_SERVER: 'jp', MAJSOUL_UID: 'private-user-id' },
      { failureReportPath }
    ),
    /UID and TOKEN/
  );
  const report = JSON.parse(fs.readFileSync(failureReportPath, 'utf8'));
  assert.equal(report.stage, 'preflight');
  assert.equal(report.classification, 'configuration');
  assert.doesNotMatch(JSON.stringify(report), /private-user-id/);
});

test('run report contains only execution metadata and normalized outcomes', () => {
  const report = buildReport({
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '168',
    JOB_STATUS: 'failure',
    SHOULD_RUN: 'true',
    DECISION_REASON: 'manual-force',
    ATTENDANCE_STAGE: 'manual',
    PREFLIGHT_OUTCOME: 'success',
    INSTALL_OUTCOME: 'success',
    AUTOMATION_OUTCOME: 'failure',
    CACHE_OUTCOME: 'skipped'
  }, new Date('2026-07-26T01:00:00Z'));
  assert.equal(report.ref, 'refs/heads/main');
  assert.equal(report.decision.shouldRun, true);
  assert.equal(report.outcomes.automation, 'failure');
  assert.equal(report.outcomes.cache, 'skipped');
});
