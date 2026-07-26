const fs = require('node:fs');
const {
  AUTOMATION_FAILURE_REPORT_PATH,
  INCIDENT_MARKER,
  INCIDENT_TITLE,
  buildFailureBody,
  buildFailureComment,
  buildRecoveryComment,
  readJsonFile,
  sanitizeMarkdownText,
  shouldNotifyFailure
} = require('../src/automation-alert-hardened');
const {
  PROTOCOL_REPORT_PATH
} = require('../src/protocol-monitor-hardened');

function readEventPayload(filePath = process.env.GITHUB_EVENT_PATH) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function getFailureContext() {
  const event = readEventPayload();
  const automationReport = readJsonFile(AUTOMATION_FAILURE_REPORT_PATH);
  const protocolReport = readJsonFile(PROTOCOL_REPORT_PATH);
  const protocolBreaking = Array.isArray(protocolReport?.breaking) ? protocolReport.breaking : [];
  const outcomes = {
    preflight: process.env.PREFLIGHT_OUTCOME,
    install: process.env.INSTALL_OUTCOME,
    tests: process.env.TESTS_OUTCOME,
    jp: process.env.JP_OUTCOME,
    yostar: process.env.YOSTAR_OUTCOME,
    protocol: process.env.PROTOCOL_OUTCOME,
    automation: process.env.AUTOMATION_OUTCOME,
    cache: process.env.CACHE_OUTCOME
  };

  let classification = automationReport?.classification;
  if (protocolBreaking.length) classification = 'protocol-breaking';
  if (!classification && outcomes.preflight === 'failure') classification = 'configuration';
  if (!classification && outcomes.jp === 'failure') classification = 'official-metadata';
  if (!classification && outcomes.yostar === 'failure') classification = 'yostar-metadata';
  if (!classification && outcomes.protocol === 'failure') classification = 'protocol-breaking';
  if (!classification && outcomes.tests === 'failure') classification = 'test-failure';
  if (!classification && outcomes.install === 'failure') classification = 'dependency-install';
  if (!classification && outcomes.cache === 'failure') classification = 'cache-update';
  if (!classification) classification = 'runtime';

  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  let lastSuccess = null;
  try { lastSuccess = fs.readFileSync('last-attendance-kst.txt', 'utf8').trim() || null; } catch { /* no successful run yet */ }

  return {
    eventName: process.env.GITHUB_EVENT_NAME,
    schedule: event.schedule || '',
    stage: process.env.ATTENDANCE_STAGE || automationReport?.stage || '',
    source: process.env.ATTENDANCE_SOURCE || '',
    classification,
    summary: sanitizeMarkdownText(
      automationReport?.summary || protocolBreaking[0] ||
      `Workflow job ended with status ${process.env.JOB_STATUS || 'unknown'}`
    ),
    protocolBreaking: protocolBreaking.map(item => sanitizeMarkdownText(item)),
    outcomes,
    runUrl,
    sha: process.env.GITHUB_SHA,
    lastSuccess,
    occurredAt: new Date()
  };
}

async function githubApi(pathname, { method = 'GET', body } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for issue notifications');
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'majsoul-monthticket-auto',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${pathname} failed: ${response.status} ${sanitizeMarkdownText(text)}`);
  }
  return payload;
}

async function findOpenIncident(owner, repo) {
  for (let page = 1; page <= 5; page += 1) {
    const issues = await githubApi(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100&page=${page}`
    );
    const incident = issues.find(issue =>
      !issue.pull_request && issue.title === INCIDENT_TITLE && String(issue.body || '').includes(INCIDENT_MARKER)
    );
    if (incident) return incident;
    if (issues.length < 100) break;
  }
  return null;
}

function supportsIssueNotifications(repository) {
  return repository?.has_issues !== false;
}

function appendNotificationSummary(message, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  fs.appendFileSync(
    summaryPath,
    `\n## 장애 알림\n\n${sanitizeMarkdownText(message)}\n`,
    'utf8'
  );
}

function addIssueComment(owner, repo, issueNumber, body) {
  return githubApi(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    { method: 'POST', body: { body } }
  );
}

async function run() {
  const repository = String(process.env.GITHUB_REPOSITORY || '');
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  const context = getFailureContext();
  const jobSucceeded = process.env.JOB_STATUS === 'success';
  const repositoryInfo = await githubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (!supportsIssueNotifications(repositoryInfo)) {
    const message = '저장소 Issues 기능이 비활성화되어 장애 이슈를 생성하지 않았습니다. 실행 Summary와 진단 아티팩트를 확인하세요.';
    appendNotificationSummary(message);
    return console.log(`automation status notification -> ${message}`);
  }
  const incident = await findOpenIncident(owner, repo);

  if (jobSucceeded) {
    if (!incident) return console.log('automation status notification -> no open incident to close');
    await addIssueComment(owner, repo, incident.number, buildRecoveryComment(context));
    await githubApi(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${incident.number}`,
      { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } }
    );
    return console.log(`automation status notification -> closed recovered incident #${incident.number}`);
  }

  if (!shouldNotifyFailure(context)) {
    return console.log(
      `automation status notification -> transient failure deferred to a later recovery attempt (${context.classification})`
    );
  }
  if (incident) {
    await addIssueComment(owner, repo, incident.number, buildFailureComment(context));
    return console.log(`automation status notification -> appended failure to incident #${incident.number}`);
  }
  const created = await githubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
    method: 'POST',
    body: { title: INCIDENT_TITLE, body: buildFailureBody(context) }
  });
  console.log(`automation status notification -> created incident #${created.number}`);
}

if (require.main === module) {
  run().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  appendNotificationSummary,
  findOpenIncident,
  getFailureContext,
  githubApi,
  readEventPayload,
  run,
  supportsIssueNotifications
};
