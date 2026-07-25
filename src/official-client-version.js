const { TextDecoder } = require('node:util');
const clientMetadata = require('./client-metadata');

const DEFAULT_SERVER_BASES = {
  jp: 'https://game.mahjongsoul.com/',
  en: 'https://mahjongsoul.game.yo-star.com/',
  kr: 'https://mahjongsoul.game.yo-star.com/kr/',
  cn: 'https://game.maj-soul.com/1/'
};
const MAX_OFFICIAL_ASSETS = 8;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const PATCH_STATE = Symbol.for('majsoul.officialClientVersionDiscovery');

function normalizeServerKey(value) {
  return String(value || 'jp').trim().toLowerCase();
}

function resolveOfficialBase(serverKey, overrideBase) {
  if (overrideBase) {
    return new URL(overrideBase).toString();
  }

  const key = normalizeServerKey(serverKey);
  const base = DEFAULT_SERVER_BASES[key];

  if (!base) {
    throw new Error(`Unsupported MS_SERVER "${serverKey}" for official client discovery`);
  }

  return base;
}

function addAssetUrl(urls, rawValue, baseUrl) {
  if (!rawValue || urls.length >= MAX_OFFICIAL_ASSETS) {
    return;
  }

  let resolved;

  try {
    resolved = new URL(String(rawValue).replace(/\\\//g, '/'), baseUrl);
  } catch {
    return;
  }

  const base = new URL(baseUrl);

  if (
    resolved.origin !== base.origin ||
    !/^https?:$/.test(resolved.protocol) ||
    !/\.(?:js|js\.txt)(?:$|[?#])/i.test(resolved.href) ||
    /\.framework\.js(?:\.gz)?(?:$|[?#])/i.test(resolved.href)
  ) {
    return;
  }

  const normalized = resolved.toString();

  if (!urls.includes(normalized)) {
    urls.push(normalized);
  }
}

function extractOfficialJavaScriptAssetUrls({ base, versionInfo = {}, indexHtml = '' }) {
  const baseUrl = new URL(base).toString();
  const urls = [];

  addAssetUrl(urls, versionInfo.code, baseUrl);

  for (const match of String(indexHtml).matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    addAssetUrl(urls, match[1], baseUrl);
  }

  for (const match of String(indexHtml).matchAll(
    /(?:loaderUrl|codeUrl|frameworkUrl)\s*[:=]\s*["']([^"']+)["']/gi
  )) {
    addAssetUrl(urls, match[1], baseUrl);
  }

  for (const match of String(indexHtml).matchAll(/["']([^"']*Build\/[^"']+\.loader\.js(?:\?[^"']*)?)["']/gi)) {
    addAssetUrl(urls, match[1], baseUrl);
  }

  return urls.slice(0, MAX_OFFICIAL_ASSETS);
}

async function readResponseTextLimited(response, maxBytes = MAX_ASSET_BYTES) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);

  if (declaredLength > maxBytes) {
    throw new Error(`official asset exceeds ${maxBytes} bytes`);
  }

  if (!response.body?.getReader) {
    const text = await response.text();

    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`official asset exceeds ${maxBytes} bytes`);
    }

    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    received += value.byteLength;

    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`official asset exceeds ${maxBytes} bytes`);
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

async function fetchOfficialText(url, {
  fetchImpl = global.fetch,
  maxBytes = MAX_ASSET_BYTES,
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable for official client discovery');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html,application/javascript,text/javascript,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`official asset request failed: ${response.status} ${url}`);
    }

    return readResponseTextLimited(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

function extractOfficialClientVersionPrefixes(text) {
  return [
    ...new Set(
      [...String(text || '').matchAll(/\b(WebGL_\d{4})-/g)]
        .map(match => match[1])
    )
  ];
}

function appendDiscoveredStrings(target, values, source, sources) {
  for (const value of values) {
    const normalized = clientMetadata.normalizeClientVersionString(value);

    if (!normalized || target.includes(normalized)) {
      continue;
    }

    target.push(normalized);
    sources[normalized] = source;
  }
}

async function discoverOfficialClientVersionStrings({
  base,
  versionInfo,
  indexHtml,
  fetchImpl = global.fetch,
  logger = console
}) {
  const strings = [];
  const sources = {};
  const assetUrls = extractOfficialJavaScriptAssetUrls({ base, versionInfo, indexHtml });
  let productVersion;

  try {
    productVersion = clientMetadata.parseProductVersion(indexHtml);
  } catch {
    productVersion = null;
  }

  const appendTextHints = (text, source) => {
    appendDiscoveredStrings(
      strings,
      clientMetadata.extractClientVersionStrings(text),
      source,
      sources
    );

    if (!productVersion) {
      return;
    }

    for (const prefix of extractOfficialClientVersionPrefixes(text)) {
      appendDiscoveredStrings(
        strings,
        [`${prefix}-${productVersion}`],
        `${source}#prefix+productVersion`,
        sources
      );
    }
  };

  appendTextHints(indexHtml, 'index.html');

  for (const assetUrl of assetUrls) {
    try {
      const text = await fetchOfficialText(assetUrl, { fetchImpl });
      appendTextHints(text, new URL(assetUrl).pathname);
    } catch (error) {
      logger.warn?.(`official client asset skipped (${assetUrl}): ${error?.message || error}`);
    }
  }

  return { strings, sources, assetUrls, productVersion };
}

function mergeDiscoveredClientVersionStrings(options = {}, discoveredStrings = []) {
  return {
    ...options,
    detectedClientVersionStrings: [
      ...discoveredStrings,
      ...(options.detectedClientVersionStrings || [])
    ]
  };
}

function installOfficialClientVersionStrings(discoveredStrings) {
  const normalized = [...new Set(
    discoveredStrings
      .map(clientMetadata.normalizeClientVersionString)
      .filter(Boolean)
  )];
  const existingState = clientMetadata[PATCH_STATE];

  if (existingState) {
    existingState.strings = normalized;
    return;
  }

  const original = clientMetadata.buildClientVersionStringCandidates;
  const state = { strings: normalized, original };

  clientMetadata.buildClientVersionStringCandidates = options => original(
    mergeDiscoveredClientVersionStrings(options, state.strings)
  );
  clientMetadata[PATCH_STATE] = state;
}

async function prepareOfficialClientVersionDiscovery({
  serverKey = process.env.MS_SERVER || 'jp',
  base,
  fetchImpl = global.fetch,
  logger = console
} = {}) {
  const resolvedBase = resolveOfficialBase(serverKey, base);
  const versionUrl = new URL('version.json', resolvedBase);
  versionUrl.searchParams.set('randv', String(Date.now()));
  const [versionText, indexHtml] = await Promise.all([
    fetchOfficialText(versionUrl, { fetchImpl, maxBytes: 256 * 1024 }),
    fetchOfficialText(new URL('index.html', resolvedBase), {
      fetchImpl,
      maxBytes: 2 * 1024 * 1024
    })
  ]);
  const versionInfo = JSON.parse(versionText);
  const discovery = await discoverOfficialClientVersionStrings({
    base: resolvedBase,
    versionInfo,
    indexHtml,
    fetchImpl,
    logger
  });

  installOfficialClientVersionStrings(discovery.strings);

  if (discovery.strings.length) {
    logger.log?.(
      `official client strings discovered -> ${discovery.strings.map(value => `${value} (${discovery.sources[value]})`).join(', ')}`
    );
  } else {
    logger.warn?.('no exact client_version_string found in official JavaScript assets; using generated recovery candidates');
  }

  return {
    ...discovery,
    base: resolvedBase,
    versionInfo
  };
}

module.exports = {
  DEFAULT_SERVER_BASES,
  discoverOfficialClientVersionStrings,
  extractOfficialClientVersionPrefixes,
  extractOfficialJavaScriptAssetUrls,
  fetchOfficialText,
  installOfficialClientVersionStrings,
  mergeDiscoveredClientVersionStrings,
  prepareOfficialClientVersionDiscovery,
  readResponseTextLimited,
  resolveOfficialBase
};
