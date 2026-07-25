const fs = require('node:fs');
const path = require('node:path');

const AUTOMATION_FAILURE_REPORT_PATH = path.join(
  process.cwd(),
  'automation-failure-report.json'
);
const INCIDENT_MARKER = '<!-- majsoul-attendance-alert -->';
const INCIDENT_TITLE = '[자동 출석 장애] 점검 필요';
const PRIMARY_SCHEDULE = '17 6 * * *';
const FALLBACK_SCHEDULE = '47 6 * * *';
const IMMEDIATE_CLASSIFICATIONS = new Set([
  'protocol-breaking',
  'official-metadata',
  'client-metadata',
  'yostar-metadata'
]);

function uniqueSecretValues(env = process.env) {
  return [...new Set([
    env.TOKEN,
    env.ACCESS_TOKEN,
    env.YOSTAR_DEVICE_ID,
    env.PASSWORD,
    env.EMAIL,
    env.UID
  ].filter(value => typeof value === 'string' && value.length >= 4))]
    .sort((a, b) => b.length - a.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeText(value, { env = process.env, maxLength = 1200 } = {}) {
  let text = String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');

  for (const secret of uniqueSecretValues(env)) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  text = text
    .replace(
      /\b(authorization|access[_-]?token|login[_-]?token|password|signing[_-]?secret|device[_-]?id)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      '$1=[REDACTED]'
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL REDACTED]')
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, '[REDACTED]')
    .trim();

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength - 20)} … [truncated]`;
  }

  return text;
}

function classifyAutomationError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = `${error?.name || ''} ${error?.message || error || ''}`;

  if (code === 'PROTOCOL_BREAKING_CHANGE' || /breaking protocol|protocol field|protocol method/i.test(message)) {
    return 'protocol-breaking';
  }
  if (
    /official structure|productVersion|Unity build|resource manifest|liqi prefix|protocol source|code directory|config fetch/i.test(message)
  ) {
    return 'official-metadata';
  }
  if (/YoStar WebSDK.*(?:metadata|version|host|PID|sign)|signing metadata|parse.*WebSDK/i.test(message)) {
    return 'yostar-metadata';
  }
  if (/client_version_string|version_str|client metadata candidates|resource version rejected/i.test(message)) {
    return 'client-metadata';
  }
  if (/oauth|token expired|quick.?login|login failed|authentication/i.test(message)) {
    return 'authentication';
  }
  if (/gateway|websocket|ECONN|ENOTFOUND|ETIMEDOUT|request timeout|network/i.test(message)) {
    return 'network-or-gateway';
  }
  if (/month.?ticket|payMonthTicket|fetchMonthTicketInfo|gainReviveCoin|buyFromZHP/i.test(message)) {
    return 'attendance-action';
  }
  return 'runtime';
}

function clearAutomationFailureReport(filePath = AUTOMATION_FAILURE_REPORT_PATH) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // A stale report is non-fatal; the next write will replace it when possible.
  }
}

function writeAutomationFailureReport(
  error,
  {
    stage = 'automation',
    filePath = AUTOMATION_FAILURE_REPORT_PATH,
    env = process.env
  } = {}
) {
  const report = {
    version: 1,
    failedAt: new Date().toISOString(),
    stage,
    classification: classifyAutomationError(error),
    code: sanitizeText(error?.code || '', { env, maxLength: 120 }),
    summary: sanitizeText(error?.message || error, { env })
  };

  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function shouldNotifyFailure({ eventName, schedule, classification }) {
  if (eventName === 'workflow_dispatch') return true;
  if (eventName !== 'schedule') return false;
  if (schedule === FALLBACK_SCHEDULE) return true;
  if (schedule === PRIMARY_SCHEDULE) {
    return IMMEDIATE_CLASSIFICATIONS.has(classification);
  }
  return true;
}

function formatKstDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second} KST`;
}

function describeSchedule(schedule) {
  if (schedule === PRIMARY_SCHEDULE) return '06:17 1차 실행';
  if (schedule === FALLBACK_SCHEDULE) return '06:47 재시도';
  return schedule || '수동 실행';
}

function normalizeOutcome(value) {
  const outcome = String(value || 'skipped');
  const labels = {
    success: '성공',
    failure: '실패',
    cancelled: '취소',
    skipped: '건너뜀'
  };
  return labels[outcome] || outcome;
}

function buildStepTable(outcomes = {}) {
  const rows = [
    ['테스트', outcomes.tests],
    ['JP 클라이언트 검사', outcomes.jp],
    ['YoStar SDK 검사', outcomes.yostar],
    ['프로토콜 검사', outcomes.protocol],
    ['자동 출석', outcomes.automation],
    ['캐시 저장', outcomes.cache]
  ];

  return [
    '| 단계 | 결과 |',
    '|---|---|',
    ...rows.map(([name, outcome]) => `| ${name} | ${normalizeOutcome(outcome)} |`)
  ].join('\n');
}

function buildFailureBody({
  classification,
  summary,
  protocolBreaking = [],
  eventName,
  schedule,
  runUrl,
  sha,
  lastSuccess,
  outcomes,
  occurredAt = new Date()
}) {
  const details = protocolBreaking.length
    ? protocolBreaking.slice(0, 8).map(item => `- ${sanitizeText(item)}`).join('\n')
    : `- ${sanitizeText(summary || '구체적인 오류 요약을 생성하지 못했습니다.')}`;

  return [
    INCIDENT_MARKER,
    '자동 출석 작업에서 점검이 필요한 실패가 감지되었습니다.',
    '',
    `- 발생 시각: ${formatKstDateTime(occurredAt)}`,
    `- 실행 구분: ${eventName === 'schedule' ? describeSchedule(schedule) : '수동 실행'}`,
    `- 분류: \`${classification}\``,
    `- 마지막 성공일: ${lastSuccess || '기록 없음'}`,
    `- 커밋: \`${String(sha || '').slice(0, 12) || '확인 불가'}\``,
    `- 실행 기록: [GitHub Actions 실행 열기](${runUrl})`,
    '',
    '### 단계 상태',
    buildStepTable(outcomes),
    '',
    '### 감지된 원인',
    details,
    '',
    '06:17의 일반적인 일시 오류는 06:47 재시도까지 기다립니다. 구조 변경이나 재시도 실패는 이 이슈에 계속 기록되며, 이후 출석이 성공하면 자동으로 종료됩니다.'
  ].join('\n');
}

function buildFailureComment(context) {
  return [
    `### 실패 재발 — ${formatKstDateTime(context.occurredAt || new Date())}`,
    '',
    `- 실행 구분: ${context.eventName === 'schedule' ? describeSchedule(context.schedule) : '수동 실행'}`,
    `- 분류: \`${context.classification}\``,
    `- 실행 기록: [GitHub Actions 실행 열기](${context.runUrl})`,
    '',
    buildStepTable(context.outcomes),
    '',
    sanitizeText(context.summary || '추가 오류 요약 없음')
  ].join('\n');
}

function buildRecoveryComment({ runUrl, schedule, eventName, occurredAt = new Date() }) {
  return [
    `### 자동 복구 확인 — ${formatKstDateTime(occurredAt)}`,
    '',
    `- 실행 구분: ${eventName === 'schedule' ? describeSchedule(schedule) : '수동 실행'}`,
    `- 실행 기록: [GitHub Actions 실행 열기](${runUrl})`,
    '',
    '자동 출석이 정상 완료되어 이 장애 이슈를 종료합니다.'
  ].join('\n');
}

module.exports = {
  AUTOMATION_FAILURE_REPORT_PATH,
  FALLBACK_SCHEDULE,
  INCIDENT_MARKER,
  INCIDENT_TITLE,
  PRIMARY_SCHEDULE,
  buildFailureBody,
  buildFailureComment,
  buildRecoveryComment,
  buildStepTable,
  classifyAutomationError,
  clearAutomationFailureReport,
  describeSchedule,
  formatKstDateTime,
  readJsonFile,
  sanitizeText,
  shouldNotifyFailure,
  writeAutomationFailureReport
};
