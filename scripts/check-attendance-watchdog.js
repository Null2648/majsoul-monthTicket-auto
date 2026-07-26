const fs = require('node:fs');
const {
  formatKstDate,
  normalizeAttendanceDate
} = require('../src/attendance-schedule');

function readMarker(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function appendSummary(message, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, `${message}\n`, 'utf8');
}

function checkAttendanceStatus({ lastSuccess, now = new Date() }) {
  const today = formatKstDate(now);
  const normalizedLastSuccess = normalizeAttendanceDate(lastSuccess);
  return {
    completed: normalizedLastSuccess === today,
    today,
    lastSuccess: normalizedLastSuccess
  };
}

function buildMissingSummary(result) {
  return [
    '## 자동 출석 미완료 확인',
    '',
    `- 오늘 날짜: \`${result.today}\``,
    `- 마지막 성공일: \`${result.lastSuccess || '기록 없음'}\``,
    '',
    '접속 중인 게임 세션을 끊지 않도록 06:25 KST 이후에는 자동 로그인을 다시 시도하지 않습니다.',
    '게임에서 로그아웃한 상태를 확인한 뒤 `Login to Majsoul`을 수동 실행하고 안전 확인 항목을 켜세요.'
  ].join('\n');
}

function runCli(argv = process.argv.slice(2), env = process.env) {
  const markerPath = argv[0] || 'last-attendance-kst.txt';
  const now = env.ATTENDANCE_NOW ? new Date(env.ATTENDANCE_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid ATTENDANCE_NOW: ${env.ATTENDANCE_NOW}`);

  const result = checkAttendanceStatus({
    lastSuccess: readMarker(markerPath),
    now
  });

  if (result.completed) {
    const summary = [
      '## 자동 출석 완료 확인',
      '',
      `오늘(${result.today}) 성공 기록이 확인됐습니다. 추가 로그인은 수행하지 않았습니다.`
    ].join('\n');
    appendSummary(summary, env.GITHUB_STEP_SUMMARY);
    console.log(`attendance safety watchdog -> completed (${result.today})`);
    return result;
  }

  const summary = buildMissingSummary(result);
  appendSummary(summary, env.GITHUB_STEP_SUMMARY);
  const error = new Error(
    `Attendance is not recorded for ${result.today}. ` +
    'Late automatic login was intentionally blocked to protect an active game session.'
  );
  error.code = 'ATTENDANCE_MISSING_AFTER_SAFE_WINDOW';
  throw error;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(`::error title=자동 출석 미완료::${error?.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  appendSummary,
  buildMissingSummary,
  checkAttendanceStatus,
  readMarker,
  runCli
};
