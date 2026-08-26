const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AUTOMATIC_LOGIN_SCHEDULE,
  MORNING_RETRY_SCHEDULE,
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
    delayedPrimary0717: decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T22:17:00.000Z')
    }),
    scheduled0635Fallback: decideAttendanceRun({
      eventName: 'schedule',
      schedule: MORNING_RETRY_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:35:00.000Z')
    }),
    fallbackAfterPrimarySuccess: decideAttendanceRun({
      eventName: 'schedule',
      schedule: MORNING_RETRY_SCHEDULE,
      lastSuccess: '2026-07-26',
      now: new Date('2026-07-25T21:35:00.000Z')
    }),
    alreadyCompletedPrimary: decideAttendanceRun({
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
  assert.equal(MORNING_RETRY_SCHEDULE, '35 21 * * *');
  assert.equal(cases.scheduled0605.shouldRun, true);
  assert.equal(cases.scheduled0605.reason, 'primary-scheduled-event');
  assert.equal(cases.delayedPrimary0717.shouldRun, true);
  assert.equal(cases.delayedPrimary0717.reason, 'primary-scheduled-event');
  assert.equal(cases.scheduled0635Fallback.shouldRun, true);
  assert.equal(cases.scheduled0635Fallback.reason, 'fallback-scheduled-event');
  assert.equal(cases.fallbackAfterPrimarySuccess.shouldRun, false);
  assert.equal(cases.fallbackAfterPrimarySuccess.reason, 'already-completed');
  assert.equal(cases.alreadyCompletedPrimary.shouldRun, false);
  assert.equal(cases.alreadyCompletedPrimary.reason, 'already-completed');
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

  assert.deepEqual(loginCronLines, ['5 21 * * *', '35 21 * * *']);
  assert.doesNotMatch(mainWorkflow, /^\s*timezone:/m);
  assert.match(mainWorkflow, /confirm_not_playing:/);
  assert.match(mainWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(mainWorkflow, /group: majsoul-attendance/);
  assert.match(mainWorkflow, /cancel-in-progress: false/);
  assert.doesNotMatch(mainWorkflow, /7,17 6 \* \* \*/);
  assert.doesNotMatch(safetyWorkflow, /\bschedule:/);
  assert.match(safetyWorkflow, /workflow_dispatch:/);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, '.github', 'workflows', 'attendance-early-backup.yml')),
    false
  );

  return {
    version: 4,
    verifiedAt: new Date().toISOString(),
    noLoginPerformed: true,
    automaticSchedules: {
      primary: {
        cron: AUTOMATIC_LOGIN_SCHEDULE,
        utc: '21:05',
        kst: '06:05'
      },
      fallback: {
        cron: MORNING_RETRY_SCHEDULE,
        utc: '21:35',
        kst: '06:35',
        skippedAfterPrimarySuccess: true
      },
      scheduledEventsPerDay: 2,
      successfulLoginTargetPerDay: 1,
      delayedRunnerStillExecutes: true,
      serializedByConcurrency: true
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
    '- 1차 예약: 매일 21:05 UTC = 06:05 KST',
    '- 백업 예약: 매일 21:35 UTC = 06:35 KST',
    '- 1차가 성공하면 백업은 당일 성공 마커를 확인하고 로그인 전에 종료',
    '- 두 예약이 모두 지연돼도 attendance concurrency로 직렬화',
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
