const fs = require('node:fs');

const HEADERS = token => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'majsoul-run-diagnostic',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {})
});

async function requestJson(url, token = process.env.GITHUB_TOKEN) {
  const response = await fetch(url, {
    headers: HEADERS(token),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function requestText(url, token = process.env.GITHUB_TOKEN) {
  const response = await fetch(url, {
    headers: HEADERS(token),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub logs API ${response.status}: ${text.slice(0, 500)}`);
  return text;
}

function usefulLogLines(text) {
  const lines = text.split(/\r?\n/);
  const matched = lines.filter(line =>
    /cancel|timed? out|timeout|error|failed|gateway route|trying resource|oauth2|month.?ticket|protocol/i.test(line)
  );
  return [...matched.slice(-120), ...lines.slice(-40)]
    .map(line => line.replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, '[REDACTED]').slice(0, 500))
    .filter((line, index, array) => line && array.indexOf(line) === index)
    .slice(-160);
}

async function run() {
  const repository = process.env.GITHUB_REPOSITORY || 'Null2648/majsoul-monthTicket-auto';
  const token = process.env.GITHUB_TOKEN;
  const base = `https://api.github.com/repos/${repository}`;
  const listing = await requestJson(`${base}/actions/workflows/main.yml/runs?per_page=100`, token);
  const target = listing.workflow_runs.find(item => item.run_number === 168);
  if (!target) throw new Error('Login to Majsoul #168 was not found in the latest 100 runs');
  const jobs = await requestJson(`${base}/actions/runs/${target.id}/jobs?per_page=100`, token);
  const attendance = jobs.jobs.find(job => job.name === 'attendance');
  const jobLog = attendance
    ? await requestText(`${base}/actions/jobs/${attendance.id}/logs`, token).catch(error => `log fetch failed: ${error.message}`)
    : '';
  const report = {
    id: target.id,
    run_number: target.run_number,
    event: target.event,
    status: target.status,
    conclusion: target.conclusion,
    head_branch: target.head_branch,
    head_sha: target.head_sha,
    actor: target.actor?.login,
    created_at: target.created_at,
    run_started_at: target.run_started_at,
    updated_at: target.updated_at,
    html_url: target.html_url,
    jobs: jobs.jobs.map(job => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      steps: (job.steps || []).map(step => ({
        name: step.name,
        conclusion: step.conclusion,
        started_at: step.started_at,
        completed_at: step.completed_at
      }))
    })),
    relevant_log_tail: usefulLogLines(jobLog)
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync('run-168-diagnostic.json', serialized, 'utf8');
  console.log(serialized);
}

run().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
