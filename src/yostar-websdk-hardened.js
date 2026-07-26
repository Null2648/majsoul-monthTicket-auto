const original = require('./yostar-websdk');
const {
  mergeWebSdkMetadataCandidates,
  parseJpSdkConfigCandidates,
  parseWebSdkRuntimeCandidates
} = require('./yostar-websdk-parser');

const WEBSDK_CONFIG_PATH = 'StreamingAssets/WebGL/YoStarSDK/config.json';
const WEBSDK_SCRIPT_PATH = 'StreamingAssets/WebGL/YoStarSDK/index.js.txt';
const MAX_OFFICIAL_CANDIDATES = 4;
const MAX_HOSTS_PER_CANDIDATE = 2;
const QUICK_LOGIN_TIMEOUT_MS = 8000;
const REFRESH_BUDGET_MS = 60000;
const TRUSTED_STRUCTURAL_SUFFIXES = [
  'yostar.net',
  'yo-star.com',
  'mahjongsoul.com',
  'maj-soul.com'
];

function buildUrl(base, pathname) {
  return `${String(base).replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^(?:127|10|0)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  return false;
}

function isTrustedSuffix(hostname) {
  const host = String(hostname || '').toLowerCase();
  return TRUSTED_STRUCTURAL_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

function normalizeCredentialHost(value, { strictOfficial = false } = {}) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || isPrivateHostname(url.hostname)) return null;
    if (!strictOfficial && !isTrustedSuffix(url.hostname)) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function candidateKey(candidate) {
  return [
    String(candidate?.pid || ''),
    String(candidate?.version || ''),
    String(candidate?.signingSecret || ''),
    (candidate?.hosts || []).join(',')
  ].join('\u0000');
}

function strategyRank(strategy) {
  const value = String(strategy || '');
  if (value.includes('strict-config+strict-regex')) return 0;
  if (value.includes('strict-config+partial-ast')) return 1;
  if (value.includes('structural-config+strict-regex')) return 2;
  if (value.includes('structural-config+partial-ast')) return 3;
  return 4;
}

function hardenWebSdkMetadataCandidates(candidates = [], { limit = Infinity } = {}) {
  const result = [];
  const seen = new Set();
  const sorted = [...candidates].sort((a, b) => strategyRank(a?.strategy) - strategyRank(b?.strategy));
  for (const candidate of sorted) {
    const strategy = String(candidate?.strategy || '');
    const strictOfficial = strategy.includes('strict-config');
    const hosts = [...new Set(
      (candidate?.hosts || [])
        .map(host => normalizeCredentialHost(host, { strictOfficial }))
        .filter(Boolean)
    )].slice(0, MAX_HOSTS_PER_CANDIDATE);
    const pid = String(candidate?.pid || '').trim();
    if (!hosts.length || !pid || !candidate?.version || !candidate?.signingSecret) continue;
    const normalized = { ...candidate, pid, hosts };
    const key = candidateKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { Accept: '*/*', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`YoStar WebSDK request failed: ${response.status} ${url}`);
  return response.text();
}

async function loadOfficialWebSdkMetadataCandidates(gameBase) {
  const [configText, script] = await Promise.all([
    fetchText(buildUrl(gameBase, WEBSDK_CONFIG_PATH)),
    fetchText(buildUrl(gameBase, WEBSDK_SCRIPT_PATH))
  ]);
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    throw new Error('YoStar WebSDK config is not valid JSON');
  }
  const configCandidates = parseJpSdkConfigCandidates(config);
  const runtimeCandidates = parseWebSdkRuntimeCandidates(script);
  const candidates = hardenWebSdkMetadataCandidates(
    mergeWebSdkMetadataCandidates({ configCandidates, runtimeCandidates }),
    { limit: MAX_OFFICIAL_CANDIDATES }
  );
  if (!candidates.length) {
    throw new Error(
      `No trusted HTTPS YoStar WebSDK metadata candidate is available ` +
      `(config=${configCandidates.length}, runtime=${runtimeCandidates.length})`
    );
  }
  console.log(
    `trusted YoStar WebSDK metadata candidates -> ${candidates
      .map(candidate => `${candidate.version}:${candidate.strategy}`)
      .join(', ')}`
  );
  return candidates;
}

async function loadOfficialWebSdkMetadata(gameBase) {
  return (await loadOfficialWebSdkMetadataCandidates(gameBase))[0];
}

function remainingTimeout(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const error = new Error('YoStar WebSDK credential refresh exceeded its total time budget');
    error.code = 'YOSTAR_REFRESH_TIMEOUT';
    throw error;
  }
  return Math.max(1, Math.min(QUICK_LOGIN_TIMEOUT_MS, remaining));
}

async function tryCandidate(options, candidate, deadlineAt) {
  const resolvedDeviceId = options.deviceId || original.createStableDeviceId(options.uid, options.token);
  const errors = [];
  for (const host of candidate.hosts.slice(0, MAX_HOSTS_PER_CANDIDATE)) {
    const authorization = original.buildAuthorization({
      uid: options.uid,
      token: options.token,
      deviceId: resolvedDeviceId,
      pid: candidate.pid,
      sdkVersion: candidate.version,
      signingSecret: candidate.signingSecret,
      unixTime: Math.floor(Date.now() / 1000)
    });
    try {
      const response = await fetch(buildUrl(host, 'user/quick-login'), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: JSON.stringify(authorization),
          'Content-Type': 'application/json',
          Origin: 'https://game.mahjongsoul.com',
          Referer: 'https://game.mahjongsoul.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
        },
        body: '{}',
        signal: AbortSignal.timeout(remainingTimeout(deadlineAt))
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`YoStar WebSDK returned non-JSON HTTP ${response.status}`);
      }
      const result = original.extractQuickLoginResult(json);
      if (result.uid !== String(options.uid)) {
        throw new Error('YoStar WebSDK quick login returned a different account UID');
      }
      return {
        uid: String(options.uid),
        token: String(options.token),
        responseUid: result.uid,
        responseToken: result.token,
        deviceId: resolvedDeviceId,
        metadata: candidate
      };
    } catch (error) {
      if (error?.yostarCode === 100403) throw error;
      errors.push(`${new URL(host).host}: ${error?.message || error}`);
    }
  }
  throw new Error(
    `YoStar WebSDK candidate failed (${candidate.version}:${candidate.strategy}): ${errors.join('; ')}`
  );
}

async function refreshYostarCredentials(options) {
  const deadlineAt = Date.now() + REFRESH_BUDGET_MS;
  const attempted = new Set();
  let lastError;

  const cachedCandidates = hardenWebSdkMetadataCandidates(
    mergeWebSdkMetadataCandidates({ cachedMetadata: options.metadata }),
    { limit: 1 }
  );
  const attemptCandidates = async candidates => {
    for (const candidate of candidates) {
      const key = candidateKey(candidate);
      if (attempted.has(key)) continue;
      attempted.add(key);
      if (Date.now() >= deadlineAt) return null;
      console.log(
        `trying YoStar WebSDK metadata -> version=${candidate.version} ` +
        `strategy=${candidate.strategy} routes=${candidate.hosts.length}`
      );
      try {
        return await tryCandidate(options, candidate, deadlineAt);
      } catch (error) {
        if (error?.yostarCode === 100403) throw error;
        lastError = error;
      }
    }
    return null;
  };

  const cachedResult = await attemptCandidates(cachedCandidates);
  if (cachedResult) return cachedResult;

  const officialCandidates = await loadOfficialWebSdkMetadataCandidates(options.gameBase);
  const officialResult = await attemptCandidates(officialCandidates);
  if (officialResult) return officialResult;

  if (Date.now() >= deadlineAt) {
    const timeout = new Error(
      `YoStar WebSDK credential refresh exceeded ${REFRESH_BUDGET_MS / 1000}s after ${attempted.size} candidates`
    );
    timeout.code = 'YOSTAR_REFRESH_TIMEOUT';
    throw timeout;
  }
  throw lastError || new Error('All bounded YoStar WebSDK metadata candidates failed');
}

module.exports = {
  ...original,
  MAX_HOSTS_PER_CANDIDATE,
  MAX_OFFICIAL_CANDIDATES,
  QUICK_LOGIN_TIMEOUT_MS,
  REFRESH_BUDGET_MS,
  TRUSTED_STRUCTURAL_SUFFIXES,
  candidateKey,
  hardenWebSdkMetadataCandidates,
  isPrivateHostname,
  loadOfficialWebSdkMetadata,
  loadOfficialWebSdkMetadataCandidates,
  normalizeCredentialHost,
  refreshYostarCredentials,
  strategyRank,
  tryCandidate
};
