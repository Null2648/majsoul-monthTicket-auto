const { Buffer } = require('node:buffer');

const FETCH_GUARD_STATE = Symbol.for('majsoul.networkMetadataGuard');
const FETCH_SCOPE_STATE = Symbol.for('majsoul.structureFetchScope');
const DEFAULT_TIMEOUT_MS = 15000;

function requestUrl(input) {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(String(input));
    if (input?.url) return new URL(input.url);
  } catch {
    return null;
  }
  return null;
}

function responseLimit(url, method = 'GET') {
  if (!url) return null;
  const pathname = url.pathname.toLowerCase();
  if (method === 'POST' && /\/user\/quick-login\/?$/.test(pathname)) return 1024 * 1024;
  if (method !== 'GET') return null;
  if (/\/version\.json$/.test(pathname)) return 512 * 1024;
  if (/\/index\.html$/.test(pathname)) return 4 * 1024 * 1024;
  if (/liqi(?:\.min)?\.json$/.test(pathname)) return 24 * 1024 * 1024;
  if (/(?:resversion|resource[-_.]?version|resmanifest|manifest)[^/]*\.json$/.test(pathname)) {
    return 32 * 1024 * 1024;
  }
  if (/(?:^|\/)(?:client[-_.]?)?config(?:uration)?[^/]*\.json$/.test(pathname)) {
    return 4 * 1024 * 1024;
  }
  if (/\/api\/clientgate\/routes\/?$/.test(pathname) || /\/(?:clientgate\/routes|api\/routes|routes)\/?$/.test(pathname)) {
    return 4 * 1024 * 1024;
  }
  if (/\/streamingassets\/webgl\/yostarsdk\/(?:config\.json|index\.js\.txt)$/.test(pathname)) {
    return pathname.endsWith('config.json') ? 2 * 1024 * 1024 : 24 * 1024 * 1024;
  }
  if (/\.(?:js|js\.txt)$/.test(pathname) && /(?:build|code|loader|yostarsdk)/.test(pathname)) {
    return 24 * 1024 * 1024;
  }
  return null;
}

async function readBodyLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`network metadata response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  if (!response.body.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`network metadata response exceeds ${maxBytes} bytes`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`network metadata response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, received);
}

function rebuildResponse(response, body) {
  const noBodyStatus = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(noBodyStatus ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  });
}

function installGlobalMetadataFetchGuard({ fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const existing = globalThis[FETCH_GUARD_STATE];
  if (existing) return existing;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for network hardening');

  const guardedFetch = async (input, init = {}) => {
    const url = requestUrl(input);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const maxBytes = responseLimit(url, method);
    if (!maxBytes) return fetchImpl(input, init);

    const response = await fetchImpl(input, {
      ...init,
      signal: init.signal || AbortSignal.timeout(timeoutMs)
    });
    const body = await readBodyLimited(response, maxBytes);
    return rebuildResponse(response, body);
  };

  const state = { originalFetch: fetchImpl, guardedFetch, timeoutMs };
  global.fetch = guardedFetch;
  globalThis[FETCH_GUARD_STATE] = state;
  return state;
}

function originsFrom(values = []) {
  const origins = new Set();
  for (const value of values) {
    try { origins.add(new URL(value).origin); } catch { /* ignore invalid hints */ }
  }
  return origins;
}

function isMetadataPath(pathname) {
  const path = String(pathname || '').toLowerCase();
  return /(?:^|\/)config(?:uration)?\.json$/.test(path) ||
    /(?:resversion|resource[-_.]?version|resmanifest|manifest)[^/]*\.json$/.test(path) ||
    /\/(?:res\/proto\/)?liqi(?:\.min)?\.json$/.test(path);
}

function isRoutePath(pathname) {
  return /\/(?:api\/clientgate\/routes|clientgate\/routes|api\/clientgate\/route|api\/routes|routes)\/?$/i
    .test(String(pathname || ''));
}

function scopeStructureFetch(structure) {
  if (!structure || typeof global.fetch !== 'function' || typeof structure.originalFetch !== 'function') {
    return null;
  }
  const previous = globalThis[FETCH_SCOPE_STATE];
  if (previous?.structureFetch === global.fetch) return previous;

  const structureFetch = global.fetch;
  const directFetch = structure.originalFetch;
  const metadataOrigins = originsFrom([
    structure.base,
    ...(structure.configUrls || []),
    ...(structure.manifestUrls || []),
    ...(structure.liqiUrls || [])
  ]);

  const scopedFetch = (input, init = {}) => {
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const url = requestUrl(input);
    if (method === 'GET' && url) {
      if (isMetadataPath(url.pathname) && !metadataOrigins.has(url.origin)) {
        return directFetch(input, init);
      }
      if (isRoutePath(url.pathname)) {
        const routeOrigins = originsFrom([structure.base, ...(structure.gatewayUrls || [])]);
        if (!routeOrigins.has(url.origin)) return directFetch(input, init);
      }
    }
    return structureFetch(input, init);
  };

  const state = { structureFetch, directFetch, scopedFetch, metadataOrigins, structure };
  global.fetch = scopedFetch;
  globalThis[FETCH_SCOPE_STATE] = state;
  return state;
}

module.exports = {
  FETCH_GUARD_STATE,
  FETCH_SCOPE_STATE,
  installGlobalMetadataFetchGuard,
  isMetadataPath,
  isRoutePath,
  readBodyLimited,
  requestUrl,
  responseLimit,
  scopeStructureFetch
};
