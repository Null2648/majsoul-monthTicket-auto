const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AUTOMATIC_LOGIN_SCHEDULE,
  decideAttendanceRun
} = require('../src/attendance-schedule');

const REPORT_PATH = path.join(process.cwd(), 'startup-verification-report.json');

function verifyStartupPaths({ repositoryRoot = process.cwd() } = {}) {
  const cases = {
    scheduled0607: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:07:00.000Z')
    }),
    scheduled0617: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:17:00.000Z')
    }),
    delayed0625: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:25:00.000Z')
    }),
    alreadyCompleted: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-26',
      now: new Date('2026-07-25T21:17:00.000Z')
    }),
    manualConfirmed: decideAttendanceRun({
      eventName: 'workflow_dispatch',
      source: 'manual',
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T23:00:00.000Z'),
      confirmSafeLogin: true,
      force: false
    }),
    manualUnconfirmed: decideAttendanceRun({
      eventName: 'workflow_dispatch',
      source: 'manual',
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T23:00:00.000Z'),
      confirmSafeLogin: false,
      force: false
    })
  };

  assert.equal(cases.scheduled0607.shouldRun, true);
  assert.equal(cases.scheduled0617.shouldRun, true);
  assert.equal(cases.delayed0625.shouldRun, false);
  assert.equal(cases.delayed0625.reason, 'outside-safe-login-window');
  assert.equal(cases.alreadyCompleted.shouldRun, false);
  assert.equal(cases.alreadyCompleted.reason, 'already-completed');
  assert.equal(cases.manualConfirmed.shouldRun, true);
  assert.equal(cases.manualUnconfirmed.shouldRun, false);
  assert.equal(cases.manualUnconfirmed.reason, 'manual-safety-confirmation-required');

  const mainWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'main.yml'),
    'utf8'
  );
  const safetyWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'attendance-watchdog.yml'),
    'utf8'
  );
  assert.match(mainWorkflow, /cron: '7,17 6 \* \* \*'/);
  assert.match(mainWorkflow, /confirm_not_playing:/);
  assert.match(mainWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(mainWorkflow, /cron: '[^' ]+ (?:7|8|9|10|11|12|13)(?:[ ,*\/-]|')/);
  assert.match(safetyWorkflow, /Check success marker without logging in/);
  assert.doesNotMatch(safetyWorkflow, /actions: write/);
  assert.doesNotMatch(safetyWorkflow, /dispatches/);

  return {
    version: 1,
    verifiedAt: new Date().toISOString(),
    noLoginPerformed: true,
    cases
  };
}

function appendSummary(report, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  const rows = Object.entries(report.cases).map(([name, value]) =>
    `| ${name} | ${value.shouldRun ? 'run' : 'blocked'} | ${value.reason} |`
  );
  fs.appendFileSync(summaryPath, [
    '## 출석 시작 경로 안전 검증',
    '',
    '- 실제 게임 로그인: 수행하지 않음',
    '- 수동 확인 경로와 자동 예약 시간 경계를 코드 및 워크플로 정의로 검증함',
    '',
    '| 사례 | 판정 | 이유 |',
    '|---|---|---|',
    ...rows,
    ''
  ].join('\n'), 'utf8');
}

function run() {
  const report = verifyStartupPaths();
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  appendSummary(report);
  console.log(`startup path verification -> ${REPORT_PATH}`);
  return report;
}

if (require.main === module) run();

module.exports = {
  REPORT_PATH,
  appendSummary,
  run,
  verifyStartupPaths
};