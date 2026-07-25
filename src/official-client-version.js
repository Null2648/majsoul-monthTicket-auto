const fs = require('node:fs');
const path = require('node:path');
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
const RESOURCE_VERSION_CACHE_PATH = path.join(process.cwd(), 'resource-version.json');

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

function findClientVersionTableReferences(text) {
  const references = [];
  const pattern = /function\s*\(\s*\)\s*\{\s*return\s+(\$[A-Za-z0-9_$]+)\[(\d+)\]\+[\s\S]{0,500}?\(\s*(['"])\.w\3\s*,\s*(['"])\4\s*\)\s*;?\s*\}/g;

  for (const match of String(text || '').matchAll(pattern)) {
    references.push({
      tableName: match[1],
      index: Number(match[2]),
      offset: match.index
    });
  }

  return references;
}

function extractJavaScriptArrayItem(source, arrayStart, targetIndex) {
  if (source[arrayStart] !== '[' || !Number.isInteger(targetIndex) || targetIndex < 0) {
    return null;
  }

  let itemIndex = 0;
  let itemStart = arrayStart + 1;
  let quote = null;
  let inRegex = false;
  let inRegexClass = false;
  let escaped = false;
  let nestedDepth = 0;

  for (let index = arrayStart + 1; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (inRegex) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (inRegexClass) {
        if (character === ']') {
          inRegexClass = false;
        }
      } else if (character === '[') {
        inRegexClass = true;
      } else if (character === '/') {
        inRegex = false;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }

    if (
      character === '/' &&
      source.slice(itemStart, index).trim() === ''
    ) {
      inRegex = true;
      continue;
    }

    if (character === '(' || character === '{' || character === '[') {
      nestedDepth += 1;
      continue;
    }

    if (character === ')' || character === '}') {
      nestedDepth -= 1;
      continue;
    }

    if (character === ']') {
      if (nestedDepth > 0) {
        nestedDepth -= 1;
        continue;
      }

      return itemIndex === targetIndex
        ? source.slice(itemStart, index).trim()
        : null;
    }

    if (character === ',' && nestedDepth === 0) {
      if (itemIndex === targetIndex) {
        return source.slice(itemStart, index).trim();
      }

      itemIndex += 1;
      itemStart = index + 1;
    }
  }

  return null;
}

function decodeJavaScriptStringLiteral(token) {
  const source = String(token || '').trim();
  const quote = source[0];

  if ((quote !== "'" && quote !== '"') || source.at(-1) !== quote) {
    return null;
  }

  let result = '';

  for (let index = 1; index < source.length - 1; index += 1) {
    const character = source[index];

    if (character !== '\\') {
      result += character;
      continue;
    }

    index += 1;
    const escape = source[index];

    if (escape === undefined) {
      return null;
    }

    const simpleEscapes = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '0': '\0',
      '\\': '\\',
      "'": "'",
      '"': '"'
    };

    if (Object.hasOwn(simpleEscapes, escape)) {
      result += simpleEscapes[escape];
      continue;
    }

    if (escape === '\n') {
      continue;
    }

    if (escape === '\r') {
      if (source[index + 1] === '\n') {
        index += 1;
      }
      continue;
    }

    if (escape === 'x') {
      const value = source.slice(index + 1, index + 3);

      if (!/^[0-9a-f]{2}$/i.test(value)) {
        return null;
      }

      result += String.fromCharCode(Number.parseInt(value, 16));
      index += 2;
      continue;
    }

    if (escape === 'u') {
      if (source[index + 1] === '{') {
        const end = source.indexOf('}', index + 2);
        const value = end === -1 ? '' : source.slice(index + 2, end);

        if (!/^[0-9a-f]{1,6}$/i.test(value)) {
          return null;
        }

        result += String.fromCodePoint(Number.parseInt(value, 16));
        index = end;
        continue;
      }

      const value = source.slice(index + 1, index + 5);

      if (!/^[0-9a-f]{4}$/i.test(value)) {
        return null;
      }

      result += String.fromCharCode(Number.parseInt(value, 16));
      index += 4;
      continue;
    }

    result += escape;
  }

  return result;
}

function resolveObfuscatedStringTableEntry(text, tableName, targetIndex) {
  const escapedTableName = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignmentPattern = /((?:\$[A-Za-z0-9_$]+\s*=\s*)+)\[/g;

  for (const match of String(text || '').matchAll(assignmentPattern)) {
    const aliases = [...match[1].matchAll(/\$[A-Za-z0-9_$]+/g)]
      .map(aliasMatch => aliasMatch[0]);

    if (!aliases.some(alias => new RegExp(`^${escapedTableName}$`).test(alias))) {
      continue;
    }

    const arrayStart = match.index + match[0].lastIndexOf('[');
    const token = extractJavaScriptArrayItem(text, arrayStart, targetIndex);
    const value = decodeJavaScriptStringLiteral(token);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

function extractComputedClientVersionStrings(text, resourceVersion) {
  const normalizedResourceVersion = clientMetadata.normalizeResourceVersion(resourceVersion);
  const results = [];

  if (!normalizedResourceVersion) {
    return results;
  }

  for (const reference of findClientVersionTableReferences(text)) {
    const prefix = resolveObfuscatedStringTableEntry(
      text,
      reference.tableName,
      reference.index
    );
    const value = clientMetadata.normalizeClientVersionString(
      `${prefix || ''}${normalizedResourceVersion}`
    );

    if (value && !results.some(result => result.value === value)) {
      results.push({
        value,
        tableName: reference.tableName,
        index: reference.index,
        prefix,
        offset: reference.offset
      });
    }
  }

  return results;
}

function readCurrentSuccessfulClientVersion({
  serverKey,
  versionInfo,
  indexHtml,
  cachePath = RESOURCE_VERSION_CACHE_PATH
}) {
  try {
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const productVersion = clientMetadata.parseProductVersion(indexHtml);
    const buildId = clientMetadata.parseUnityBuildId(indexHtml);
    const cachedClientVersionString = clientMetadata.normalizeClientVersionString(
      cache.clientVersionStrings?.[serverKey]
    );

    if (
      cache.sourceVersions?.[serverKey] !== versionInfo?.version ||
      cache.productVersions?.[serverKey] !== productVersion ||
      cache.buildIds?.[serverKey] !== buildId ||
      !cachedClientVersionString
    ) {
      return null;
    }

    return {
      clientVersionString: cachedClientVersionString,
      productVersion,
      buildId
    };
  } catch {
    return null;
  }
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
  const assets = [];
  const errors = [];
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

    for (const computed of extractComputedClientVersionStrings(text, versionInfo?.version)) {
      appendDiscoveredStrings(
        strings,
        [computed.value],
        `${source}#${computed.tableName}[${computed.index}]+resourceVersion`,
        sources
      );
    }

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
  assets.push({
    source: 'index.html',
    bytes: Buffer.byteLength(indexHtml, 'utf8'),
    strings: clientMetadata.extractClientVersionStrings(indexHtml),
    prefixes: extractOfficialClientVersionPrefixes(indexHtml)
  });

  for (const assetUrl of assetUrls) {
    try {
      const text = await fetchOfficialText(assetUrl, { fetchImpl });
      const source = new URL(assetUrl).pathname;
      const exactStrings = clientMetadata.extractClientVersionStrings(text);
      const prefixes = extractOfficialClientVersionPrefixes(text);
      assets.push({
        url: assetUrl,
        source,
        bytes: Buffer.byteLength(text, 'utf8'),
        strings: exactStrings,
        prefixes
      });
      appendTextHints(text, source);
    } catch (error) {
      const message = error?.message || String(error);
      errors.push({ url: assetUrl, message });
      logger.warn?.(`official client asset skipped (${assetUrl}): ${message}`);
    }
  }

  return { strings, sources, assetUrls, productVersion, assets, errors };
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
  logger = console,
  forceRefresh = false,
  cachePath = RESOURCE_VERSION_CACHE_PATH
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
  const normalizedServerKey = normalizeServerKey(serverKey);
  const cached = !forceRefresh
    ? readCurrentSuccessfulClientVersion({
        serverKey: normalizedServerKey,
        versionInfo,
        indexHtml,
        cachePath
      })
    : null;

  if (cached) {
    installOfficialClientVersionStrings([cached.clientVersionString]);
    logger.log?.(
      `official client metadata unchanged -> using successful cached string ${cached.clientVersionString}`
    );
    return {
      strings: [cached.clientVersionString],
      sources: { [cached.clientVersionString]: 'successful runtime cache' },
      assetUrls: [],
      assets: [],
      errors: [],
      productVersion: cached.productVersion,
      buildId: cached.buildId,
      base: resolvedBase,
      versionInfo,
      cacheHit: true
    };
  }

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
    versionInfo,
    cacheHit: false
  };
}

module.exports = {
  DEFAULT_SERVER_BASES,
  decodeJavaScriptStringLiteral,
  discoverOfficialClientVersionStrings,
  extractComputedClientVersionStrings,
  extractJavaScriptArrayItem,
  extractOfficialClientVersionPrefixes,
  extractOfficialJavaScriptAssetUrls,
  fetchOfficialText,
  findClientVersionTableReferences,
  installOfficialClientVersionStrings,
  mergeDiscoveredClientVersionStrings,
  prepareOfficialClientVersionDiscovery,
  readCurrentSuccessfulClientVersion,
  readResponseTextLimited,
  resolveObfuscatedStringTableEntry,
  resolveOfficialBase
};
