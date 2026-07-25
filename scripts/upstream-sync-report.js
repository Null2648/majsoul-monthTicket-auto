const fs = require('node:fs');

const MAX_LINE_LENGTH = 320;
const MAX_COMMITS = 50;
const MAX_FILES = 100;

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:token|password|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, match => {
      const separator = match.includes('=') ? '=' : ':';
      return `${match.split(separator)[0]}${separator}[REDACTED]`;
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LINE_LENGTH);
}

function readLines(filePath, limit) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(sanitizeText)
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeOutcome(value) {
  const outcome = String(value || 'skipped').toLowerCase();
  return ['success', 'failure', 'cancelled', 'skipped'].includes(outcome)
    ? outcome
    : 'unknown';
}

function outcomeLabel(value) {
  const outcome = normalizeOutcome(value);
  return {
    success: '✅ 성공',
    failure: '❌ 실패',
    cancelled: '⏹️ 취소',
    skipped: '➖ 건너뜀',
    unknown: '❔ 확인 필요'
  }[outcome];
}

function buildValidationTable(validation = {}) {
  const rows = [
    ['원본 병합', validation.merge],
    ['의존성 설치', validation.install],
    ['단위 테스트', validation.unit],
    ['JP 클라이언트 검사', validation.jp],
    ['YoStar SDK 검사', validation.yostar],
    ['프로토콜 계약 검사', validation.protocol]
  ];

  return [
    '| 검증 항목 | 결과 |',
    '|---|---|',
    ...rows.map(([name, outcome]) => `| ${name} | ${outcomeLabel(outcome)} |`)
  ].join('\n');
}

function markdownList(lines, fallback) {
  if (!lines.length) return `- ${fallback}`;
  return lines.map(line => line.startsWith('- ') ? line : `- ${line}`).join('\n');
}

function buildPrBody({
  upstreamRepository,
  upstreamBranch,
  upstreamSha,
  baseSha,
  syncBranch,
  runUrl,
  commits = [],
  files = [],
  validation = {}
}) {
  const shortSha = sanitizeText(upstreamSha).slice(0, 12) || 'unknown';
  const safeRepo = sanitizeText(upstreamRepository);
  const safeBranch = sanitizeText(upstreamBranch);
  const safeBase = sanitizeText(baseSha).slice(0, 12) || 'unknown';
  const safeSyncBranch = sanitizeText(syncBranch);
  const safeRunUrl = sanitizeText(runUrl);

  return [
    '## 원본 업데이트 검토',
    '',
    `- 원본: \`${safeRepo}:${safeBranch}\``,
    `- 원본 커밋: \`${shortSha}\``,
    `- 포크 기준 커밋: \`${safeBase}\``,
    `- 자동화 브랜치: \`${safeSyncBranch}\``,
    `- 검증 실행: ${safeRunUrl || '확인 불가'}`,
    '',
    '## 포함된 원본 커밋',
    markdownList(commits, '표시할 새 커밋이 없습니다.'),
    '',
    '## 원본에서 변경된 파일',
    markdownList(files, '표시할 파일이 없습니다.'),
    '',
    '## 자동 검증',
    buildValidationTable(validation),
    '',
    '> 이 PR은 자동 병합되지 않습니다. 기존 맞춤 기능과 충돌 여부를 검토한 뒤 수동으로 병합해야 합니다.',
    '',
    '_이 본문은 원본 변경을 다시 감지할 때마다 자동으로 갱신됩니다._'
  ].join('\n');
}

function buildIssueBody({
  reason,
  upstreamRepository,
  upstreamBranch,
  upstreamSha,
  runUrl,
  prUrl,
  conflicts = [],
  validation = {}
}) {
  const safeReason = sanitizeText(reason || 'manual-review');
  const safeRepo = sanitizeText(upstreamRepository);
  const safeBranch = sanitizeText(upstreamBranch);
  const shortSha = sanitizeText(upstreamSha).slice(0, 12) || 'unknown';
  const safeRunUrl = sanitizeText(runUrl);
  const safePrUrl = sanitizeText(prUrl);

  const sections = [
    '## 업스트림 자동 동기화 점검 필요',
    '',
    `- 사유: \`${safeReason}\``,
    `- 원본: \`${safeRepo}:${safeBranch}\``,
    `- 원본 커밋: \`${shortSha}\``,
    `- Actions 실행: ${safeRunUrl || '확인 불가'}`
  ];

  if (safePrUrl) sections.push(`- 생성된 초안 PR: ${safePrUrl}`);

  if (conflicts.length) {
    sections.push('', '## 충돌 파일', markdownList(conflicts, '충돌 파일을 확인하지 못했습니다.'));
  }

  sections.push(
    '',
    '## 자동 검증',
    buildValidationTable(validation),
    '',
    '자동화는 원본 변경을 `main`에 직접 병합하지 않았습니다. 충돌 또는 실패 항목을 확인한 뒤 초안 PR이나 수동 브랜치에서 조정해야 합니다.'
  );

  return sections.join('\n');
}

function contextFromEnvironment(env = process.env) {
  return {
    upstreamRepository: env.UPSTREAM_REPOSITORY,
    upstreamBranch: env.UPSTREAM_BRANCH || 'main',
    upstreamSha: env.UPSTREAM_SHA,
    baseSha: env.BASE_SHA,
    syncBranch: env.SYNC_BRANCH,
    runUrl: env.RUN_URL,
    prUrl: env.PR_URL,
    reason: env.SYNC_REASON,
    commits: readLines(env.UPSTREAM_COMMITS_FILE, MAX_COMMITS),
    files: readLines(env.UPSTREAM_FILES_FILE, MAX_FILES),
    conflicts: readLines(env.CONFLICT_FILES_FILE, MAX_FILES),
    validation: {
      merge: env.MERGE_OUTCOME,
      install: env.INSTALL_OUTCOME,
      unit: env.UNIT_OUTCOME,
      jp: env.JP_OUTCOME,
      yostar: env.YOSTAR_OUTCOME,
      protocol: env.PROTOCOL_OUTCOME
    }
  };
}

function main() {
  const mode = process.argv[2];
  const context = contextFromEnvironment();

  if (mode === 'pr') {
    process.stdout.write(`${buildPrBody(context)}\n`);
    return;
  }
  if (mode === 'issue') {
    process.stdout.write(`${buildIssueBody(context)}\n`);
    return;
  }

  throw new Error('Usage: node scripts/upstream-sync-report.js <pr|issue>');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  buildIssueBody,
  buildPrBody,
  buildValidationTable,
  contextFromEnvironment,
  normalizeOutcome,
  readLines,
  sanitizeText
};
