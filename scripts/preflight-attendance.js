const {
  clearAutomationFailureReport,
  writeAutomationFailureReport
} = require('../src/automation-alert-hardened');

const OAUTH_SERVERS = new Set(['jp', 'en', 'kr']);
const ALLOWED_SERVERS = new Set([...OAUTH_SERVERS, 'cn']);
const PLACEHOLDER_PATTERN = /^(?:undefined|null|none|changeme|your[_ -]|<.*>)$/i;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstValue(env, ...names) {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) return value;
  }
  return '';
}

function assertUsable(name, value) {
  if (!value) return;
  if (PLACEHOLDER_PATTERN.test(value)) {
    throw new Error(`${name} contains a placeholder value. Update the repository Secret.`);
  }
}

function inspectAttendanceConfiguration(env = process.env) {
  const server = clean(env.MS_SERVER || 'jp').toLowerCase() || 'jp';
  if (!ALLOWED_SERVERS.has(server)) {
    throw new Error(`MS_SERVER must be one of jp, en, kr, or cn; received ${server || 'empty'}.`);
  }

  const uid = firstValue(env, 'MAJSOUL_UID', 'UID');
  const token = firstValue(env, 'MAJSOUL_TOKEN', 'TOKEN');
  const accessToken = firstValue(env, 'MAJSOUL_ACCESS_TOKEN', 'ACCESS_TOKEN');
  const deviceId = firstValue(env, 'MAJSOUL_YOSTAR_DEVICE_ID', 'YOSTAR_DEVICE_ID');
  const email = firstValue(env, 'MAJSOUL_EMAIL', 'EMAIL');
  const password = firstValue(env, 'MAJSOUL_PASSWORD', 'PASSWORD');

  for (const [name, value] of [
    ['UID', uid],
    ['TOKEN', token],
    ['ACCESS_TOKEN', accessToken],
    ['YOSTAR_DEVICE_ID', deviceId],
    ['EMAIL', email],
    ['PASSWORD', password]
  ]) {
    assertUsable(name, value);
  }

  let credentialMode;
  const warnings = [];

  if (OAUTH_SERVERS.has(server)) {
    if (Boolean(uid) !== Boolean(token)) {
      throw new Error('UID and TOKEN must either both be configured or both be omitted.');
    }
    if (!accessToken && !(uid && token)) {
      throw new Error('Set ACCESS_TOKEN, or set both UID and TOKEN, for JP/EN/KR attendance.');
    }
    credentialMode = accessToken ? 'access-token' : 'uid-token';
    if (server === 'jp' && uid && token && !deviceId) {
      warnings.push(
        'YOSTAR_DEVICE_ID is not configured. A valid encrypted cache may still work, but a fresh YoStar reauthentication can fail.'
      );
    }
  } else {
    if (!email || !password) {
      throw new Error('Set both EMAIL and PASSWORD for CN attendance.');
    }
    credentialMode = 'email-password';
  }

  return {
    server,
    credentialMode,
    hasDeviceId: Boolean(deviceId),
    warnings
  };
}

function appendSummary(result, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  const lines = [
    '## 출석 설정 사전검사',
    '',
    `- 서버: \`${result.server}\``,
    `- 인증 방식: \`${result.credentialMode}\``,
    `- YoStar DeviceID 설정: ${result.hasDeviceId ? '예' : '아니오'}`
  ];
  if (result.warnings.length) {
    lines.push('', '### 경고', ...result.warnings.map(item => `- ${item}`));
  }
  require('node:fs').appendFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

function appendOutputs(result, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  require('node:fs').appendFileSync(
    outputPath,
    [
      `server=${result.server}`,
      `credential_mode=${result.credentialMode}`,
      `has_device_id=${result.hasDeviceId}`
    ].join('\n') + '\n',
    'utf8'
  );
}

function run(env = process.env, { failureReportPath } = {}) {
  clearAutomationFailureReport(failureReportPath);
  try {
    const result = inspectAttendanceConfiguration(env);
    appendSummary(result, env.GITHUB_STEP_SUMMARY);
    appendOutputs(result, env.GITHUB_OUTPUT);
    console.log(
      `attendance preflight -> server=${result.server} credential=${result.credentialMode} ` +
      `deviceId=${result.hasDeviceId ? 'configured' : 'not-configured'}`
    );
    for (const warning of result.warnings) console.warn(`attendance preflight warning -> ${warning}`);
    return result;
  } catch (error) {
    writeAutomationFailureReport(error, { stage: 'preflight', env, filePath: failureReportPath });
    throw error;
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  inspectAttendanceConfiguration,
  run
};
