const fs = require('node:fs');
const {
  WATCHDOG_SCHEDULE,
  decideAttendanceRun
} = require('../src/attendance-schedule');

function readMarker(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function splitRepository(value) {
  const [owner, repo, ...extra] = String(value || '').split('/');
  if (!owner || !repo || extra.length) throw new Error(`Invalid GITHUB_REPOSITORY: ${value}`);
  return { owner, repo };
}

async function dispatchAttendance({
  repository,
  token,
  ref = 'main',
  fetchImpl = global.fetch
}) {
  if (!token) throw new Error('GITHUB_TOKEN is required for watchdog dispatch');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for watchdog dispatch');
  const { owner, repo } = splitRepository(repository);
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/main.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'majsoul-attendance-watchdog',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref,
        inputs: {
          force: 'false'
        }
      }),
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Attendance watchdog dispatch failed: ${response.status} ${body.slice(0, 500)}`);
  }
  return response.status;
}

async function runCli(argv = process.argv.slice(2), env = process.env) {
  const markerPath = argv[0] || 'last-attendance-kst.txt';
  const now = env.ATTENDANCE_NOW ? new Date(env.ATTENDANCE_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid ATTENDANCE_NOW: ${env.ATTENDANCE_NOW}`);
  const decision = decideAttendanceRun({
    eventName: 'schedule',
    schedule: WATCHDOG_SCHEDULE,
    lastSuccess: readMarker(markerPath),
    now
  });
  if (!decision.shouldRun) {
    console.log(`attendance watchdog -> no dispatch (${decision.reason}, ${decision.today})`);
    return { ...decision, dispatched: false };
  }
  const status = await dispatchAttendance({
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    ref: 'main'
  });
  console.log(`attendance watchdog -> dispatched main.yml (${status}, ${decision.reason})`);
  return { ...decision, dispatched: true, status };
}

if (require.main === module) {
  runCli().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  dispatchAttendance,
  readMarker,
  runCli,
  splitRepository
};
