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
    scheduled0605: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:05:00.000Z')
    }),
    delayed0717: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T22:17:00.000Z')
    }),
    alreadyCompleted: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-26',
      now: new Date('2026-07-25T22:17:00.000Z')
    }),
    rejectedFormerMultiSchedule: decideAttendanceRun({
      eventName: 'schedule',
      schedule: '7,17 6 * * *',
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:05:00.000Z')
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

  assert.equal(AUTOMATIC_LOGIN_SCHEDULE, '5 21 * * *');
  assert.equal(cases.scheduled0605.shouldRun, true);
  assert.equal(cases.delayed0717.shouldRun, true);
  assert.equal(cases.delayed0717.reason, 'single-scheduled-event');
  assert.equal(cases.alreadyCompleted.shouldRun, false);
  assert.equal(cases.alreadyCompleted.reason, 'already-completed');
  assert.equal(cases.rejectedFormerMultiSchedule.shouldRun, false);
  assert.equal(cases.rejectedFormerMultiSchedule.reason, 'unsupported-schedule');
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
  const loginCronLines = Array.from(
    mainWorkflow.matchAll(/cron:\s*'([^']+)'/g),
    match => match[1]
  );

  assert.deepEqual(loginCronLines, ['5 21 * * *']);
  assert.doesNotMatch(mainWorkflow, /^\s*timezone:/m);
  assert.match(mainWorkflow, /confirm_not_playing:/);
  assert.match(mainWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(mainWorkflow, /7,17 6 \* \* \*/);
  assert.doesNotMatch(safetyWorkflow, /\bschedule:/);
  assert.match(safetyWorkflow, /workflow_dispatch:/);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, '.github', 'workflows', 'attendance-early-backup.yml')),
    false
  );

  return {
    version: 3,
    verifiedAt: new Date().toISOString(),
    noLoginPerformed: true,
    automaticSchedule: {
      cron: AUTOMATIC_LOGIN_SCHEDULE,
      utc: '21:05',
      kst: '06:05',
      attemptsPerDay: 1,
      delayedRunnerStillExecutes: true
    },
    cases
  };
}

function appendSummary(report, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  const rows = Object.entries(report.cases).map(([name, value]) =>
    `| ${name} | ${value.shouldRun ? 'run' : 'blocked'} | ${value.reason} |`
  );
  fs.appendFileSync(summaryPath, [
    '## 출석 시작 경로 검증',
    '',
    '- 실제 게임 로그인: 수행하지 않음',
    '- 자동 로그인 예약: 매일 21:05 UTC = 06:05 KST, 1회',
    '- 같은 예약 이벤트는 GitHub 러너 시작이 늦어져도 취소하지 않음',
    '- 별도 자동 watchdog 예약 없음',
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
