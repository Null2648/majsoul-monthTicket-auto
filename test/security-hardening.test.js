const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  FETCH_GUARD_STATE,
  FETCH_SCOPE_STATE,
  readBodyLimited,
  responseLimit,
  scopeStructureFetch
} = require('../src/network-hardening');
const {
  hardenWebSdkMetadataCandidates,
  normalizeCredentialHost
} = require('../src/yostar-websdk-hardened');
const {
  sanitizeMarkdownText
} = require('../src/automation-alert-hardened');

const repoPath = (...parts) => path.join(process.cwd(), ...parts);

test('metadata responses are bounded even without a content-length header', async () => {
  const response = new Response('0123456789ABCDEF');
  await assert.rejects(() => readBodyLimited(response, 8), /exceeds 8 bytes/);
  assert.equal(responseLimit(new URL('https://example.com/res/proto/liqi.json')), 24 * 1024 * 1024);
  assert.equal(responseLimit(new URL('https://example.com/resversion0.1.0.w.json')), 32 * 1024 * 1024);
});

test('structure fallback bypasses unrelated origins', async () => {
  const previousFetch = global.fetch;
  delete globalThis[FETCH_GUARD_STATE];
  delete globalThis[FETCH_SCOPE_STATE];
  const calls = [];
  const directFetch = async input => {
    calls.push(`direct:${input}`);
    return new Response('{}');
  };
  const structureFetch = async input => {
    calls.push(`structure:${input}`);
    return new Response('{}');
  };
  global.fetch = structureFetch;
  try {
    scopeStructureFetch({
      base: 'https://game.mahjongsoul.com/',
      configUrls: ['https://game.mahjongsoul.com/config.json'],
      manifestUrls: [],
      liqiUrls: [],
      gatewayUrls: [],
      originalFetch: directFetch
    });
    await global.fetch('https://unrelated.example/config.json');
    await global.fetch('https://game.mahjongsoul.com/config.json');
    assert.match(calls[0], /^direct:/);
    assert.match(calls[1], /^structure:/);
  } finally {
    global.fetch = previousFetch;
    delete globalThis[FETCH_GUARD_STATE];
    delete globalThis[FETCH_SCOPE_STATE];
  }
});

test('YoStar credentials are restricted to trusted HTTPS candidates', () => {
  assert.equal(normalizeCredentialHost('http://sdk-api.yostar.net'), null);
  assert.equal(normalizeCredentialHost('https://127.0.0.1'), null);
  assert.equal(normalizeCredentialHost('https://unrelated.example'), null);
  assert.equal(normalizeCredentialHost('https://sdk-api.yostar.net'), 'https://sdk-api.yostar.net');

  const candidates = hardenWebSdkMetadataCandidates([
    { hosts: ['https://unrelated.example'], pid: '1', version: '1.2.3', signingSecret: 'a'.repeat(40), strategy: 'structural-config+partial-ast' },
    { hosts: ['https://sdk-api.yostar.net'], pid: '1', version: '1.2.3', signingSecret: 'a'.repeat(40), strategy: 'structural-config+partial-ast' },
    { hosts: ['https://official-new.example'], pid: '2', version: '1.2.3', signingSecret: 'b'.repeat(40), strategy: 'strict-config+strict-regex' }
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].hosts[0], 'https://sdk-api.yostar.net');
  assert.equal(candidates[1].hosts[0], 'https://official-new.example');
});

test('issue text cannot trigger mentions or HTML comments', () => {
  const alert = sanitizeMarkdownText('hello @everyone <!-- hidden -->');
  assert.doesNotMatch(alert, /@everyone/);
  assert.doesNotMatch(alert, /<!--/);
});

test('validation remains read-only and attendance writes only from trusted main', () => {
  const mainWorkflow = fs.readFileSync(repoPath('.github', 'workflows', 'main.yml'), 'utf8');
  const attendance = mainWorkflow.split(/\n  attendance:\n/)[1] || '';
  assert.match(mainWorkflow, /validate:\n[\s\S]*?permissions:\n\s+contents: read/);
  assert.match(mainWorkflow, /manual_ref_check:/);
  assert.match(attendance, /contents: write/);
  assert.match(attendance, /github\.ref == 'refs\/heads\/main'/);
  assert.match(attendance, /Checkout trusted main branch/);
  assert.match(attendance, /ref: main/);
  assert.match(mainWorkflow, /persist-credentials: false/);
  assert.equal(fs.existsSync(repoPath('.github', 'workflows', 'upstream-sync.yml')), false);
});
