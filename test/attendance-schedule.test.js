const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  AUTOMATIC_LOGIN_SCHEDULE,
  WATCHDOG_SCHEDULE,
  decideAttendanceRun,
  formatKstDate,
  isWithinAutomaticLoginWindow,
  scheduleStage
} = require('../src/attendance-schedule');
const {
  buildMissingSummary,
  checkAttendanceStatus
} = require('../scripts/check-attendance-watchdog');

const repoPath = (...parts) => path.join(process.cwd(), ...parts);

test('KST date and safe-window calculation are independent from runner timezone', () => {
  assert.equal(formatKstDate(new Date('2026-07-25T14:59:59.000Z')), '2026-07-25');
  assert.equal(formatKstDate(new Date('2026-07-25T15:00:00.000Z')), '2026-07-26');
  assert.equal(isWithinAutomaticLoginWindow(new Date('2026-07-25T21:00:00.000Z')), true);
  assert.equal(isWithinAutomaticLoginWindow(new Date('2026-07-25T21:24:59.000Z')), true);
  assert.equal(isWithinAutomaticLoginWindow(new Date('2026-07-25T21:25:00.000Z')), false);
  assert.equal(isWithinAutomaticLoginWindow(new Date('2026-07-25T22:00:00.000Z')), false);
});

test('the only automatic login schedule is the proven 21:05 UTC / 06:05 KST cron', () => {
  assert.equal(AUTOMATIC_LOGIN_SCHEDULE, '5 21 * * *');

  const safe = decideAttendanceRun({
    eventName: 'schedule',
    schedule: AUTOMATIC_LOGIN_SCHEDULE,
    lastSuccess: '2026-07-25',
    now: new Date('2026-07-25T21:05:00.000Z')
  });
  assert.equal(safe.shouldRun, true);
  assert.equal(safe.stage, 'safe-morning-window');

  const delayed = decideAttendanceRun({
    eventName: 'schedule',
    schedule: AUTOMATIC_LOGIN_SCHEDULE,
    lastSuccess: '2026-07-25',
    now: new Date('2026-07-25T21:25:00.000Z')
  });
  assert.equal(delayed.shouldRun, false);
  assert.equal(delayed.reason, 'outside-safe-login-window');

  for (const unsupportedSchedule of [
    '7,17 6 * * *',
    '47,57 5 * * *',
    '13 12 * * *'
  ]) {
    const unsupported = decideAttendanceRun({
      eventName: 'schedule',
      schedule: unsupportedSchedule,
      lastSuccess: '2026-07-25',
      now: new Date('2026-07-25T21:05:00.000Z')
    });
    assert.equal(unsupported.shouldRun, false, unsupportedSchedule);
    assert.equal(unsupported.reason, 'unsupported-schedule', unsupportedSchedule);
  }
});

test('successful marker suppresses the single scheduled run before login work begins', () => {
  const decision = decideAttendanceRun({
    eventName: 'schedule',
    schedule: AUTOMATIC_LOGIN_SCHEDULE,
    lastSuccess: '2026-07-26\n',
    now: new Date('2026-07-25T21:05:00.000Z')
  });
  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'already-completed');
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
  assert.equal(confirmed.stage, 'manual');
});

test('watchdog only checks the marker and explains why it will not log in late', () => {
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
  assert.match(buildMissingSummary(missing), /06:25 KST 이후에는 자동 로그인을 다시 시도하지 않습니다/);
  assert.match(buildMissingSummary(missing), /게임에서 로그아웃한 상태/);
  assert.equal(scheduleStage(WATCHDOG_SCHEDULE), 'safety-watchdog');
});

test('workflow definition contains exactly one automatic login cron at 21:05 UTC', () => {
  const main = fs.readFileSync(repoPath('.github', 'workflows', 'main.yml'), 'utf8');
  const watchdog = fs.readFileSync(repoPath('.github', 'workflows', 'attendance-watchdog.yml'), 'utf8');
  const cronLines = [...main.matchAll(/^\s*- cron:\s*['\"]([^'\"]+)['\"]\s*$/gm)]
    .map(match => match[1]);

  assert.deepEqual(cronLines, ['5 21 * * *']);
  assert.doesNotMatch(main, /^\s*timezone:/m);
  assert.doesNotMatch(main, /7,17 6 \* \* \*/);
  assert.doesNotMatch(main, /47,57 5 \* \* \*/);
  assert.match(main, /confirm_not_playing:/);
  assert.match(main, /현재 접속 상태를 확인하세요/);
  assert.match(main, /ATTENDANCE_CONFIRM_SAFE_LOGIN/);
  assert.match(main, /npm ci --omit=dev --ignore-scripts/);
  const attendance = main.split(/\n  attendance:\n/)[1] || '';
  assert.doesNotMatch(attendance, /run: npm test/);
  assert.match(attendance, /node scripts\/preflight-attendance\.js/);
  assert.match(attendance, /git push origin HEAD:main/);

  assert.match(watchdog, /cron: '50 6 \* \* \*'/);
  assert.match(watchdog, /Check success marker without logging in/);
  assert.match(watchdog, /node scripts\/check-attendance-watchdog\.js/);
  assert.doesNotMatch(watchdog, /actions: write/);
  assert.doesNotMatch(watchdog, /dispatch-attendance-watchdog/);
  assert.equal(fs.existsSync(repoPath('scripts', 'dispatch-attendance-watchdog.js')), false);
  assert.equal(fs.existsSync(repoPath('.github', 'workflows', 'attendance-early-backup.yml')), false);
});
