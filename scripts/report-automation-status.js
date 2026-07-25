const fs = require('node:fs');
const {
  AUTOMATION_FAILURE_REPORT_PATH,
  INCIDENT_MARKER,
  INCIDENT_TITLE,
  buildFailureBody,
  buildFailureComment,
  buildRecoveryComment,
  readJsonFile,
  sanitizeText,
  shouldNotifyFailure
} = require('../src/automation-alert');
const {
  PROTOCOL_REPORT_PATH
} = require('../src/protocol-monitor');

function readEventPayload(filePath = process.env.GITHUB_EVENT_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function getFailureContext() {
  const event = readEventPayload();
  const automationReport = readJsonFile(AUTOMATION_FAILURE_REPORT_PATH);
  const protocolReport = readJsonFile(PROTOCOL_REPORT_PATH);
  const protocolBreaking = Array.isArray(protocolReport?.breaking)
    ? protocolReport.breaking
    : [];
  const outcomes = {
    tests: process.env.TESTS_OUTCOME,
    jp: process.env.JP_OUTCOME,
    yostar: process.env.YOSTAR_OUTCOME,
    protocol: process.env.PROTOCOL_OUTCOME,
    automation: process.env.AUTOMATION_OUTCOME,
    cache: process.env.CACHE_OUTCOME
  };

  let classification = automationReport?.classification;
  if (protocolBreaking.length) classification = 'protocol-breaking';
  if (!classification && outcomes.jp === 'failure') classification = 'official-metadata';
  if (!classification && outcomes.yostar === 'failure') classification = 'yostar-metadata';
  if (!classification && outcomes.protocol === 'failure') classification = 'protocol-breaking';
  if (!classification && outcomes.tests === 'failure') classification = 'test-failure';
  if (!classification && outcomes.cache === 'failure') classification = 'cache-update';
  if (!classification) classification = 'runtime';

  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const lastSuccess = (() => {
    try {
      return fs.readFileSync('last-attendance-kst.txt', 'utf8').trim() || null;
    } catch {
      return null;
    }
  })();

  return {
    eventName: process.env.GITHUB_EVENT_NAME,
    schedule: event.schedule || '',
    classification,
    summary: sanitizeText(
      automationReport?.summary ||
      protocolBreaking[0] ||
      `Workflow job ended with status ${process.env.JOB_STATUS || 'unknown'}`
    ),
    protocolBreaking,
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
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${pathname} failed: ${response.status} ${sanitizeText(text)}`);
  }

  return payload;
}

async function findOpenIncident(owner, repo) {
  const issues = await githubApi(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100`
  );

  return issues.find(issue =>
    !issue.pull_request &&
    issue.title === INCIDENT_TITLE &&
    String(issue.body || '').includes(INCIDENT_MARKER)
  ) || null;
}

async function addIssueComment(owner, repo, issueNumber, body) {
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
  const incident = await findOpenIncident(owner, repo);

  if (jobSucceeded) {
    if (!incident) {
      console.log('automation status notification -> no open incident to close');
      return;
    }

    await addIssueComment(
      owner,
      repo,
      incident.number,
      buildRecoveryComment(context)
    );
    await githubApi(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${incident.number}`,
      { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } }
    );
    console.log(`automation status notification -> closed recovered incident #${incident.number}`);
    return;
  }

  if (!shouldNotifyFailure(context)) {
    console.log(
      `automation status notification -> primary transient failure deferred until fallback (${context.classification})`
    );
    return;
  }

  if (incident) {
    await addIssueComment(owner, repo, incident.number, buildFailureComment(context));
    console.log(`automation status notification -> appended failure to incident #${incident.number}`);
    return;
  }

  const created = await githubApi(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: 'POST',
      body: {
        title: INCIDENT_TITLE,
        body: buildFailureBody(context)
      }
    }
  );
  console.log(`automation status notification -> created incident #${created.number}`);
}

if (require.main === module) {
  run().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  findOpenIncident,
  getFailureContext,
  githubApi,
  readEventPayload,
  run
};
