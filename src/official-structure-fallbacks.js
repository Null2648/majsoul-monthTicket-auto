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
const RESOURCE_VERSION_CACHE_PATH = path.join(process.cwd(), 'resource-version.json');
const MAX_METADATA_ASSETS = 8;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const PATCH_STATE = Symbol.for('majsoul.officialStructureFallbacks');
const SYNTHETIC_LIQI_PREFIX = '__official_structure_liqi__';

function normalizeServerKey(value) {
  return String(value || 'jp').trim().toLowerCase();
}

function resolveOfficialBase(serverKey, overrideBase) {
  if (overrideBase) return new URL(overrideBase).toString();
  const key = normalizeServerKey(serverKey);
  const base = DEFAULT_SERVER_BASES[key];
  if (!base) throw new Error(`Unsupported MS_SERVER "${serverKey}" for official structure discovery`);
  return base;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeDottedVersion(value) {
  const match = String(value || '').match(/\b\d+\.\d+\.\d+\b/);
  return match?.[0] || null;
}

function extractProductVersion(source) {
  const text = typeof source === 'string' ? source : JSON.stringify(source || {});
  const patterns = [
    /(?:productVersion|product_version|product-version|unityProductVersion|packageVersion)\s*["']?\s*[:=]\s*["'](\d+\.\d+\.\d+)["']/i,
    /<meta[^>]+(?:name|property)=["'](?:productVersion|product-version|unity-version)["'][^>]+content=["'](\d+\.\d+\.\d+)["']/i,
    /<meta[^>]+content=["'](\d+\.\d+\.\d+)["'][^>]+(?:name|property)=["'](?:productVersion|product-version|unity-version)["']/i,
    /data-(?:product-version|unity-version)=["'](\d+\.\d+\.\d+)["']/i,
    /(?:WebGL|Unity|release)[-_](?:release[-_])?(\d+\.\d+\.\d+)(?:\(\d+\))?/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function stripAssetSuffix(value) {
  return String(value || '')
    .split(/[?#]/)[0]
    .replace(/\.(?:loader\.js|framework\.js|symbols\.json|data|wasm)(?:\.gz|\.br)?$/i, '');
}

function extractUnityBuildId(source) {
  const text = typeof source === 'string' ? source : JSON.stringify(source || {});
  const patterns = [
    /<script[^>]+src=["'][^"']*\/([^/"']+)\.loader\.js(?:[?#][^"']*)?["']/i,
    /(?:loaderUrl|dataUrl|frameworkUrl|codeUrl|symbolsUrl|buildUrl)\s*["']?\s*[:=]\s*["'][^"']*\/([^/"']+)\.(?:loader\.js|data|framework\.js|wasm|symbols\.json)(?:\.gz|\.br)?(?:[?#][^"']*)?["']/i,
    /["']([^"']*\/Build\/[^"']+\.(?:loader\.js|data|framework\.js|wasm|symbols\.json)(?:\.gz|\.br)?(?:[?#][^"']*)?)["']/i,
    /(?:buildId|build_id|buildName|build_name)\s*["']?\s*[:=]\s*["']([^"']+)["']/i
  ];

  for (let index = 0; index < patterns.length; index += 1) {
    const match = text.match(patterns[index]);
    if (!match?.[1]) continue;
    const value = index === 2 ? path.posix.basename(stripAssetSuffix(match[1])) : stripAssetSuffix(match[1]);
    if (value) return path.posix.basename(value);
  }

  return null;
}

function normalizeReference(rawValue, base) {
  if (!rawValue) return null;
  const cleaned = String(rawValue).trim().replace(/\\\//g, '/');
  if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return null;

  try {
    const resolved = new URL(cleaned, base);
    const official = new URL(base);
    if (!/^https?:$/.test(resolved.protocol) || resolved.origin !== official.origin) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function extractReferencedAssetUrls(source, base) {
  const text = typeof source === 'string' ? source : JSON.stringify(source || {});
  const values = [];
  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /(?:loaderUrl|dataUrl|frameworkUrl|codeUrl|symbolsUrl|configUrl|manifestUrl|resourceUrl|resVersionUrl|protoUrl|liqiUrl)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi,
    /["']([^"']+\.(?:json|js|js\.txt)(?:[?#][^"']*)?)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const resolved = normalizeReference(match[1], base);
      if (resolved) values.push(resolved);
    }
  }

  return unique(values);
}

function classifyReferenceUrls(urls) {
  const result = { configUrls: [], manifestUrls: [], liqiUrls: [], metadataUrls: [] };

  for (const rawUrl of unique(urls)) {
    const url = new URL(rawUrl);
    const pathname = url.pathname.toLowerCase();
    if (/liqi(?:\.min)?\.json$/.test(pathname)) result.liqiUrls.push(rawUrl);
    if (/(?:^|\/)(?:client[-_.]?)?config(?:uration)?[^/]*\.json$/.test(pathname) || /settings[^/]*\.json$/.test(pathname)) {
      result.configUrls.push(rawUrl);
    }
    if (/(?:resversion|resource[-_.]?version|resmanifest|manifest)[^/]*\.json$/.test(pathname)) {
      result.manifestUrls.push(rawUrl);
    }
    if (/\.(?:js|js\.txt|json)$/.test(pathname) && !/\.(?:framework\.js|wasm|data)(?:\.gz|\.br)?$/.test(pathname)) {
      result.metadataUrls.push(rawUrl);
    }
  }

  for (const key of Object.keys(result)) result[key] = unique(result[key]);
  return result;
}

function normalizeGatewayBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/\.(?:js|json|wasm|data|png|jpg|webp)(?:[?#]|$)/i.test(raw)) return null;

  try {
    let candidate = raw;
    if (/^wss?:\/\//i.test(candidate)) candidate = candidate.replace(/^ws/i, 'http');
    if (!/^https?:\/\//i.test(candidate) && /^[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(candidate)) {
      candidate = `https://${candidate}`;
    }
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function collectGatewayUrls(payload) {
  const candidates = [];
  const visit = (value, pathParts = []) => {
    const pathText = pathParts.join('.').toLowerCase();
    if (typeof value === 'string') {
      let score = 0;
      if (/clientgate|gateway/.test(pathText)) score += 100;
      if (/route|server|endpoint/.test(pathText)) score += 40;
      if (/(?:^|\.)(?:url|host|domain|address)$/.test(pathText)) score += 20;
      if (score <= 0) return;
      const url = normalizeGatewayBase(value);
      if (url) candidates.push({ url, score });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) visit(child, [...pathParts, key]);
  };

  visit(payload);
  return unique(candidates.sort((a, b) => b.score - a.score).map(candidate => candidate.url));
}

function normalizeGatewayConfig(payload, sourceUrl, state) {
  const expected = payload?.ip
    ?.flatMap(entry => Array.isArray(entry?.gateways) ? entry.gateways : [])
    .map(entry => normalizeGatewayBase(entry?.url))
    .filter(Boolean) || [];
  const discovered = unique([...expected, ...collectGatewayUrls(payload)]);
  if (!discovered.length) return null;

  if (state) state.gatewayUrls = unique([...(state.gatewayUrls || []), ...discovered]);
  if (expected.length) return payload;

  const normalized = isPlainObject(payload) ? { ...payload } : { source: payload };
  normalized.ip = [{
    source: sourceUrl,
    gateways: discovered.map((url, index) => ({ id: `discovered-${index + 1}`, url }))
  }];
  return normalized;
}

function resolveLiqiUrl(rawValue, sourceUrl) {
  const value = String(rawValue || '').replace(/\\\//g, '/').trim();
  if (!/liqi(?:\.min)?\.json/i.test(value)) return null;
  try {
    return new URL(value, sourceUrl).toString();
  } catch {
    return null;
  }
}

function extractLiqiUrls(payload, sourceUrl) {
  const urls = [];
  const visit = (value, pathParts = []) => {
    const pathText = pathParts.join('/');
    if (typeof value === 'string') {
      const direct = resolveLiqiUrl(value, sourceUrl);
      if (direct) urls.push(direct);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }
    if (!isPlainObject(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const nextPath = [...pathParts, key];
      if (/liqi(?:\.min)?\.json/i.test(key)) {
        if (typeof child === 'string') {
          const direct = resolveLiqiUrl(child, sourceUrl);
          if (direct) urls.push(direct);
        } else if (isPlainObject(child)) {
          for (const field of ['url', 'path', 'src', 'file']) {
            const direct = resolveLiqiUrl(child[field], sourceUrl);
            if (direct) urls.push(direct);
          }
          if (child.prefix) {
            const direct = resolveLiqiUrl(`${String(child.prefix).replace(/\/+$/, '')}/res/proto/liqi.json`, sourceUrl);
            if (direct) urls.push(direct);
          }
        }
      }
      visit(child, nextPath);
    }

    if (/liqi/i.test(pathText)) {
      for (const field of ['url', 'path', 'src', 'file']) {
        const direct = resolveLiqiUrl(value[field], sourceUrl);
        if (direct) urls.push(direct);
      }
    }
  };

  visit(payload);
  return unique(urls);
}

function deriveLiqiPrefix(liqiUrl, officialBase) {
  try {
    const resolved = new URL(liqiUrl);
    const base = new URL(officialBase);
    if (resolved.origin !== base.origin) return SYNTHETIC_LIQI_PREFIX;
    const marker = '/res/proto/liqi.json';
    const index = resolved.pathname.toLowerCase().indexOf(marker);
    if (index < 0) return SYNTHETIC_LIQI_PREFIX;
    return resolved.pathname.slice(0, index).replace(/^\/+/, '');
  } catch {
    return SYNTHETIC_LIQI_PREFIX;
  }
}

function normalizeResourceManifest(payload, sourceUrl, state) {
  const discovered = extractLiqiUrls(payload, sourceUrl);
  if (state) state.liqiUrls = unique([...(state.liqiUrls || []), ...discovered]);
  const all = unique([...(state?.liqiUrls || []), ...discovered]);
  if (!all.length) return null;

  const existing = payload?.res?.['res/proto/liqi.json'];
  if (existing?.prefix) return payload;

  const normalized = isPlainObject(payload) ? { ...payload } : { source: payload };
  normalized.res = { ...(isPlainObject(payload?.res) ? payload.res : {}) };
  normalized.res['res/proto/liqi.json'] = {
    ...(isPlainObject(existing) ? existing : {}),
    prefix: deriveLiqiPrefix(all[0], state?.base || sourceUrl)
  };
  return normalized;
}

function normalizeRouteDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const candidate = /^[a-z]+:\/\//i.test(raw) ? raw : `wss://${raw}`;
    return new URL(candidate).host || null;
  } catch {
    return null;
  }
}

function normalizeRouteItem(item, index) {
  if (typeof item === 'string') {
    const domain = normalizeRouteDomain(item);
    return domain ? { id: `discovered-${index + 1}`, domain } : null;
  }
  if (!isPlainObject(item)) return null;
  const id = item.id ?? item.route_id ?? item.routeId ?? item.name ?? item.key ?? `discovered-${index + 1}`;
  const domain = normalizeRouteDomain(
    item.domain ?? item.host ?? item.hostname ?? item.endpoint ?? item.url ?? item.address
  );
  return domain ? { ...item, id: String(id), domain } : null;
}

function collectRouteArrays(payload) {
  const arrays = [];
  const visit = (value, pathParts = []) => {
    if (Array.isArray(value)) {
      const pathText = pathParts.join('.').toLowerCase();
      if (/routes|servers|gateways|nodes|endpoints/.test(pathText)) arrays.push(value);
      value.forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) visit(child, [...pathParts, key]);
  };
  visit(payload);
  return arrays;
}

function normalizeRoutesPayload(payload) {
  const direct = Array.isArray(payload?.data?.routes) ? payload.data.routes : [];
  const arrays = direct.length ? [direct] : collectRouteArrays(payload);
  const routes = [];
  for (const array of arrays) {
    array.forEach((item, index) => {
      const route = normalizeRouteItem(item, routes.length + index);
      if (route && !routes.some(existing => existing.domain === route.domain)) routes.push(route);
    });
    if (routes.length) break;
  }
  if (!routes.length) return null;
  const normalized = isPlainObject(payload) ? { ...payload } : {};
  normalized.data = { ...(isPlainObject(payload?.data) ? payload.data : {}), routes };
  return normalized;
}

function readCache(cachePath = RESOURCE_VERSION_CACHE_PATH) {
  try {
    if (!fs.existsSync(cachePath)) return {};
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeStructureHint(serverKey, hint, cachePath = RESOURCE_VERSION_CACHE_PATH) {
  const cache = readCache(cachePath);
  const current = cache.structureHints?.[serverKey];
  if (JSON.stringify(current) === JSON.stringify(hint)) return;
  cache.structureHints = { ...(cache.structureHints || {}), [serverKey]: hint };
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function readResponseTextLimited(response, maxBytes = MAX_METADATA_BYTES) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw new Error(`official metadata asset exceeds ${maxBytes} bytes`);
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`official metadata asset exceeds ${maxBytes} bytes`);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`official metadata asset exceeds ${maxBytes} bytes`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

async function fetchText(url, { fetchImpl, maxBytes = MAX_METADATA_BYTES } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html,application/json,application/javascript,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`official structure request failed: ${response.status} ${url}`);
    return readResponseTextLimited(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

function buildStandardCandidates({ base, versionInfo = {}, version }) {
  const codeUrl = normalizeReference(versionInfo.code, base);
  const codeDirectory = codeUrl ? new URL('.', codeUrl).toString() : base;
  const configUrls = unique([
    new URL('config.json', codeDirectory).toString(),
    new URL('config.json', base).toString(),
    new URL('client-config.json', base).toString(),
    new URL('client_config.json', base).toString(),
    new URL('config/client.json', base).toString(),
    new URL('StreamingAssets/config.json', base).toString(),
    new URL('Build/config.json', base).toString()
  ]);
  const manifestNames = unique([
    `resversion${version}.json`,
    `resversion-${version}.json`,
    `resversion_${version}.json`,
    'resversion.json',
    'resmanifest.json',
    'resource-manifest.json',
    'manifest.json'
  ]);
  const manifestUrls = unique([
    ...manifestNames.map(name => new URL(name, base).toString()),
    ...manifestNames.map(name => new URL(name, codeDirectory).toString())
  ]);
  const liqiUrls = unique([
    new URL('res/proto/liqi.json', base).toString(),
    new URL('proto/liqi.json', base).toString(),
    new URL('assets/res/proto/liqi.json', base).toString(),
    new URL('StreamingAssets/res/proto/liqi.json', base).toString(),
    new URL('res/proto/liqi.json', codeDirectory).toString()
  ]);
  return { configUrls, manifestUrls, liqiUrls, codeUrl };
}

function responseFromText(original, text, contentType = 'application/json') {
  const headers = new Headers(original?.headers || {});
  headers.set('content-type', contentType);
  return new Response(text, {
    status: original?.status || 200,
    statusText: original?.statusText || 'OK',
    headers
  });
}

async function fetchNormalizedJson(requestedUrl, init, candidateUrls, normalize, state, label) {
  const candidates = unique([requestedUrl, ...candidateUrls]);
  let firstSuccessful = null;
  let lastResponse = null;

  for (const candidate of candidates) {
    let response;
    try {
      response = await state.originalFetch(candidate, init);
    } catch (error) {
      state.logger.warn?.(`${label} candidate failed (${candidate}): ${error?.message || error}`);
      continue;
    }
    lastResponse = response;
    if (!response.ok) continue;
    const text = await response.text();
    if (!firstSuccessful) firstSuccessful = { response, text };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const normalized = normalize(json, candidate, state);
    if (!normalized) continue;
    if (candidate !== requestedUrl) state.logger.log?.(`${label} fallback -> ${candidate}`);
    return responseFromText(response, JSON.stringify(normalized));
  }

  if (firstSuccessful) return responseFromText(firstSuccessful.response, firstSuccessful.text);
  return lastResponse || state.originalFetch(requestedUrl, init);
}

function buildRouteCandidateUrls(requestedUrl, state) {
  const requested = new URL(requestedUrl);
  const bases = unique([
    `${requested.protocol}//${requested.host}${requested.pathname.replace(/\/api\/clientgate\/routes\/?$/i, '')}`,
    ...(state.gatewayUrls || [])
  ]);
  const paths = ['/api/clientgate/routes', '/clientgate/routes', '/api/clientgate/route', '/api/routes', '/routes'];
  return unique(bases.flatMap(base => paths.map(routePath => `${base.replace(/\/+$/, '')}${routePath}${requested.search}`)));
}

function createStructureFetchWrapper(state) {
  return async function structureAwareFetch(input, init = {}) {
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    if (method !== 'GET') return state.originalFetch(input, init);
    const requestedUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    let url;
    try {
      url = new URL(requestedUrl);
    } catch {
      return state.originalFetch(input, init);
    }
    const pathname = url.pathname.toLowerCase();

    if (/(?:^|\/)config(?:uration)?\.json$/.test(pathname)) {
      return fetchNormalizedJson(requestedUrl, init, state.configUrls, normalizeGatewayConfig, state, 'gateway config');
    }
    if (/(?:resversion|resource[-_.]?version|resmanifest|manifest)[^/]*\.json$/.test(pathname)) {
      return fetchNormalizedJson(requestedUrl, init, state.manifestUrls, normalizeResourceManifest, state, 'resource manifest');
    }
    if (/\/(?:res\/proto\/)?liqi(?:\.min)?\.json$/.test(pathname)) {
      return fetchNormalizedJson(
        requestedUrl,
        init,
        state.liqiUrls,
        json => isPlainObject(json?.nested) || isPlainObject(json?.options) ? json : null,
        state,
        'liqi protocol'
      );
    }
    if (/\/api\/clientgate\/routes\/?$/.test(pathname)) {
      return fetchNormalizedJson(
        requestedUrl,
        init,
        buildRouteCandidateUrls(requestedUrl, state),
        normalizeRoutesPayload,
        state,
        'gateway routes'
      );
    }
    return state.originalFetch(input, init);
  };
}

function installMetadataParserFallbacks(state) {
  const existing = clientMetadata[PATCH_STATE];
  if (existing) {
    existing.state.productVersion = state.productVersion;
    existing.state.buildId = state.buildId;
    return;
  }
  const originalProduct = clientMetadata.parseProductVersion;
  const originalBuild = clientMetadata.parseUnityBuildId;
  const shared = { productVersion: state.productVersion, buildId: state.buildId };
  clientMetadata.parseProductVersion = source => {
    const discovered = extractProductVersion(source) || shared.productVersion;
    if (discovered) return discovered;
    return originalProduct(source);
  };
  clientMetadata.parseUnityBuildId = source => {
    const discovered = extractUnityBuildId(source) || shared.buildId;
    if (discovered) return discovered;
    return originalBuild(source);
  };
  clientMetadata[PATCH_STATE] = { state: shared, originalProduct, originalBuild };
}

function installStructureFetchFallbacks(state) {
  const globalState = globalThis[PATCH_STATE];
  if (globalState?.fetchInstalled) {
    Object.assign(globalState, state, { originalFetch: globalState.originalFetch });
    return globalState;
  }
  const installed = { ...state, originalFetch: state.originalFetch || global.fetch, fetchInstalled: true };
  if (typeof installed.originalFetch !== 'function') throw new Error('fetch is unavailable for official structure fallbacks');
  global.fetch = createStructureFetchWrapper(installed);
  globalThis[PATCH_STATE] = installed;
  return installed;
}

async function prepareOfficialStructureFallbacks({
  serverKey = process.env.MS_SERVER || 'jp',
  base,
  fetchImpl = global.fetch,
  logger = console,
  forceRefresh = false,
  cachePath = RESOURCE_VERSION_CACHE_PATH
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for official structure discovery');
  const key = normalizeServerKey(serverKey);
  const resolvedBase = resolveOfficialBase(key, base);
  const versionUrl = new URL('version.json', resolvedBase);
  versionUrl.searchParams.set('randv', String(Date.now()));
  const [versionText, indexHtml] = await Promise.all([
    fetchText(versionUrl, { fetchImpl, maxBytes: 256 * 1024 }),
    fetchText(new URL('index.html', resolvedBase), { fetchImpl, maxBytes: 2 * 1024 * 1024 })
  ]);
  const versionInfo = JSON.parse(versionText);
  const version = String(versionInfo.version || '').trim();
  if (!version) throw new Error('official version.json did not contain version');

  const cache = readCache(cachePath);
  const cachedHint = cache.structureHints?.[key];
  const hintCurrent = cachedHint?.sourceVersion === version;
  let referencedUrls = unique([
    ...extractReferencedAssetUrls(indexHtml, resolvedBase),
    ...extractReferencedAssetUrls(versionInfo, resolvedBase)
  ]);
  let productVersion = extractProductVersion(indexHtml) || extractProductVersion(versionInfo) || (hintCurrent ? cachedHint.productVersion : null);
  let buildId = extractUnityBuildId(indexHtml) || extractUnityBuildId(versionInfo) || (hintCurrent ? cachedHint.buildId : null);
  const standards = buildStandardCandidates({ base: resolvedBase, versionInfo, version });
  const initialClassified = classifyReferenceUrls(referencedUrls);
  let configUrls = unique([...(hintCurrent ? cachedHint.configUrls || [] : []), ...initialClassified.configUrls, ...standards.configUrls]);
  let manifestUrls = unique([...(hintCurrent ? cachedHint.manifestUrls || [] : []), ...initialClassified.manifestUrls, ...standards.manifestUrls]);
  let liqiUrls = unique([...(hintCurrent ? cachedHint.liqiUrls || [] : []), ...initialClassified.liqiUrls, ...standards.liqiUrls]);

  const shouldScanAssets = forceRefresh || !hintCurrent || !productVersion || !buildId;
  if (shouldScanAssets) {
    const metadataUrls = unique([
      standards.codeUrl,
      ...initialClassified.metadataUrls
    ]).filter(url => !/\.(?:framework\.js|wasm|data)(?:\.gz|\.br)?(?:[?#]|$)/i.test(url));

    for (const assetUrl of metadataUrls.slice(0, MAX_METADATA_ASSETS)) {
      try {
        const text = await fetchText(assetUrl, { fetchImpl });
        referencedUrls = unique([...referencedUrls, ...extractReferencedAssetUrls(text, resolvedBase)]);
        productVersion ||= extractProductVersion(text);
        buildId ||= extractUnityBuildId(text);
      } catch (error) {
        logger.warn?.(`official structure asset skipped (${assetUrl}): ${error?.message || error}`);
      }
    }

    const classified = classifyReferenceUrls(referencedUrls);
    configUrls = unique([...classified.configUrls, ...configUrls]);
    manifestUrls = unique([...classified.manifestUrls, ...manifestUrls]);
    liqiUrls = unique([...classified.liqiUrls, ...liqiUrls]);
  }

  productVersion ||= normalizeDottedVersion(versionInfo.productVersion || versionInfo.packageVersion);
  if (!buildId) {
    const codeUrl = standards.codeUrl;
    buildId = codeUrl ? `code-${path.posix.basename(new URL(codeUrl).pathname)}` : `resource-${version}`;
  }
  if (!productVersion) throw new Error('Unable to discover Unity productVersion from official metadata sources');

  const state = {
    serverKey: key,
    base: resolvedBase,
    version,
    versionInfo,
    productVersion,
    buildId,
    configUrls,
    manifestUrls,
    liqiUrls,
    gatewayUrls: [],
    logger,
    originalFetch: fetchImpl
  };
  installMetadataParserFallbacks(state);
  const installed = installStructureFetchFallbacks(state);

  const hint = {
    sourceVersion: version,
    productVersion,
    buildId,
    configUrls: configUrls.slice(0, 16),
    manifestUrls: manifestUrls.slice(0, 16),
    liqiUrls: liqiUrls.slice(0, 16)
  };
  writeStructureHint(key, hint, cachePath);
  logger.log?.(
    `official structure -> product=${productVersion} build=${buildId} ` +
    `config_candidates=${configUrls.length} manifest_candidates=${manifestUrls.length} liqi_candidates=${liqiUrls.length}`
  );

  return { ...installed, hint };
}

module.exports = {
  DEFAULT_SERVER_BASES,
  SYNTHETIC_LIQI_PREFIX,
  buildRouteCandidateUrls,
  buildStandardCandidates,
  classifyReferenceUrls,
  collectGatewayUrls,
  createStructureFetchWrapper,
  deriveLiqiPrefix,
  extractLiqiUrls,
  extractProductVersion,
  extractReferencedAssetUrls,
  extractUnityBuildId,
  installMetadataParserFallbacks,
  normalizeGatewayConfig,
  normalizeResourceManifest,
  normalizeRoutesPayload,
  prepareOfficialStructureFallbacks,
  readResponseTextLimited,
  resolveOfficialBase
};
