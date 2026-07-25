const fs = require('node:fs');
const { createHash } = require('node:crypto');
const legacy = require('./protocol-monitor');

const {
  PROTOCOL_BASELINE_PATH,
  PROTOCOL_PENDING_PATH,
  PROTOCOL_REPORT_PATH,
  RPC_CONTRACTS
} = legacy;
const SNAPSHOT_SCHEMA_VERSION = 2;
const PRIMITIVE_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64',
  'bool', 'string', 'bytes'
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashJson(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function normalizeFullName(value) {
  return String(value || '').trim().replace(/^\./, '');
}

function namespaceOf(fullName) {
  const parts = normalizeFullName(fullName).split('.');
  parts.pop();
  return parts.join('.');
}

function getNestedNode(root, fullName) {
  let node = root;
  for (const part of normalizeFullName(fullName).split('.').filter(Boolean)) {
    node = node?.nested?.[part];
    if (!node) return null;
  }
  return node;
}

function resolveTypeName(root, ownerName, rawType) {
  const type = normalizeFullName(rawType);
  if (!type || PRIMITIVE_TYPES.has(type)) return type;
  if (type.includes('.') && getNestedNode(root, type)) return type;
  const ownerNamespace = namespaceOf(ownerName);
  const candidates = [];
  if (ownerNamespace) candidates.push(`${ownerNamespace}.${type}`);
  const topNamespace = ownerNamespace.split('.')[0];
  if (topNamespace) candidates.push(`${topNamespace}.${type}`);
  candidates.push(type);
  return candidates.find(candidate => getNestedNode(root, candidate)) || type;
}

function normalizeFieldDescriptor(root, ownerType, fieldName, field) {
  return {
    ownerType: normalizeFullName(ownerType),
    name: fieldName,
    id: Number(field.id),
    type: resolveTypeName(root, ownerType, field.type),
    rule: field.rule || 'optional',
    keyType: field.keyType || null
  };
}

function resolveFieldPath(root, startType, dottedPath) {
  const segments = String(dottedPath).split('.').filter(Boolean);
  const chain = [];
  let ownerType = normalizeFullName(startType);
  for (let index = 0; index < segments.length; index += 1) {
    const fieldName = segments[index];
    const field = getNestedNode(root, ownerType)?.fields?.[fieldName];
    if (!field) throw new Error(`Protocol field ${ownerType}.${fieldName} is missing while resolving ${dottedPath}`);
    const descriptor = normalizeFieldDescriptor(root, ownerType, fieldName, field);
    chain.push(descriptor);
    if (index < segments.length - 1) {
      if (!descriptor.type || PRIMITIVE_TYPES.has(descriptor.type) || !getNestedNode(root, descriptor.type)) {
        throw new Error(`Protocol field ${ownerType}.${fieldName} is not a message while resolving ${dottedPath}`);
      }
      ownerType = descriptor.type;
    }
  }
  return chain;
}

function collectRequiredRequestPaths(root, requestType) {
  const result = [];
  function visit(typeName, prefix = '', recursionStack = new Set()) {
    const normalizedType = normalizeFullName(typeName);
    if (recursionStack.has(normalizedType)) return;
    const node = getNestedNode(root, normalizedType);
    if (!node?.fields) return;
    const nextStack = new Set(recursionStack);
    nextStack.add(normalizedType);
    for (const [fieldName, field] of Object.entries(node.fields)) {
      const fieldPath = prefix ? `${prefix}.${fieldName}` : fieldName;
      const descriptor = normalizeFieldDescriptor(root, normalizedType, fieldName, field);
      if (descriptor.rule === 'required') result.push({ path: fieldPath, descriptor });
      if (!PRIMITIVE_TYPES.has(descriptor.type) && getNestedNode(root, descriptor.type)) {
        visit(descriptor.type, fieldPath, nextStack);
      }
    }
  }
  visit(requestType);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyKnownProtocolCompatibility(root) {
  const patches = [];
  const requestConnection = getNestedNode(root, 'lq.ReqRequestConnection');
  if (requestConnection?.fields && !requestConnection.fields.platform) {
    requestConnection.fields.platform = { type: 'string', id: 6 };
    patches.push({
      path: 'lq.ReqRequestConnection.platform',
      reason: 'legacy Web route compatibility',
      injected: { type: 'string', id: 6, rule: 'optional' }
    });
  }
  return patches;
}

function buildRpcSnapshot(root, contract) {
  const service = getNestedNode(root, contract.service);
  const method = service?.methods?.[contract.method];
  if (!method) throw new Error(`Required RPC .${contract.service}.${contract.method} is missing`);
  const namespace = namespaceOf(contract.service);
  const requestType = resolveTypeName(root, `${namespace}.Service`, method.requestType);
  const responseType = resolveTypeName(root, `${namespace}.Service`, method.responseType);
  if (!getNestedNode(root, requestType)) throw new Error(`Request type ${requestType} for .${contract.service}.${contract.method} is missing`);
  if (!getNestedNode(root, responseType)) throw new Error(`Response type ${responseType} for .${contract.service}.${contract.method} is missing`);
  return {
    service: contract.service,
    method: contract.method,
    requestType,
    responseType,
    requestStream: Boolean(method.requestStream),
    responseStream: Boolean(method.responseStream),
    requestPaths: Object.fromEntries(
      contract.requestPaths.map(fieldPath => [fieldPath, resolveFieldPath(root, requestType, fieldPath)])
    ),
    responsePaths: Object.fromEntries(
      contract.responsePaths.map(fieldPath => [fieldPath, resolveFieldPath(root, responseType, fieldPath)])
    ),
    requiredRequestPaths: collectRequiredRequestPaths(root, requestType)
  };
}

function buildProtocolSnapshot(liqiJson, { sourceVersion = null } = {}) {
  if (!liqiJson?.nested) throw new Error('Unexpected liqi.json structure: nested root is missing');
  const rawProtocolHash = hashJson(liqiJson);
  const compatibleRoot = deepClone(liqiJson);
  const compatibilityPatches = applyKnownProtocolCompatibility(compatibleRoot);
  const rpcs = Object.fromEntries(RPC_CONTRACTS.map(contract => {
    const key = `${contract.service}.${contract.method}`;
    return [key, buildRpcSnapshot(compatibleRoot, contract)];
  }));
  const contract = { rpcs, compatibilityPatches };
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sourceVersion,
    protocolHash: rawProtocolHash,
    contractHash: hashJson(contract),
    compatibilityPatches,
    rpcs
  };
}

function descriptorEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function comparePathMaps(previous, current, label, breaking) {
  for (const [fieldPath, previousChain] of Object.entries(previous || {})) {
    const currentChain = current?.[fieldPath];
    if (!currentChain) breaking.push(`${label} field path removed: ${fieldPath}`);
    else if (!descriptorEqual(previousChain, currentChain)) breaking.push(`${label} field path changed: ${fieldPath}`);
  }
}

function compareRequiredPaths(previous, current, label, breaking, warnings) {
  const previousMap = new Map((previous || []).map(item => [item.path, item.descriptor]));
  const currentMap = new Map((current || []).map(item => [item.path, item.descriptor]));
  for (const [fieldPath, descriptor] of currentMap) {
    if (!previousMap.has(fieldPath)) breaking.push(`${label} added required request field: ${fieldPath}`);
    else if (!descriptorEqual(previousMap.get(fieldPath), descriptor)) breaking.push(`${label} changed required request field: ${fieldPath}`);
  }
  for (const fieldPath of previousMap.keys()) {
    if (!currentMap.has(fieldPath)) warnings.push(`${label} removed required request field: ${fieldPath}`);
  }
}

function compareProtocolSnapshots(previous, current) {
  const breaking = [];
  const warnings = [];
  if (!previous) {
    return {
      breaking,
      warnings: ['Protocol baseline is missing; the current contract will become the baseline after a successful attendance run.'],
      changed: true
    };
  }
  if (![1, SNAPSHOT_SCHEMA_VERSION].includes(previous.schemaVersion)) {
    breaking.push(`Unsupported protocol baseline schema: ${previous.schemaVersion}`);
  } else if (previous.schemaVersion === 1) {
    warnings.push('Protocol baseline schema 1 will be upgraded after the next successful attendance run.');
  }

  for (const [key, currentRpc] of Object.entries(current.rpcs || {})) {
    const previousRpc = previous.rpcs?.[key];
    if (!previousRpc) {
      warnings.push(`New monitored RPC added to baseline: .${key}`);
      continue;
    }
    for (const property of ['requestType', 'responseType', 'requestStream', 'responseStream']) {
      if (previousRpc[property] !== currentRpc[property]) {
        breaking.push(`RPC .${key} ${property} changed: ${previousRpc[property]} -> ${currentRpc[property]}`);
      }
    }
    comparePathMaps(previousRpc.requestPaths, currentRpc.requestPaths, `RPC .${key} request`, breaking);
    comparePathMaps(previousRpc.responsePaths, currentRpc.responsePaths, `RPC .${key} response`, breaking);
    compareRequiredPaths(previousRpc.requiredRequestPaths, currentRpc.requiredRequestPaths, `RPC .${key}`, breaking, warnings);
  }
  for (const key of Object.keys(previous.rpcs || {})) {
    if (!current.rpcs?.[key]) breaking.push(`Required RPC removed: .${key}`);
  }

  if (previous.schemaVersion >= 2 && !descriptorEqual(previous.compatibilityPatches || [], current.compatibilityPatches || [])) {
    breaking.push('Known protocol compatibility patches changed; manual review is required.');
  }
  if (previous.protocolHash !== current.protocolHash) {
    warnings.push(
      previous.contractHash === current.contractHash
        ? 'liqi.json changed outside the attendance contract; attendance may continue.'
        : 'liqi.json and the monitored attendance contract changed.'
    );
  }
  return {
    breaking: [...new Set(breaking)],
    warnings: [...new Set(warnings)],
    changed: previous.protocolHash !== current.protocolHash || previous.contractHash !== current.contractHash || previous.schemaVersion !== current.schemaVersion
  };
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read protocol snapshot ${filePath}: ${error?.message || error}`);
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fetchCurrentProtocol(structure, { logger = console } = {}) {
  if (!structure?.base) throw new Error('Official protocol structure base is missing');
  const headers = { Accept: 'application/json,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0' };
  let requestedUrl = new URL('res/proto/liqi.json', structure.base);
  if (structure.version) {
    const manifestUrl = new URL(`resversion${structure.version}.json`, structure.base);
    try {
      const response = await global.fetch(manifestUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (response.ok) {
        const manifest = await response.json();
        const prefix = manifest?.res?.['res/proto/liqi.json']?.prefix;
        if (prefix) {
          requestedUrl = new URL(`${String(prefix).replace(/^\/+|\/+$/g, '')}/res/proto/liqi.json`, structure.base);
        }
      }
    } catch (error) {
      logger.warn?.(`protocol manifest lookup failed: ${error?.message || error}`);
    }
  }
  const response = await global.fetch(requestedUrl, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Official liqi.json request failed: ${response.status} ${requestedUrl}`);
  const liqiJson = await response.json();
  logger.log?.(`protocol source loaded -> ${requestedUrl}`);
  return liqiJson;
}

async function prepareProtocolMonitor({
  serverKey = process.env.MS_SERVER || 'jp',
  structure,
  forceRefresh = false,
  baselinePath = PROTOCOL_BASELINE_PATH,
  pendingPath = PROTOCOL_PENDING_PATH,
  reportPath = PROTOCOL_REPORT_PATH,
  requireBaseline = false,
  logger = console
} = {}) {
  let resolvedStructure = structure;
  if (!resolvedStructure) {
    const { prepareOfficialStructureFallbacks } = require('./official-structure-fallbacks');
    resolvedStructure = await prepareOfficialStructureFallbacks({ serverKey, forceRefresh, logger });
  }
  const liqiJson = await fetchCurrentProtocol(resolvedStructure, { logger });
  let current;
  try {
    current = buildProtocolSnapshot(liqiJson, { sourceVersion: resolvedStructure.version || null });
  } catch (cause) {
    const report = { breaking: [cause?.message || String(cause)], warnings: [], changed: true };
    writeJsonFile(reportPath, {
      sourceVersion: resolvedStructure.version || null,
      previousProtocolHash: readJsonFile(baselinePath)?.protocolHash || null,
      currentProtocolHash: null,
      ...report
    });
    const error = new Error(`Breaking MahjongSoul protocol changes detected before attendance:\n- ${report.breaking.join('\n- ')}`, { cause });
    error.code = 'PROTOCOL_BREAKING_CHANGE';
    error.protocolReport = report;
    throw error;
  }

  const baseline = readJsonFile(baselinePath);
  if (!baseline && requireBaseline) {
    const error = new Error('Protocol baseline is missing; generate protocol-snapshot.json before validation.');
    error.code = 'PROTOCOL_BASELINE_MISSING';
    throw error;
  }
  const report = compareProtocolSnapshots(baseline, current);
  for (const warning of report.warnings) logger.warn?.(`protocol monitor warning -> ${warning}`);
  if (report.breaking.length) {
    writeJsonFile(reportPath, {
      sourceVersion: current.sourceVersion,
      previousProtocolHash: baseline?.protocolHash || null,
      currentProtocolHash: current.protocolHash,
      ...report
    });
    const error = new Error(`Breaking MahjongSoul protocol changes detected before attendance:\n- ${report.breaking.join('\n- ')}`);
    error.code = 'PROTOCOL_BREAKING_CHANGE';
    error.protocolReport = report;
    throw error;
  }

  writeJsonFile(pendingPath, current);
  if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  logger.log?.(
    `protocol monitor -> source=${current.sourceVersion || 'unknown'} contract=${current.contractHash.slice(0, 12)} ` +
    `changed=${report.changed} warnings=${report.warnings.length} compatibility_patches=${current.compatibilityPatches.length}`
  );
  return { baseline, current, report, pendingPath, baselinePath };
}

module.exports = {
  PROTOCOL_BASELINE_PATH,
  PROTOCOL_PENDING_PATH,
  PROTOCOL_REPORT_PATH,
  RPC_CONTRACTS,
  SNAPSHOT_SCHEMA_VERSION,
  applyKnownProtocolCompatibility,
  buildProtocolSnapshot,
  collectRequiredRequestPaths,
  compareProtocolSnapshots,
  fetchCurrentProtocol,
  finalizeProtocolSnapshot: legacy.finalizeProtocolSnapshot,
  getNestedNode,
  prepareProtocolMonitor,
  resolveFieldPath,
  stableStringify
};
