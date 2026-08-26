const fs = require('node:fs');

const TIME_ZONE = 'Asia/Seoul';
// 21:05 UTC is 06:05 KST. 21:35 UTC is the fallback at 06:35 KST.
// The fallback is allowed to start only when today's success marker is still missing.
const AUTOMATIC_LOGIN_SCHEDULE = '5 21 * * *';
const MORNING_RETRY_SCHEDULE = '35 21 * * *';
const AUTOMATIC_LOGIN_SCHEDULES = new Set([
  AUTOMATIC_LOGIN_SCHEDULE,
  MORNING_RETRY_SCHEDULE
]);
const WATCHDOG_SCHEDULE = '50 6 * * *';

function getKstDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function formatKstDate(date = new Date()) {
  const value = getKstDateTimeParts(date);
  return [value.year, value.month, value.day]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-');
}

function normalizeAttendanceDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function scheduleStage(schedule) {
  if (schedule === AUTOMATIC_LOGIN_SCHEDULE) return 'primary-daily-schedule';
  if (schedule === MORNING_RETRY_SCHEDULE) return 'fallback-daily-schedule';
  if (schedule === WATCHDOG_SCHEDULE) return 'safety-watchdog';
  return schedule ? 'scheduled-other' : 'manual';
}

function dispatchStage() {
  return 'manual';
}

function decision({ shouldRun, reason, stage, today, lastSuccess }) {
  return { shouldRun, reason, stage, today, lastSuccess };
}

function decideAttendanceRun({
  eventName,
  schedule = '',
  source = '',
  lastSuccess,
  now = new Date(),
  force = false,
  confirmSafeLogin = false
}) {
  const today = formatKstDate(now);
  const normalizedLastSuccess = normalizeAttendanceDate(lastSuccess);
  const manual = eventName === 'workflow_dispatch';
  const scheduled = eventName === 'schedule';
  const stage = manual ? dispatchStage(source) : scheduleStage(schedule);

  if (!manual && !scheduled) {
    return decision({
      shouldRun: false,
      reason: 'unsupported-event',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    });
  }

  if (manual && !confirmSafeLogin) {
    return decision({
      shouldRun: false,
      reason: 'manual-safety-confirmation-required',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    });
  }

  if (manual && force) {
    return decision({
      shouldRun: true,
      reason: 'manual-force-confirmed',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    });
  }

  // Both automatic events consult the same persisted KST date marker. If either
  // one has already completed today, the other exits before preflight/login.
  if (normalizedLastSuccess === today) {
    return decision({
      shouldRun: false,
      reason: 'already-completed',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    });
  }

  if (scheduled && !AUTOMATIC_LOGIN_SCHEDULES.has(schedule)) {
    return decision({
      shouldRun: false,
      reason: 'unsupported-schedule',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    });
  }

  // GitHub may allocate either scheduled runner later than its cron minute.
  // Do not discard a delayed event: job-level concurrency serializes the two
  // events, then this marker check ensures only the first successful one logs in.
  return decision({
    shouldRun: true,
    reason: scheduled
      ? (schedule === MORNING_RETRY_SCHEDULE ? 'fallback-scheduled-event' : 'primary-scheduled-event')
      : (normalizedLastSuccess ? 'not-completed-today' : 'no-success-marker'),
    stage,
    today,
    lastSuccess: normalizedLastSuccess
  });
}

function readMarker(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function appendGithubOutput(result, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = [
    `should_run=${result.shouldRun}`,
    `reason=${result.reason}`,
    `stage=${result.stage}`,
    `today=${result.today}`,
    `last_success=${result.lastSuccess || ''}`
  ];
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function runCli(argv = process.argv.slice(2), env = process.env) {
  const markerPath = argv[0] || 'last-attendance-kst.txt';
  const now = env.ATTENDANCE_NOW ? new Date(env.ATTENDANCE_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid ATTENDANCE_NOW: ${env.ATTENDANCE_NOW}`);
  const result = decideAttendanceRun({
    eventName: env.GITHUB_EVENT_NAME,
    schedule: env.ATTENDANCE_SCHEDULE || '',
    source: env.ATTENDANCE_SOURCE || '',
    lastSuccess: readMarker(markerPath),
    now,
    force: parseBoolean(env.ATTENDANCE_FORCE, false),
    confirmSafeLogin: parseBoolean(env.ATTENDANCE_CONFIRM_SAFE_LOGIN, false)
  });
  appendGithubOutput(result, env.GITHUB_OUTPUT);
  console.log(
    `attendance schedule decision -> run=${result.shouldRun} reason=${result.reason} ` +
    `stage=${result.stage} today=${result.today} last=${result.lastSuccess || 'none'}`
  );
  return result;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  AUTOMATIC_LOGIN_SCHEDULE,
  AUTOMATIC_LOGIN_SCHEDULES,
  MORNING_RETRY_SCHEDULE,
  TIME_ZONE,
  WATCHDOG_SCHEDULE,
  appendGithubOutput,
  decideAttendanceRun,
  dispatchStage,
  formatKstDate,
  getKstDateTimeParts,
  normalizeAttendanceDate,
  parseBoolean,
  readMarker,
  runCli,
  scheduleStage
};
