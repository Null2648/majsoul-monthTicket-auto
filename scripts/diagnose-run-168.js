const https = require('node:https');

function requestJson(url, token = process.env.GITHUB_TOKEN) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'majsoul-run-diagnostic',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      timeout: 15000
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub API ${response.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API timeout')));
    req.on('error', reject);
  });
}

async function run() {
  const repository = process.env.GITHUB_REPOSITORY || 'Null2648/majsoul-monthTicket-auto';
  const base = `https://api.github.com/repos/${repository}`;
  const listing = await requestJson(`${base}/actions/workflows/main.yml/runs?per_page=100`);
  const target = listing.workflow_runs.find(run => run.run_number === 168);
  if (!target) throw new Error('Login to Majsoul #168 was not found in the latest 100 runs');
  const jobs = await requestJson(`${base}/actions/runs/${target.id}/jobs?per_page=100`);
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
    html_url: target.html_url,
    jobs: jobs.jobs.map(job => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      steps: (job.steps || []).map(step => ({ name: step.name, conclusion: step.conclusion }))
    }))
  };
  console.log(JSON.stringify(report, null, 2));
}

run().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
