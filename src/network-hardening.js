const { Buffer } = require('node:buffer');
const net = require('node:net');

const FETCH_GUARD_STATE = Symbol.for('majsoul.networkMetadataGuard');
const FETCH_SCOPE_STATE = Symbol.for('majsoul.structureFetchScope');
const DEFAULT_TIMEOUT_MS = 15000;
const PRIMITIVE_PROTO_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64',
  'bool', 'string', 'bytes'
]);

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

function jsonStructureBudget(url) {
  const pathname = String(url?.pathname || '').toLowerCase();
  if (/liqi(?:\.min)?\.json$/.test(pathname)) {
    return { maxDepth: 128, maxNodes: 1500000, maxCollection: 500000, protocolDepth: 128 };
  }
  if (/(?:resversion|resource[-_.]?version|resmanifest|manifest)[^/]*\.json$/.test(pathname)) {
    return { maxDepth: 80, maxNodes: 1500000, maxCollection: 500000 };
  }
  if (
    /(?:^|\/)(?:client[-_.]?)?config(?:uration)?[^/]*\.json$/.test(pathname) ||
    /\/streamingassets\/webgl\/yostarsdk\/config\.json$/.test(pathname) ||
    /\/(?:api\/clientgate\/routes|clientgate\/routes|api\/clientgate\/route|api\/routes|routes)\/?$/.test(pathname)
  ) {
    return { maxDepth: 48, maxNodes: 150000, maxCollection: 50000 };
  }
  return null;
}

function assertBoundedJsonValue(value, budget) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > budget.maxNodes) {
      throw new Error(`network JSON structure exceeds ${budget.maxNodes} nodes`);
    }
    if (current.depth > budget.maxDepth) {
      throw new Error(`network JSON structure exceeds depth ${budget.maxDepth}`);
    }
    if (!current.value || typeof current.value !== 'object') continue;

    const entries = Array.isArray(current.value)
      ? current.value.map((item, index) => [String(index), item])
      : Object.entries(current.value);
    if (entries.length > budget.maxCollection) {
      throw new Error(`network JSON collection exceeds ${budget.maxCollection} entries`);
    }

    for (const [key, child] of entries) {
      if (key === '__proto__' || key === 'prototype') {
        throw new Error(`network JSON contains forbidden key ${key}`);
      }
      if (child && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function normalizeProtoTypeName(value) {
  return String(value || '').trim().replace(/^\./, '');
}

function namespaceOf(value) {
  const parts = normalizeProtoTypeName(value).split('.');
  parts.pop();
  return parts.join('.');
}

function assertBoundedProtocolReferences(root, maxDepth = 128) {
  if (!root?.nested) return;
  const types = new Map();
  const pending = [{ node: root, prefix: '' }];

  while (pending.length) {
    const { node, prefix } = pending.pop();
    for (const [name, child] of Object.entries(node?.nested || {})) {
      const fullName = prefix ? `${prefix}.${name}` : name;
      if (child?.fields) types.set(fullName, child);
      if (child?.nested) pending.push({ node: child, prefix: fullName });
    }
  }

  const edges = new Map();
  for (const [owner, node] of types) {
    const ownerNamespace = namespaceOf(owner);
    const topNamespace = ownerNamespace.split('.')[0];
    const values = [];
    for (const field of Object.values(node.fields || {})) {
      const raw = normalizeProtoTypeName(field?.type);
      if (!raw || PRIMITIVE_PROTO_TYPES.has(raw)) continue;
      const candidates = raw.includes('.')
        ? [raw]
        : [ownerNamespace && `${ownerNamespace}.${raw}`, topNamespace && `${topNamespace}.${raw}`, raw].filter(Boolean);
      const resolved = candidates.find(candidate => types.has(candidate));
      if (resolved && !values.includes(resolved)) values.push(resolved);
    }
    edges.set(owner, values);
  }

  let transitions = 0;
  const maxTransitions = Math.max(200000, types.size * 256);
  for (const start of types.keys()) {
    const stack = [{ name: start, depth: 1, path: new Set([start]) }];
    while (stack.length) {
      const current = stack.pop();
      if (current.depth > maxDepth) {
        throw new Error(`protocol message reference chain exceeds depth ${maxDepth}`);
      }
      for (const next of edges.get(current.name) || []) {
        transitions += 1;
        if (transitions > maxTransitions) {
          throw new Error(`protocol message graph exceeds ${maxTransitions} traversal transitions`);
        }
        if (current.path.has(next)) continue;
        const path = new Set(current.path);
        path.add(next);
        stack.push({ name: next, depth: current.depth + 1, path });
      }
    }
  }
}

function assertBoundedJsonBody(body, url) {
  const budget = jsonStructureBudget(url);
  if (!budget || !body?.length) return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return;
  }
  assertBoundedJsonValue(parsed, budget);
  if (budget.protocolDepth) assertBoundedProtocolReferences(parsed, budget.protocolDepth);
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

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isUnsafeIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isUnsafeIpv6(address) {
  const host = normalizeHostname(address);
  if (host === '::' || host === '::1') return true;
  if (/^(?:fc|fd)/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host)) return true;
  if (/^2001:db8(?::|$)/.test(host)) return true;
  const mapped = host.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? isUnsafeIpv4(mapped[1]) : false;
}

function isUnsafeNetworkHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host.endsWith('.home.arpa') ||
    host.endsWith('.invalid') || host.endsWith('.test') || host.endsWith('.example')
  ) return true;
  const family = net.isIP(host);
  if (family === 4) return isUnsafeIpv4(host);
  if (family === 6) return isUnsafeIpv6(host);
  return false;
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
    assertBoundedJsonBody(body, url);
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
  assertBoundedJsonBody,
  assertBoundedJsonValue,
  assertBoundedProtocolReferences,
  installGlobalMetadataFetchGuard,
  isMetadataPath,
  isRoutePath,
  isUnsafeNetworkHostname,
  jsonStructureBudget,
  normalizeHostname,
  readBodyLimited,
  requestUrl,
  responseLimit,
  scopeStructureFetch
};