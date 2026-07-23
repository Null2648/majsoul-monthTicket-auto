const DEFAULT_RESOURCE_VERSION = '0.16.193';
const DEFAULT_FORWARD_SCAN_LIMIT = 128;
const DEFAULT_NEXT_MINOR_SCAN_LIMIT = 32;
const DEFAULT_BACKWARD_SCAN_LIMIT = 16;

function parseProductVersion(html) {
  const match = String(html || '').match(/productVersion\s*:\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new Error('Unity productVersion not found in index.html');
  }
  return match[1];
}

function parseUnityBuildId(html) {
  const source = String(html || '');
  const loaderMatch = source.match(
    /<script[^>]+src=["'][^"']*Build\/([^"']+)\.loader\.js(?:\?[^"']*)?["']/i
  );
  const assetMatch = source.match(
    /(?:data|framework|code|symbols)Url\s*:\s*["'][^"']*\/([^/"']+)\.(?:data|framework\.js|wasm|symbols\.json)\.gz(?:\?[^"']*)?["']/i
  );
  const buildId = loaderMatch?.[1] || assetMatch?.[1];

  if (!buildId) {
    throw new Error('Unity build identifier not found in index.html');
  }

  return buildId;
}

function normalizeResourceVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^WebGL_\d{4}-/, '')
    .replace(/^web-/, '')
    .replace(/^v/, '')
    .replace(/\.w$/, '');
}

function normalizeClientVersionString(value) {
  const normalized = String(value || '').trim();

  return /^(?:WebGL_\d{4}|web)-\d+\.\d+\.\d+$/.test(normalized)
    ? normalized
    : null;
}

function buildWebClientVersionString(resourceVersion) {
  const normalized = normalizeResourceVersion(resourceVersion);

  if (!parseResourceVersion(normalized)) {
    throw new Error('A dotted resource version is required for the web client');
  }

  return `web-${normalized}`;
}

function buildUnityWebGLClientVersionString(productVersion) {
  const normalized = normalizeResourceVersion(productVersion);

  if (!parseResourceVersion(normalized)) {
    throw new Error('A dotted Unity product version is required for the WebGL client');
  }

  return `WebGL_2022-${normalized}`;
}

function extractClientVersionStrings(text) {
  return [
    ...new Set(
      [...String(text || '').matchAll(/\b(?:WebGL_\d{4}|web)-\d+\.\d+\.\d+\b/g)]
        .map(match => match[0])
    )
  ];
}

function parseResourceVersion(value) {
  const normalized = normalizeResourceVersion(value);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);

  if (!match) {
    return null;
  }

  return match.slice(1).map(Number);
}

function formatResourceVersion(parts) {
  return parts.join('.');
}

function compareResourceVersions(a, b) {
  const parsedA = parseResourceVersion(a);
  const parsedB = parseResourceVersion(b);

  if (!parsedA || !parsedB) {
    return String(a).localeCompare(String(b));
  }

  for (let index = 0; index < parsedA.length; index += 1) {
    if (parsedA[index] !== parsedB[index]) {
      return parsedA[index] - parsedB[index];
    }
  }

  return 0;
}

function buildResourceVersionCandidates({
  overrideResourceVersion,
  detectedResourceVersion,
  cachedResourceVersion,
  defaultResourceVersion = DEFAULT_RESOURCE_VERSION,
  forwardScanLimit = DEFAULT_FORWARD_SCAN_LIMIT,
  nextMinorScanLimit = DEFAULT_NEXT_MINOR_SCAN_LIMIT,
  backwardScanLimit = DEFAULT_BACKWARD_SCAN_LIMIT
} = {}) {
  const candidates = [];
  const addCandidate = value => {
    const normalized = normalizeResourceVersion(value);

    if (parseResourceVersion(normalized) && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const knownVersions = [
    overrideResourceVersion,
    detectedResourceVersion,
    cachedResourceVersion
  ];

  knownVersions.forEach(addCandidate);

  if (!candidates.length) {
    addCandidate(defaultResourceVersion);
  }

  const scanBase = [...knownVersions, ...candidates]
    .map(normalizeResourceVersion)
    .filter(parseResourceVersion)
    .sort(compareResourceVersions)
    .at(-1);
  const parsedBase = parseResourceVersion(scanBase);

  if (!parsedBase) {
    return candidates;
  }

  const [major, minor, patch] = parsedBase;

  const firstForwardScanLimit = Math.min(forwardScanLimit, 32);

  for (let offset = 1; offset <= firstForwardScanLimit; offset += 1) {
    addCandidate(formatResourceVersion([major, minor, patch + offset]));
  }

  for (let nextPatch = 0; nextPatch <= nextMinorScanLimit; nextPatch += 1) {
    addCandidate(formatResourceVersion([major, minor + 1, nextPatch]));
  }

  for (let offset = firstForwardScanLimit + 1; offset <= forwardScanLimit; offset += 1) {
    addCandidate(formatResourceVersion([major, minor, patch + offset]));
  }

  for (let offset = 1; offset <= backwardScanLimit && patch - offset >= 0; offset += 1) {
    addCandidate(formatResourceVersion([major, minor, patch - offset]));
  }

  return candidates;
}

function buildClientVersionStringCandidates({
  overrideClientVersionString,
  detectedClientVersionStrings = [],
  cachedClientVersionString,
  resourceVersionCandidates = [],
  webResourceVersion,
  preferCachedClientVersion = false
} = {}) {
  const candidates = [];
  const addCandidate = value => {
    const normalized = normalizeClientVersionString(value);

    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  addCandidate(overrideClientVersionString);

  if (preferCachedClientVersion) {
    addCandidate(cachedClientVersionString);
  }

  detectedClientVersionStrings.forEach(addCandidate);

  if (webResourceVersion) {
    addCandidate(`web-${normalizeResourceVersion(webResourceVersion)}`);
  }

  if (!preferCachedClientVersion) {
    addCandidate(cachedClientVersionString);
  }

  resourceVersionCandidates.forEach(resourceVersion => {
    addCandidate(`WebGL_2022-${normalizeResourceVersion(resourceVersion)}`);
  });

  return candidates;
}

function buildClientMetadata({
  productVersion,
  resourceVersion = DEFAULT_RESOURCE_VERSION,
  clientVersionString
}) {
  if (!productVersion) {
    throw new Error('productVersion is required');
  }

  const resolvedClientVersionString =
    normalizeClientVersionString(clientVersionString) ||
    buildUnityWebGLClientVersionString(resourceVersion);
  const isWebClient = resolvedClientVersionString.startsWith('web-');
  const clientStringResourceVersion = normalizeResourceVersion(resolvedClientVersionString);
  const providedResourceVersion = String(resourceVersion || '')
    .trim()
    .replace(/^v/, '');
  const resolvedResourceVersion = isWebClient
    ? normalizeResourceVersion(providedResourceVersion) === clientStringResourceVersion
      ? providedResourceVersion
      : `${clientStringResourceVersion}.w`
    : clientStringResourceVersion;

  if (!resolvedResourceVersion) {
    throw new Error('resourceVersion is required');
  }

  const clientVersion = {
    resource: resolvedResourceVersion
  };

  if (!isWebClient) {
    clientVersion.package = productVersion;
  }

  return {
    routeVersion: productVersion,
    clientVersion,
    clientVersionString: resolvedClientVersionString
  };
}

function buildOauth2AuthPayload({ oauthType, token, uid, clientVersionString }) {
  return {
    type: oauthType,
    code: token,
    uid,
    client_version_string: clientVersionString
  };
}

function buildOauth2LoginPayload({
  oauthType,
  accessToken,
  device,
  randomKey,
  clientVersion,
  clientVersionString,
  currencyPlatforms,
  tag
}) {
  return {
    type: oauthType,
    access_token: accessToken,
    reconnect: false,
    device,
    random_key: randomKey,
    client_version: clientVersion,
    client_version_string: clientVersionString,
    currency_platforms: currencyPlatforms,
    tag
  };
}

function buildPasswordLoginPayload({
  account,
  password,
  device,
  randomKey,
  clientVersion,
  clientVersionString,
  currencyPlatforms,
  loginType,
  tag
}) {
  return {
    account,
    password,
    reconnect: false,
    device,
    random_key: randomKey,
    client_version: clientVersion,
    gen_access_token: true,
    currency_platforms: currencyPlatforms,
    type: loginType,
    client_version_string: clientVersionString,
    tag
  };
}

module.exports = {
  DEFAULT_RESOURCE_VERSION,
  buildClientMetadata,
  buildClientVersionStringCandidates,
  buildResourceVersionCandidates,
  buildOauth2AuthPayload,
  buildOauth2LoginPayload,
  buildPasswordLoginPayload,
  buildUnityWebGLClientVersionString,
  buildWebClientVersionString,
  extractClientVersionStrings,
  normalizeClientVersionString,
  normalizeResourceVersion,
  parseResourceVersion,
  parseProductVersion,
  parseUnityBuildId
};
