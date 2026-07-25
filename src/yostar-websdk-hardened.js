const original = require('./yostar-websdk');
const {
  mergeWebSdkMetadataCandidates,
  parseJpSdkConfigCandidates,
  parseWebSdkRuntimeCandidates
} = require('./yostar-websdk-parser');

const WEBSDK_CONFIG_PATH = 'StreamingAssets/WebGL/YoStarSDK/config.json';
const WEBSDK_SCRIPT_PATH = 'StreamingAssets/WebGL/YoStarSDK/index.js.txt';
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

function hardenWebSdkMetadataCandidates(candidates = []) {
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const strategy = String(candidate?.strategy || '');
    const strictOfficial = strategy.includes('strict-config');
    const hosts = [...new Set(
      (candidate?.hosts || [])
        .map(host => normalizeCredentialHost(host, { strictOfficial }))
        .filter(Boolean)
    )];
    const pid = String(candidate?.pid || '').trim();
    if (!hosts.length || !pid || !candidate?.version || !candidate?.signingSecret) continue;
    const key = `${pid}\u0000${candidate.version}\u0000${candidate.signingSecret}\u0000${hosts.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...candidate, hosts });
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
    mergeWebSdkMetadataCandidates({ configCandidates, runtimeCandidates })
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

async function tryCandidate(options, candidate) {
  return original.refreshYostarCredentials({ ...options, metadata: candidate });
}

async function refreshYostarCredentials(options) {
  const cachedCandidates = hardenWebSdkMetadataCandidates(
    mergeWebSdkMetadataCandidates({ cachedMetadata: options.metadata })
  );
  let lastError;

  for (const candidate of cachedCandidates) {
    try {
      return await tryCandidate(options, candidate);
    } catch (error) {
      if (error?.yostarCode === 100403) throw error;
      lastError = error;
    }
  }

  const officialCandidates = await loadOfficialWebSdkMetadataCandidates(options.gameBase);
  for (const candidate of officialCandidates) {
    try {
      return await tryCandidate(options, candidate);
    } catch (error) {
      if (error?.yostarCode === 100403) throw error;
      lastError = error;
    }
  }

  throw lastError || new Error('All trusted YoStar WebSDK metadata candidates failed');
}

module.exports = {
  ...original,
  TRUSTED_STRUCTURAL_SUFFIXES,
  hardenWebSdkMetadataCandidates,
  isPrivateHostname,
  loadOfficialWebSdkMetadata,
  loadOfficialWebSdkMetadataCandidates,
  normalizeCredentialHost,
  refreshYostarCredentials
};
