const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  FINAL_RECOVERY_SCHEDULE,
  MORNING_RETRY_SCHEDULE,
  WATCHDOG_SCHEDULE,
  decideAttendanceRun,
  dispatchStage,
  formatKstDate,
  scheduleStage
} = require('../src/attendance-schedule');
const {
  dispatchAttendance,
  splitRepository
} = require('../scripts/dispatch-attendance-watchdog');

const repoPath = (...parts) => path.join(process.cwd(), ...parts);

test('KST date calculation is independent from runner timezone', () => {
  assert.equal(formatKstDate(new Date('2026-07-25T14:59:59.000Z')), '2026-07-25');
  assert.equal(formatKstDate(new Date('2026-07-25T15:00:00.000Z')), '2026-07-26');
});

test('successful attendance marker suppresses every non-forced retry', () => {
  const now = new Date('2026-07-25T22:10:00.000Z');
  for (const schedule of [MORNING_RETRY_SCHEDULE, FINAL_RECOVERY_SCHEDULE, WATCHDOG_SCHEDULE]) {
    const decision = decideAttendanceRun({
      eventName: 'schedule',
      schedule,
      lastSuccess: '2026-07-26\n',
      now
    });
    assert.equal(decision.shouldRun, false);
    assert.equal(decision.reason, 'already-completed');
  }
  const watchdogDispatch = decideAttendanceRun({
    eventName: 'workflow_dispatch',
    source: 'watchdog',
    lastSuccess: '2026-07-26',
    now,
    force: false
  });
  assert.equal(watchdogDispatch.shouldRun, false);
  assert.equal(watchdogDispatch.stage, 'watchdog-dispatch');
});

test('stale markers retry while manual force always runs', () => {
  const now = new Date('2026-07-25T22:10:00.000Z');
  const scheduled = decideAttendanceRun({
    eventName: 'schedule',
    schedule: MORNING_RETRY_SCHEDULE,
    lastSuccess: '2026-07-25',
    now
  });
  assert.equal(scheduled.shouldRun, true);
  assert.equal(scheduled.stage, 'morning-retry-window');

  const manual = decideAttendanceRun({
    eventName: 'workflow_dispatch',
    source: 'manual',
    lastSuccess: '2026-07-26',
    now,
    force: true
  });
  assert.equal(manual.shouldRun, true);
  assert.equal(manual.reason, 'manual-force');
  assert.equal(manual.stage, 'manual');
});

test('schedule and dispatch stages describe recovery paths accurately', () => {
  assert.equal(scheduleStage(MORNING_RETRY_SCHEDULE), 'morning-retry-window');
  assert.equal(scheduleStage(FINAL_RECOVERY_SCHEDULE), 'final-recovery');
  assert.equal(scheduleStage(WATCHDOG_SCHEDULE), 'watchdog');
  assert.equal(dispatchStage('watchdog'), 'watchdog-dispatch');
  assert.equal(dispatchStage('manual'), 'manual');
});

test('watchdog dispatches trusted main with only a deduplicating force input', async () => {
  let request;
  const status = await dispatchAttendance({
    repository: 'Null2648/majsoul-monthTicket-auto',
    token: 'test-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(null, { status: 204 });
    }
  });
  assert.equal(status, 204);
  assert.match(request.url, /actions\/workflows\/main\.yml\/dispatches$/);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer test-token');
  assert.equal(request.init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.deepEqual(JSON.parse(request.init.body), {
    ref: 'main',
    inputs: { force: 'false' }
  });
  assert.deepEqual(splitRepository('owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.throws(() => splitRepository('invalid'), /Invalid GITHUB_REPOSITORY/);
});

test('workflow definitions expose wrong-ref manual failures and keep runtime lean', () => {
  const main = fs.readFileSync(repoPath('.github', 'workflows', 'main.yml'), 'utf8');
  const watchdog = fs.readFileSync(repoPath('.github', 'workflows', 'attendance-watchdog.yml'), 'utf8');
  assert.match(main, /cron: '17 6-10 \* \* \*'/);
  assert.match(main, /cron: '13 12 \* \* \*'/);
  assert.match(main, /manual_ref_check:/);
  assert.match(main, /main 브랜치를 선택하세요/);
  assert.match(main, /needs\.manual_ref_check\.result == 'success'/);
  assert.match(main, /npm ci --omit=dev --ignore-scripts/);
  const attendance = main.split(/\n  attendance:\n/)[1] || '';
  assert.doesNotMatch(attendance, /run: npm test/);
  assert.match(attendance, /node scripts\/preflight-attendance\.js/);
  assert.match(attendance, /node scripts\/write-attendance-run-report\.js/);
  assert.match(attendance, /git push origin HEAD:main/);
  assert.match(watchdog, /cron: '31 11,13 \* \* \*'/);
  assert.match(watchdog, /actions: write/);
  assert.match(watchdog, /ref: main/);
  assert.match(watchdog, /persist-credentials: false/);
});
