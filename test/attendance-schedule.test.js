const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  FINAL_RECOVERY_SCHEDULE,
  MORNING_RETRY_SCHEDULE,
  WATCHDOG_SCHEDULE,
  decideAttendanceRun,
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
    lastSuccess: '2026-07-26',
    now,
    force: false
  });
  assert.equal(watchdogDispatch.shouldRun, false);
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
    lastSuccess: '2026-07-26',
    now,
    force: true
  });
  assert.equal(manual.shouldRun, true);
  assert.equal(manual.reason, 'manual-force');
});

test('schedule stages describe retry and independent recovery paths', () => {
  assert.equal(scheduleStage(MORNING_RETRY_SCHEDULE), 'morning-retry-window');
  assert.equal(scheduleStage(FINAL_RECOVERY_SCHEDULE), 'final-recovery');
  assert.equal(scheduleStage(WATCHDOG_SCHEDULE), 'watchdog');
});

test('watchdog dispatches main workflow with a deduplicating non-force input', async () => {
  let request;
  const status = await dispatchAttendance({
    repository: 'Null2648/majsoul-monthTicket-auto',
    token: 'test-token',
    ref: 'main',
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
    inputs: { force: 'false', source: 'watchdog' }
  });
  assert.deepEqual(splitRepository('owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.throws(() => splitRepository('invalid'), /Invalid GITHUB_REPOSITORY/);
});

test('workflow definitions keep validation read-only and recovery independently scheduled', () => {
  const main = fs.readFileSync(repoPath('.github', 'workflows', 'main.yml'), 'utf8');
  const watchdog = fs.readFileSync(repoPath('.github', 'workflows', 'attendance-watchdog.yml'), 'utf8');
  assert.match(main, /cron: '7,22,37,52 6-10 \* \* \*'/);
  assert.match(main, /cron: '13 12 \* \* \*'/);
  assert.match(main, /group: majsoul-attendance\n\s+cancel-in-progress: false/);
  assert.match(main, /ATTENDANCE_FORCE: \$\{\{ inputs\.force \}\}/);
  assert.match(main, /attendance:\n\s+if: >-[\s\S]*?github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(main, /cron: '17 6 \* \* \*'/);
  assert.match(watchdog, /cron: '31 11-14 \* \* \*'/);
  assert.match(watchdog, /dispatch:\n\s+if: >-[\s\S]*?github\.ref == 'refs\/heads\/main'/);
  assert.match(watchdog, /actions: write/);
  assert.match(watchdog, /ref: main/);
  assert.match(watchdog, /persist-credentials: false/);
});
