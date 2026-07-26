const base = require('./yostar-websdk');
const hardened = require('./yostar-websdk-hardened');
const {
  mergeWebSdkMetadataCandidates
} = require('./yostar-websdk-parser');
const {
  isUnsafeNetworkHostname
} = require('./network-hardening');

function isTrustedCredentialDomain(hostname) {
  const host = String(hostname || '').toLowerCase();
  return hardened.TRUSTED_STRUCTURAL_SUFFIXES.some(
    suffix => host === suffix || host.endsWith(`.${suffix}`)
  );
}

function normalizeCredentialHost(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (isUnsafeNetworkHostname(url.hostname) || !isTrustedCredentialDomain(url.hostname)) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function observedHostnames(candidates = []) {
  const values = [];
  for (const candidate of candidates) {
    for (const host of candidate?.hosts || []) {
      try {
        const hostname = new URL(String(host)).hostname.toLowerCase();
        if (hostname && !values.includes(hostname)) values.push(hostname);
      } catch { /* invalid values remain excluded */ }
    }
  }
  return values.slice(0, 16);
}

function hardenWebSdkMetadataCandidates(candidates = [], { limit = Infinity } = {}) {
  const result = [];
  const seen = new Set();
  const sorted = [...candidates].sort(
    (a, b) => hardened.strategyRank(a?.strategy) - hardened.strategyRank(b?.strategy)
  );
  for (const candidate of sorted) {
    const hosts = [...new Set(
      (candidate?.hosts || [])
        .map(host => normalizeCredentialHost(host))
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
    const error = new Error(
      'Official YoStar WebSDK metadata contained no HTTPS destination in the reviewed service domains'
    );
    error.code = 'YOSTAR_HOST_NOT_REVIEWED';
    error.observedHostnames = observedHostnames(discovered);
    throw error;
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
  isTrustedCredentialDomain,
  loadOfficialWebSdkMetadata,
  loadOfficialWebSdkMetadataCandidates,
  normalizeCredentialHost,
  observedHostnames,
  refreshYostarCredentials
};