const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  AUTOMATIC_LOGIN_SCHEDULE,
  WATCHDOG_SCHEDULE,
  decideAttendanceRun,
  formatKstDate,
  scheduleStage
} = require('../src/attendance-schedule');
const {
  buildMissingSummary,
  checkAttendanceStatus
} = require('../scripts/check-attendance-watchdog');

const repoPath = (...parts) => path.join(process.cwd(), ...parts);

test('KST date calculation is independent from runner timezone', () => {
  assert.equal(formatKstDate(new Date('2026-07-25T14:59:59.000Z')), '2026-07-25');
  assert.equal(formatKstDate(new Date('2026-07-25T15:00:00.000Z')), '2026-07-26');
});

test('the single 06:05 event still runs when its runner starts late', () => {
  assert.equal(AUTOMATIC_LOGIN_SCHEDULE, '5 21 * * *');
  for (const timestamp of [
    '2026-07-25T21:05:00.000Z',
    '2026-07-25T21:25:00.000Z',
    '2026-07-25T22:17:00.000Z'
  ]) {
    const result = decideAttendanceRun({
      eventName: 'schedule',
      schedule: AUTOMATIC_LOGIN_SCHEDULE,
      lastSuccess: '2026-07-25',
      now: new Date(timestamp)
    });
    assert.equal(result.shouldRun, true, timestamp);
    assert.equal(result.reason, 'single-scheduled-event', timestamp);
    assert.equal(result.stage, 'single-daily-schedule', timestamp);
  }
});

test('other schedule definitions are rejected', () => {
  for (const schedule of ['7,17 6 * * *', '47,57 5 * * *', '13 12 * * *']) {
    const result = decideAttendanceRun({
      eventName: 'schedule',
      schedule,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:05:00.000Z')
    });
    assert.equal(result.shouldRun, false, schedule);
    assert.equal(result.reason, 'unsupported-schedule', schedule);
  }
});

test('successful marker suppresses the daily event before login work begins', () => {
  const result = decideAttendanceRun({
    eventName: 'schedule',
    schedule: AUTOMATIC_LOGIN_SCHEDULE,
    lastSuccess: '2026-07-26\n',
    now: new Date('2026-07-25T22:17:00.000Z')
  });
  assert.equal(result.shouldRun, false);
  assert.equal(result.reason, 'already-completed');
});

test('manual login requires explicit confirmation that the game is not active', () => {
  const blocked = decideAttendanceRun({
    eventName: 'workflow_dispatch',
    source: 'manual',
    lastSuccess: '2026-07-25',
    now: new Date('2026-07-25T23:00:00.000Z'),
    force: true,
    confirmSafeLogin: false
  });
  assert.equal(blocked.shouldRun, false);
  assert.equal(blocked.reason, 'manual-safety-confirmation-required');

  const confirmed = decideAttendanceRun({
    eventName: 'workflow_dispatch',
    source: 'manual',
    lastSuccess: '2026-07-26',
    now: new Date('2026-07-25T23:00:00.000Z'),
    force: true,
    confirmSafeLogin: true
  });
  assert.equal(confirmed.shouldRun, true);
  assert.equal(confirmed.reason, 'manual-force-confirmed');
});

test('manual status check never performs a login', () => {
  const completed = checkAttendanceStatus({
    lastSuccess: '2026-07-26',
    now: new Date('2026-07-25T21:50:00.000Z')
  });
  assert.equal(completed.completed, true);

  const missing = checkAttendanceStatus({
    lastSuccess: '2026-07-25',
    now: new Date('2026-07-25T21:50:00.000Z')
  });
  assert.equal(missing.completed, false);
  assert.match(buildMissingSummary(missing), /게임에서 로그아웃한 상태/);
  assert.equal(scheduleStage(WATCHDOG_SCHEDULE), 'safety-watchdog');
});

test('only the login workflow has one scheduled cron', () => {
  const main = fs.readFileSync(repoPath('.github', 'workflows', 'main.yml'), 'utf8');
  const watchdog = fs.readFileSync(repoPath('.github', 'workflows', 'attendance-watchdog.yml'), 'utf8');
  const loginCrons = Array.from(main.matchAll(/cron:\s*'([^']+)'/g), match => match[1]);
  assert.deepEqual(loginCrons, ['5 21 * * *']);
  assert.doesNotMatch(watchdog, /\bschedule:/);
  assert.match(watchdog, /workflow_dispatch:/);
  assert.match(main, /confirm_not_playing:/);
  assert.match(main, /npm ci --omit=dev --ignore-scripts/);
  assert.equal(fs.existsSync(repoPath('.github', 'workflows', 'attendance-early-backup.yml')), false);
});
