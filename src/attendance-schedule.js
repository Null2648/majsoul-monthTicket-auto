const fs = require('node:fs');

const TIME_ZONE = 'Asia/Seoul';
const EARLY_AUTOMATIC_LOGIN_SCHEDULE = '47,57 5 * * *';
const AUTOMATIC_LOGIN_SCHEDULE = '7,17 6 * * *';
const AUTOMATIC_LOGIN_SCHEDULES = Object.freeze([
  EARLY_AUTOMATIC_LOGIN_SCHEDULE,
  AUTOMATIC_LOGIN_SCHEDULE
]);
const MORNING_RETRY_SCHEDULE = AUTOMATIC_LOGIN_SCHEDULE;
const WATCHDOG_SCHEDULE = '50 6 * * *';
const SAFE_LOGIN_WINDOW_START_MINUTES = 5 * 60 + 45;
const SAFE_LOGIN_WINDOW_END_MINUTES = 6 * 60 + 25;

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

function isWithinAutomaticLoginWindow(date = new Date()) {
  const value = getKstDateTimeParts(date);
  const minutes = value.hour * 60 + value.minute;
  return (
    minutes >= SAFE_LOGIN_WINDOW_START_MINUTES &&
    minutes < SAFE_LOGIN_WINDOW_END_MINUTES
  );
}

function isAutomaticLoginSchedule(schedule) {
  return AUTOMATIC_LOGIN_SCHEDULES.includes(String(schedule || '').trim());
}

function scheduleStage(schedule) {
  if (isAutomaticLoginSchedule(schedule)) return 'safe-morning-window';
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

  if (normalizedLastSuccess === today) {
    return decision({
      shouldRun: false,
      reason: 'already-completed',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    });
  }

  if (scheduled) {
    if (!isAutomaticLoginSchedule(schedule)) {
      return decision({
        shouldRun: false,
        reason: 'unsupported-schedule',
        stage,
        today,
        lastSuccess: normalizedLastSuccess
      });
    }

    if (!isWithinAutomaticLoginWindow(now)) {
      return decision({
        shouldRun: false,
        reason: 'outside-safe-login-window',
        stage,
        today,
        lastSuccess: normalizedLastSuccess
      });
    }
  }

  return decision({
    shouldRun: true,
    reason: normalizedLastSuccess ? 'not-completed-today' : 'no-success-marker',
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
  EARLY_AUTOMATIC_LOGIN_SCHEDULE,
  MORNING_RETRY_SCHEDULE,
  SAFE_LOGIN_WINDOW_END_MINUTES,
  SAFE_LOGIN_WINDOW_START_MINUTES,
  TIME_ZONE,
  WATCHDOG_SCHEDULE,
  appendGithubOutput,
  decideAttendanceRun,
  dispatchStage,
  formatKstDate,
  getKstDateTimeParts,
  isAutomaticLoginSchedule,
  isWithinAutomaticLoginWindow,
  normalizeAttendanceDate,
  parseBoolean,
  readMarker,
  runCli,
  scheduleStage
};
