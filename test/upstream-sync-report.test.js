const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildIssueBody,
  buildPrBody,
  sanitizeText
} = require('../scripts/upstream-sync-report');

test('buildPrBody describes a draft-only reviewed update with validation results', () => {
  const body = buildPrBody({
    upstreamRepository: '4n3u/majsoul-monthTicket-auto',
    upstreamBranch: 'main',
    upstreamSha: '1234567890abcdef',
    baseSha: 'abcdef1234567890',
    syncBranch: 'automation/upstream-sync',
    runUrl: 'https://github.com/example/actions/runs/1',
    commits: ['- `1234567` Update login'],
    files: ['- `src/index.js`'],
    validation: {
      merge: 'success',
      install: 'success',
      unit: 'success',
      jp: 'success',
      yostar: 'success',
      protocol: 'success'
    }
  });

  assert.match(body, /원본 업데이트 검토/);
  assert.match(body, /1234567890ab/);
  assert.match(body, /단위 테스트 \| ✅ 성공/);
  assert.match(body, /자동 병합되지 않습니다/);
});

test('buildIssueBody lists conflicts and failed validation without exposing a token', () => {
  const body = buildIssueBody({
    reason: 'merge-conflict token=ghp_123456789012345678901234567890',
    upstreamRepository: '4n3u/majsoul-monthTicket-auto',
    upstreamBranch: 'main',
    upstreamSha: '1234567890abcdef',
    runUrl: 'https://github.com/example/actions/runs/2',
    conflicts: ['src/index.js', '.github/workflows/main.yml'],
    validation: { merge: 'failure' }
  });

  assert.match(body, /충돌 파일/);
  assert.match(body, /src\/index\.js/);
  assert.match(body, /❌ 실패/);
  assert.doesNotMatch(body, /ghp_123456789012345678901234567890/);
  assert.match(body, /\[REDACTED\]/);
});

test('sanitizeText removes control characters and authorization values', () => {
  const sanitized = sanitizeText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nnext');
  assert.doesNotMatch(sanitized, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(sanitized, /\n/);
  assert.match(sanitized, /REDACTED/);
});
