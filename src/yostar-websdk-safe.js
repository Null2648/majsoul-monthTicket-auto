const base = require('./yostar-websdk');
const hardened = require('./yostar-websdk-hardened');
const {
  mergeWebSdkMetadataCandidates
} = require('./yostar-websdk-parser');
const {
  isUnsafeNetworkHostname
} = require('./network-hardening');

function normalizeCredentialHost(value, { strictOfficial = false } = {}) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (isUnsafeNetworkHostname(url.hostname)) return null;
    if (!strictOfficial && !hardened.TRUSTED_STRUCTURAL_SUFFIXES.some(
      suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
    )) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function hardenWebSdkMetadataCandidates(candidates = [], { limit = Infinity } = {}) {
  const result = [];
  const seen = new Set();
  const sorted = [...candidates].sort(
    (a, b) => hardened.strategyRank(a?.strategy) - hardened.strategyRank(b?.strategy)
  );
  for (const candidate of sorted) {
    const strategy = String(candidate?.strategy || '');
    const strictOfficial = strategy.includes('strict-config');
    const hosts = [...new Set(
      (candidate?.hosts || [])
        .map(host => normalizeCredentialHost(host, { strictOfficial }))
        .filter(Boolean)
    )].slice(0, hardened.MAX_HOSTS_PER_CANDIDATE);
    const pid = String(candidate?.pid || '').trim();
    if (!hosts.length || !pid || !candidate?.version || !candidate?.signingSecret) continue;
    const normalized = { ...candidate, pid, hosts };
    const key = hardened.candidateKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

async function loadOfficialWebSdkMetadataCandidates(gameBase) {
  const discovered = await hardened.loadOfficialWebSdkMetadataCandidates(gameBase);
  const candidates = hardenWebSdkMetadataCandidates(discovered, {
    limit: hardened.MAX_OFFICIAL_CANDIDATES
  });
  if (!candidates.length) {
    throw new Error('Official YoStar WebSDK metadata contained no safe public HTTPS destination');
  }
  return candidates;
}

async function loadOfficialWebSdkMetadata(gameBase) {
  return (await loadOfficialWebSdkMetadataCandidates(gameBase))[0];
}

async function refreshYostarCredentials(options) {
  const refreshKey = hardened.refreshAttemptKey(options);
  const recentFailure = hardened.getRecentRefreshFailure(refreshKey);
  if (recentFailure) throw recentFailure;

  const deadlineAt = Date.now() + hardened.REFRESH_BUDGET_MS;
  const attempted = new Set();
  let lastError;
  const cachedCandidates = hardenWebSdkMetadataCandidates(
    mergeWebSdkMetadataCandidates({ cachedMetadata: options.metadata }),
    { limit: 1 }
  );

  const attemptCandidates = async candidates => {
    for (const candidate of candidates) {
      const key = hardened.candidateKey(candidate);
      if (attempted.has(key)) continue;
      attempted.add(key);
      if (Date.now() >= deadlineAt) return null;
      console.log(
        `trying safe YoStar WebSDK metadata -> version=${candidate.version} ` +
        `strategy=${candidate.strategy} routes=${candidate.hosts.length}`
      );
      try {
        return await hardened.tryCandidate(options, candidate, deadlineAt);
      } catch (error) {
        if (error?.yostarCode === 100403) throw error;
        lastError = error;
      }
    }
    return null;
  };

  const cachedResult = await attemptCandidates(cachedCandidates);
  if (cachedResult) return cachedResult;

  let officialCandidates;
  try {
    officialCandidates = await loadOfficialWebSdkMetadataCandidates(options.gameBase);
  } catch (error) {
    throw hardened.rememberRefreshFailure(refreshKey, error);
  }
  const officialResult = await attemptCandidates(officialCandidates);
  if (officialResult) return officialResult;

  if (Date.now() >= deadlineAt) {
    const error = new Error(
      `YoStar WebSDK credential refresh exceeded ${hardened.REFRESH_BUDGET_MS / 1000}s ` +
      `after ${attempted.size} safe candidates`
    );
    error.code = 'YOSTAR_REFRESH_TIMEOUT';
    throw hardened.rememberRefreshFailure(refreshKey, error);
  }
  throw hardened.rememberRefreshFailure(
    refreshKey,
    lastError || new Error('All safe bounded YoStar WebSDK metadata candidates failed')
  );
}

module.exports = {
  ...base,
  ...hardened,
  hardenWebSdkMetadataCandidates,
  loadOfficialWebSdkMetadata,
  loadOfficialWebSdkMetadataCandidates,
  normalizeCredentialHost,
  refreshYostarCredentials
};