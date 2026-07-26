const fs = require('node:fs');
const path = require('node:path');

const REPORT_PATH = path.join(process.cwd(), 'attendance-run-report.json');

function normalizeOutcome(value) {
  const outcome = String(value || 'skipped').trim();
  return ['success', 'failure', 'cancelled', 'skipped'].includes(outcome) ? outcome : 'unknown';
}

function buildReport(env = process.env, now = new Date()) {
  return {
    version: 1,
    createdAt: now.toISOString(),
    eventName: String(env.GITHUB_EVENT_NAME || ''),
    source: String(env.ATTENDANCE_SOURCE || ''),
    ref: String(env.GITHUB_REF || ''),
    refName: String(env.GITHUB_REF_NAME || ''),
    runId: String(env.GITHUB_RUN_ID || ''),
    runAttempt: String(env.GITHUB_RUN_ATTEMPT || ''),
    jobStatus: String(env.JOB_STATUS || 'unknown'),
    decision: {
      outcome: normalizeOutcome(env.DECISION_OUTCOME),
      shouldRun: String(env.SHOULD_RUN || '') === 'true',
      reason: String(env.DECISION_REASON || ''),
      stage: String(env.ATTENDANCE_STAGE || ''),
      today: String(env.ATTENDANCE_TODAY || ''),
      lastSuccess: String(env.LAST_SUCCESS || '') || null
    },
    outcomes: {
      preflight: normalizeOutcome(env.PREFLIGHT_OUTCOME),
      install: normalizeOutcome(env.INSTALL_OUTCOME),
      automation: normalizeOutcome(env.AUTOMATION_OUTCOME),
      cache: normalizeOutcome(env.CACHE_OUTCOME)
    }
  };
}

function appendSummary(report, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  const rows = Object.entries(report.outcomes)
    .map(([name, outcome]) => `| ${name} | ${outcome} |`)
    .join('\n');
  fs.appendFileSync(
    summaryPath,
    [
      '## 출석 실행 요약',
      '',
      `- 이벤트: \`${report.eventName}\``,
      `- 실행 ref: \`${report.ref || 'unknown'}\``,
      `- 실행 여부: ${report.decision.shouldRun ? '실행' : '건너뜀'}`,
      `- 판정: \`${report.decision.reason || 'unknown'}\``,
      `- 최종 상태: \`${report.jobStatus}\``,
      '',
      '| 단계 | 결과 |',
      '|---|---|',
      rows,
      ''
    ].join('\n'),
    'utf8'
  );
}

function run(env = process.env) {
  const report = buildReport(env);
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  appendSummary(report, env.GITHUB_STEP_SUMMARY);
  console.log(`attendance run report -> ${REPORT_PATH}`);
  return report;
}

if (require.main === module) run();

module.exports = {
  REPORT_PATH,
  buildReport,
  normalizeOutcome,
  run
};
