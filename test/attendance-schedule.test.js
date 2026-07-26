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

test('scheduled login runs only inside the protected 06:00-06:25 KST window', () => {
  const safe = decideAttendanceRun({
    eventName: 'schedule',
    schedule: AUTOMATIC_LOGIN_SCHEDULE,
    lastSuccess: '2026-07-25',
    now: new Date('2026-07-25T21:17:00.000Z')
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

  const unsupported = decideAttendanceRun({
    eventName: 'schedule',
    schedule: '13 12 * * *',
    lastSuccess: '2026-07-25',
    now: new Date('2026-07-26T03:13:00.000Z')
  });
  assert.equal(unsupported.shouldRun, false);
  assert.equal(unsupported.reason, 'unsupported-schedule');
});

test('successful marker suppresses retries before any login work begins', () => {
  const decision = decideAttendanceRun({
    eventName: 'schedule',
    schedule: AUTOMATIC_LOGIN_SCHEDULE,
    lastSuccess: '2026-07-26\n',
    now: new Date('2026-07-25T21:17:00.000Z')
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

test('workflow definitions contain no automatic login after the safe morning window', () => {
  const main = fs.readFileSync(repoPath('.github', 'workflows', 'main.yml'), 'utf8');
  const watchdog = fs.readFileSync(repoPath('.github', 'workflows', 'attendance-watchdog.yml'), 'utf8');
  assert.match(main, /cron: '7,17 6 \* \* \*'/);
  assert.doesNotMatch(main, /6-10 \* \* \*/);
  assert.doesNotMatch(main, /13 12 \* \* \*/);
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
});
