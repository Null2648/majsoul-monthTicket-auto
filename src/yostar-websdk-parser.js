const MAX_RUNTIME_CANDIDATES = 8;
const MAX_CONFIG_CANDIDATES = 6;
const MAX_METADATA_CANDIDATES = 12;

function uniqueBy(values, keySelector) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keySelector(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || ''));
}

function isSigningSecret(value) {
  return /^[a-f0-9]{32,128}$/i.test(String(value || ''));
}

function decodeEscape(source, index) {
  const character = source[index];
  const simple = {
    b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '0': '\0', '\\': '\\', "'": "'", '"': '"', '`': '`'
  };
  if (Object.hasOwn(simple, character)) return { value: simple[character], end: index + 1 };
  if (character === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
    return { value: String.fromCharCode(parseInt(source.slice(index + 1, index + 3), 16)), end: index + 3 };
  }
  if (character === 'u') {
    const braced = source.slice(index + 1).match(/^\{([0-9a-f]{1,6})\}/i);
    if (braced) return { value: String.fromCodePoint(parseInt(braced[1], 16)), end: index + 1 + braced[0].length };
    const fixed = source.slice(index + 1, index + 5);
    if (/^[0-9a-f]{4}$/i.test(fixed)) {
      return { value: String.fromCharCode(parseInt(fixed, 16)), end: index + 5 };
    }
  }
  return { value: character, end: index + 1 };
}

function readStringToken(source, start) {
  const quote = source[start];
  let value = '';
  let index = start + 1;
  let interpolated = false;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) {
      return { value, end: index + 1, interpolated };
    }
    if (quote === '`' && character === '$' && source[index + 1] === '{') {
      interpolated = true;
    }
    if (character === '\\') {
      const decoded = decodeEscape(source, index + 1);
      value += decoded.value;
      index = decoded.end;
      continue;
    }
    value += character;
    index += 1;
  }
  return { value, end: source.length, interpolated: true };
}

function tokenizeJavaScript(source) {
  const text = String(source || '');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const token = readStringToken(text, index);
      tokens.push({ type: 'string', value: token.value, start: index, end: token.end, interpolated: token.interpolated });
      index = token.end;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (end < text.length && /[\w$]/.test(text[end])) end += 1;
      tokens.push({ type: 'identifier', value: text.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (/\d/.test(character)) {
      let end = index + 1;
      while (end < text.length && /[0-9A-Fa-f_xX.]/.test(text[end])) end += 1;
      tokens.push({ type: 'number', value: text.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    const pair = text.slice(index, index + 2);
    const triple = text.slice(index, index + 3);
    const punctuator = ['===', '!==', '>>>', '**='].includes(triple)
      ? triple
      : ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '**'].includes(pair)
        ? pair
        : character;
    tokens.push({ type: 'punctuator', value: punctuator, start: index, end: index + punctuator.length });
    index += punctuator.length;
  }
  return tokens;
}

function buildPartialAstIndex(source) {
  const tokens = tokenizeJavaScript(source);
  const stringBindings = new Map();
  const properties = [];
  const assignments = [];

  const resolveTokenValue = token => {
    if (!token) return null;
    if (token.type === 'string' && !token.interpolated) return token.value;
    if (token.type === 'identifier') return stringBindings.get(token.value) || null;
    return null;
  };

  for (let index = 0; index < tokens.length - 2; index += 1) {
    const left = tokens[index];
    const operator = tokens[index + 1];
    const right = tokens[index + 2];
    if (left.type === 'identifier' && operator.value === '=' && right.type === 'string' && !right.interpolated) {
      stringBindings.set(left.value, right.value);
      assignments.push({ name: left.value, value: right.value, start: left.start, end: right.end });
    }
  }

  for (let index = 0; index < tokens.length - 2; index += 1) {
    const key = tokens[index];
    const separator = tokens[index + 1];
    const valueToken = tokens[index + 2];
    if ((key.type === 'identifier' || key.type === 'string') && (separator.value === ':' || separator.value === '=')) {
      const value = resolveTokenValue(valueToken);
      if (value != null) properties.push({ key: key.value, value, start: key.start, end: valueToken.end });
    }
    if (index < tokens.length - 4 && tokens[index + 1].value === '.' && tokens[index + 2].type === 'identifier' && tokens[index + 3].value === '=') {
      const value = resolveTokenValue(tokens[index + 4]);
      if (value != null) properties.push({ key: tokens[index + 2].value, value, start: key.start, end: tokens[index + 4].end });
    }
  }

  return { tokens, stringBindings, properties, assignments };
}

function contextScore(source, start, end, terms) {
  const context = String(source || '').slice(Math.max(0, start - 500), Math.min(String(source || '').length, end + 500)).toLowerCase();
  return terms.reduce((score, [term, weight]) => score + (context.includes(term) ? weight : 0), 0);
}

function collectVersionCandidates(source, astIndex) {
  const values = [];
  for (const property of astIndex.properties) {
    if (!isSemver(property.value)) continue;
    const key = property.key.toLowerCase();
    let score = 35;
    if (key === 'version') score += 80;
    if (key.includes('sdk')) score += 30;
    if (key.includes('version')) score += 25;
    score += contextScore(source, property.start, property.end, [['websdk', 20], ['yostar', 15], ['sdk', 8]]);
    values.push({ value: property.value, score, strategy: 'partial-ast', offset: property.start });
  }
  for (const assignment of astIndex.assignments) {
    if (!isSemver(assignment.value)) continue;
    const name = assignment.name.toLowerCase();
    let score = 15;
    if (name.includes('version')) score += 60;
    if (name.includes('sdk')) score += 30;
    score += contextScore(source, assignment.start, assignment.end, [['websdk', 20], ['yostar', 15], ['version', 10]]);
    values.push({ value: assignment.value, score, strategy: 'partial-ast', offset: assignment.start });
  }
  for (const token of astIndex.tokens) {
    if (token.type !== 'string' || token.interpolated || !isSemver(token.value)) continue;
    const score = 10 + contextScore(source, token.start, token.end, [['version', 35], ['websdk', 25], ['yostar', 15], ['sdk', 8]]);
    values.push({ value: token.value, score, strategy: 'heuristic', offset: token.start });
  }
  return uniqueBy(values.sort((a, b) => b.score - a.score), candidate => candidate.value).slice(0, 6);
}

function collectSecretCandidates(source, astIndex) {
  const values = [];
  for (const token of astIndex.tokens) {
    if (token.type !== 'string' || token.interpolated || !isSigningSecret(token.value)) continue;
    let score = token.value.length === 40 ? 55 : 20;
    score += contextScore(source, token.start, token.end, [
      ['md5', 45], ['sign', 35], ['authorization', 25], ['json.stringify', 20],
      ['head', 8], ['body', 8], ['secret', 20], ['gk', 10]
    ]);
    values.push({ value: token.value.toLowerCase(), score, strategy: score >= 80 ? 'partial-ast' : 'heuristic', offset: token.start });
  }
  return uniqueBy(values.sort((a, b) => b.score - a.score), candidate => candidate.value).slice(0, 8);
}

function parseWebSdkRuntimeStrict(script) {
  const source = String(script || '');
  const version = source.match(/\bversion\s*:\s*["']([^"']+)["']/)?.[1];
  const signingSecret = source.match(/\bGK\s*=\s*\([^)]*\)\s*=>\s*\{\s*const [A-Za-z_$][\w$]*\s*=\s*["']([a-f0-9]{40})["']/i)?.[1];
  if (!isSemver(version) || !isSigningSecret(signingSecret)) return null;
  return { version, signingSecret: signingSecret.toLowerCase(), strategy: 'strict-regex', confidence: 1000 };
}

function parseWebSdkRuntimeCandidates(script) {
  const source = String(script || '');
  const candidates = [];
  const strict = parseWebSdkRuntimeStrict(source);
  if (strict) candidates.push(strict);
  const astIndex = buildPartialAstIndex(source);
  const versions = collectVersionCandidates(source, astIndex);
  const secrets = collectSecretCandidates(source, astIndex);
  for (const version of versions) {
    for (const secret of secrets) {
      candidates.push({
        version: version.value,
        signingSecret: secret.value,
        strategy: version.strategy === 'partial-ast' || secret.strategy === 'partial-ast' ? 'partial-ast' : 'heuristic',
        confidence: version.score + secret.score
      });
    }
  }
  return uniqueBy(
    candidates.sort((a, b) => b.confidence - a.confidence),
    candidate => `${candidate.version}\u0000${candidate.signingSecret}`
  ).slice(0, MAX_RUNTIME_CANDIDATES);
}

function parseWebSdkRuntime(script) {
  const candidate = parseWebSdkRuntimeCandidates(script)[0];
  if (!candidate) throw new Error('Unable to read the current YoStar WebSDK version/signing metadata');
  return { version: candidate.version, signingSecret: candidate.signingSecret };
}

function normalizeHost(value) {
  try {
    const url = new URL(String(value || '').trim());
    return /^https?:$/.test(url.protocol) ? url.toString().replace(/\/+$/, '') : null;
  } catch { return null; }
}

function normalizeKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function parseJpSdkConfigStrict(config) {
  const jp = config?.Regions?.Jp;
  const primaryHost = normalizeHost(jp?.Sdk_Url);
  const backupHost = normalizeHost(jp?.Sdk_Url_Lb);
  const pid = jp?.Sdk_Pid;
  if (!primaryHost || !pid) return null;
  return { hosts: uniqueBy([primaryHost, backupHost].filter(Boolean), value => value), pid: String(pid), strategy: 'strict-config', confidence: 1000 };
}

function parseJpSdkConfigCandidates(config) {
  const candidates = [];
  const strict = parseJpSdkConfigStrict(config);
  if (strict) candidates.push(strict);
  const visit = (value, path = []) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, [...path, String(index)])); return; }
    const hosts = [];
    const pids = [];
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = normalizeKey(key);
      if (typeof child === 'string') {
        const host = normalizeHost(child);
        if (host && /(sdk|api|host|url|endpoint|server)/.test(normalizedKey)) hosts.push(host);
        if (!host && /(sdkpid|productid|gameid|appid|^pid$)/.test(normalizedKey) && child.trim()) pids.push(child.trim());
      }
    }
    if (hosts.length && pids.length) {
      const pathText = path.join('.').toLowerCase();
      let score = 100;
      if (/(^|\.)(jp|japan)(\.|$)/.test(pathText)) score += 100;
      if (pathText.includes('region')) score += 30;
      candidates.push({ hosts: uniqueBy(hosts, host => host), pid: pids[0], strategy: 'structural-config', confidence: score });
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(config);
  return uniqueBy(candidates.sort((a, b) => b.confidence - a.confidence), candidate => `${candidate.pid}\u0000${candidate.hosts.join(',')}`).slice(0, MAX_CONFIG_CANDIDATES);
}

function parseJpSdkConfig(config) {
  const candidate = parseJpSdkConfigCandidates(config)[0];
  if (!candidate) throw new Error('JP YoStar WebSDK host or PID is missing');
  return { hosts: candidate.hosts, pid: candidate.pid };
}

function normalizeWebSdkMetadata(metadata, strategy = metadata?.strategy || 'cached') {
  if (!metadata || !isSemver(metadata.version) || !isSigningSecret(metadata.signingSecret)) return null;
  const hosts = uniqueBy((metadata.hosts || []).map(normalizeHost).filter(Boolean), host => host);
  const pid = String(metadata.pid || '').trim();
  if (!hosts.length || !pid) return null;
  return {
    hosts,
    pid,
    version: String(metadata.version),
    signingSecret: String(metadata.signingSecret).toLowerCase(),
    strategy
  };
}

function mergeWebSdkMetadataCandidates({ configCandidates = [], runtimeCandidates = [], cachedMetadata } = {}) {
  const candidates = [];
  const cached = normalizeWebSdkMetadata(cachedMetadata, 'cached');
  if (cached) candidates.push(cached);
  for (const config of configCandidates) {
    for (const runtime of runtimeCandidates) {
      const candidate = normalizeWebSdkMetadata({
        hosts: config.hosts,
        pid: config.pid,
        version: runtime.version,
        signingSecret: runtime.signingSecret
      }, `${config.strategy}+${runtime.strategy}`);
      if (candidate) {
        candidate.confidence = Number(config.confidence || 0) + Number(runtime.confidence || 0);
        candidates.push(candidate);
      }
    }
  }
  return uniqueBy(candidates.sort((a, b) => {
    if (a.strategy === 'cached') return -1;
    if (b.strategy === 'cached') return 1;
    return Number(b.confidence || 0) - Number(a.confidence || 0);
  }), candidate => `${candidate.pid}\u0000${candidate.version}\u0000${candidate.signingSecret}\u0000${candidate.hosts.join(',')}`).slice(0, MAX_METADATA_CANDIDATES);
}

module.exports = {
  buildPartialAstIndex,
  mergeWebSdkMetadataCandidates,
  normalizeWebSdkMetadata,
  parseJpSdkConfig,
  parseJpSdkConfigCandidates,
  parseWebSdkRuntime,
  parseWebSdkRuntimeCandidates,
  tokenizeJavaScript
};
