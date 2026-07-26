const fs = require('node:fs');

const TIME_ZONE = 'Asia/Seoul';
const MORNING_RETRY_SCHEDULE = '17 6-10 * * *';
const FINAL_RECOVERY_SCHEDULE = '13 12 * * *';
const WATCHDOG_SCHEDULE = '31 11,13 * * *';

function formatKstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeAttendanceDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function scheduleStage(schedule) {
  if (schedule === MORNING_RETRY_SCHEDULE) return 'morning-retry-window';
  if (schedule === FINAL_RECOVERY_SCHEDULE) return 'final-recovery';
  if (schedule === WATCHDOG_SCHEDULE) return 'watchdog';
  return schedule ? 'scheduled-other' : 'manual';
}

function dispatchStage(source) {
  return String(source || '').trim().toLowerCase() === 'watchdog'
    ? 'watchdog-dispatch'
    : 'manual';
}

function decideAttendanceRun({
  eventName,
  schedule = '',
  source = '',
  lastSuccess,
  now = new Date(),
  force = false
}) {
  const today = formatKstDate(now);
  const normalizedLastSuccess = normalizeAttendanceDate(lastSuccess);
  const manual = eventName === 'workflow_dispatch';
  const scheduled = eventName === 'schedule';
  const stage = manual ? dispatchStage(source) : scheduleStage(schedule);

  if (!manual && !scheduled) {
    return {
      shouldRun: false,
      reason: 'unsupported-event',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    };
  }

  if (manual && force) {
    return {
      shouldRun: true,
      reason: 'manual-force',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    };
  }

  if (normalizedLastSuccess === today) {
    return {
      shouldRun: false,
      reason: 'already-completed',
      stage,
      today,
      lastSuccess: normalizedLastSuccess
    };
  }

  return {
    shouldRun: true,
    reason: normalizedLastSuccess ? 'not-completed-today' : 'no-success-marker',
    stage,
    today,
    lastSuccess: normalizedLastSuccess
  };
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
    force: parseBoolean(env.ATTENDANCE_FORCE, false)
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
  FINAL_RECOVERY_SCHEDULE,
  MORNING_RETRY_SCHEDULE,
  TIME_ZONE,
  WATCHDOG_SCHEDULE,
  appendGithubOutput,
  decideAttendanceRun,
  dispatchStage,
  formatKstDate,
  normalizeAttendanceDate,
  parseBoolean,
  readMarker,
  runCli,
  scheduleStage
};
