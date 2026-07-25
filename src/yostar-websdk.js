const fs = require('node:fs');
const path = require('node:path');
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} = require('node:crypto');
const {
  mergeWebSdkMetadataCandidates,
  parseJpSdkConfig,
  parseJpSdkConfigCandidates,
  parseWebSdkRuntime,
  parseWebSdkRuntimeCandidates
} = require('./yostar-websdk-parser');

const AUTH_CACHE_PATH = path.join(process.cwd(), 'auth-cache.json');
const WEBSDK_CONFIG_PATH = 'StreamingAssets/WebGL/YoStarSDK/config.json';
const WEBSDK_SCRIPT_PATH = 'StreamingAssets/WebGL/YoStarSDK/index.js.txt';

function buildUrl(base, pathname) {
  return `${String(base).replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

function createStableDeviceId(uid, baseToken) {
  const bytes = createHash('sha256')
    .update(`majsoul-yostar-device:${uid}:${baseToken}`)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

function getCacheKey(uid, baseToken) {
  return createHash('sha256')
    .update(`majsoul-auth-cache:${uid}:${baseToken}`)
    .digest();
}

function encryptTokenCache(payload, uid, baseToken) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getCacheKey(uid, baseToken), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptTokenCache(cache, uid, baseToken) {
  if (
    cache?.version !== 1 ||
    cache?.algorithm !== 'aes-256-gcm' ||
    !cache.iv ||
    !cache.tag ||
    !cache.ciphertext
  ) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      getCacheKey(uid, baseToken),
      Buffer.from(cache.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(cache.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(cache.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    const payload = JSON.parse(plaintext);

    return payload?.uid === uid && payload?.token ? payload : null;
  } catch {
    return null;
  }
}

function readTokenCache(uid, baseToken, cachePath = AUTH_CACHE_PATH) {
  try {
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    return decryptTokenCache(
      JSON.parse(fs.readFileSync(cachePath, 'utf8')),
      uid,
      baseToken
    );
  } catch {
    return null;
  }
}

function saveTokenCache(payload, uid, baseToken, cachePath = AUTH_CACHE_PATH) {
  const encrypted = encryptTokenCache(payload, uid, baseToken);
  fs.writeFileSync(cachePath, `${JSON.stringify(encrypted, null, 2)}\n`, 'utf8');
}

function buildAuthorization({
  uid,
  token,
  deviceId,
  pid,
  sdkVersion,
  signingSecret,
  unixTime
}) {
  const Head = {
    Region: 'Jp',
    PID: pid,
    Channel: 'web',
    Platform: 'pc',
    Version: sdkVersion,
    Lang: 'ja',
    DeviceID: deviceId,
    UID: uid,
    Token: token,
    Time: unixTime
  };
  const body = {};
  const Sign = createHash('md5')
    .update(`${JSON.stringify(Head)}${JSON.stringify(body)}${signingSecret}`)
    .digest('hex')
    .toUpperCase();

  return { Head, Sign };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: '*/*',
      'User-Agent': 'Mozilla/5.0'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`YoStar WebSDK request failed: ${response.status} ${url}`);
  }

  return response.text();
}

async function loadOfficialWebSdkMetadataCandidates(gameBase) {
  const [configText, script] = await Promise.all([
    fetchText(buildUrl(gameBase, WEBSDK_CONFIG_PATH)),
    fetchText(buildUrl(gameBase, WEBSDK_SCRIPT_PATH))
  ]);
  let config;

  try {
    config = JSON.parse(configText);
  } catch {
    throw new Error('YoStar WebSDK config is not valid JSON');
  }

  const configCandidates = parseJpSdkConfigCandidates(config);
  const runtimeCandidates = parseWebSdkRuntimeCandidates(script);
  const candidates = mergeWebSdkMetadataCandidates({
    configCandidates,
    runtimeCandidates
  });

  if (!candidates.length) {
    throw new Error(
      `Unable to build YoStar WebSDK metadata candidates ` +
      `(config=${configCandidates.length}, runtime=${runtimeCandidates.length})`
    );
  }

  console.log(
    `YoStar WebSDK metadata candidates -> ${candidates
      .map(candidate => `${candidate.version}:${candidate.strategy}`)
      .join(', ')}`
  );

  return candidates;
}

async function loadOfficialWebSdkMetadata(gameBase) {
  return (await loadOfficialWebSdkMetadataCandidates(gameBase))[0];
}

function extractQuickLoginResult(response) {
  const code = Number(response?.Code ?? response?.code ?? 0);
  const data = response?.Data ?? response?.data;
  const userInfo = data?.UserInfo;

  if (code !== 200 || !userInfo?.ID || !userInfo?.Token) {
    const error = new Error(
      `YoStar WebSDK quick login failed: ${JSON.stringify({
        code,
        message: response?.Message ?? response?.message
      })}`
    );
    error.yostarCode = code;
    throw error;
  }

  return {
    uid: String(userInfo.ID),
    token: String(userInfo.Token)
  };
}

async function refreshYostarCredentials({
  gameBase,
  uid,
  token,
  deviceId,
  metadata
}) {
  const sdkCandidates = metadata
    ? mergeWebSdkMetadataCandidates({ cachedMetadata: metadata })
    : await loadOfficialWebSdkMetadataCandidates(gameBase);

  if (!sdkCandidates.length) {
    throw new Error('No usable YoStar WebSDK metadata candidate is available');
  }

  const resolvedDeviceId = deviceId || createStableDeviceId(uid, token);
  const errors = [];
  let lastYostarCode;

  for (const sdk of sdkCandidates) {
    console.log(
      `trying YoStar WebSDK metadata -> version=${sdk.version} ` +
      `strategy=${sdk.strategy} routes=${sdk.hosts.length}`
    );

    for (const host of sdk.hosts) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const authorization = buildAuthorization({
          uid,
          token,
          deviceId: resolvedDeviceId,
          pid: sdk.pid,
          sdkVersion: sdk.version,
          signingSecret: sdk.signingSecret,
          unixTime: Math.floor(Date.now() / 1000)
        });

        try {
          const response = await fetch(buildUrl(host, 'user/quick-login'), {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              Authorization: JSON.stringify(authorization),
              'Content-Type': 'application/json',
              Origin: 'https://game.mahjongsoul.com',
              Referer: 'https://game.mahjongsoul.com/',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
            },
            body: '{}',
            signal: AbortSignal.timeout(10000)
          });
          const text = await response.text();
          let json;

          try {
            json = JSON.parse(text);
          } catch {
            throw new Error(`YoStar WebSDK returned non-JSON HTTP ${response.status}`);
          }

          const quickLoginResult = extractQuickLoginResult(json);

          if (quickLoginResult.uid !== String(uid)) {
            throw new Error(
              'YoStar WebSDK quick login returned a different account UID'
            );
          }

          return {
            // The official WebSDK keeps the account credentials it used for
            // quick-login. UserInfo.Token belongs to the quick-login cache and is
            // not the LOGIN_TOKEN returned to the game client.
            uid: String(uid),
            token: String(token),
            responseUid: quickLoginResult.uid,
            responseToken: quickLoginResult.token,
            deviceId: resolvedDeviceId,
            metadata: sdk
          };
        } catch (error) {
          if (error?.yostarCode) {
            lastYostarCode = error.yostarCode;
          }

          if (error?.yostarCode === 100403) {
            error.metadataStrategy = sdk.strategy;
            throw error;
          }

          errors.push(
            `${sdk.strategy} ${new URL(host).host} attempt ${attempt}: ` +
            `${error?.message || error}`
          );

          if (error?.yostarCode || attempt === 3) {
            break;
          }
        }
      }
    }
  }

  const error = new Error(
    `All YoStar WebSDK metadata and quick-login routes failed: ${errors.join('; ')}`
  );
  error.yostarCode = lastYostarCode;
  throw error;
}

module.exports = {
  AUTH_CACHE_PATH,
  buildAuthorization,
  createStableDeviceId,
  decryptTokenCache,
  encryptTokenCache,
  extractQuickLoginResult,
  loadOfficialWebSdkMetadata,
  loadOfficialWebSdkMetadataCandidates,
  parseJpSdkConfig,
  parseJpSdkConfigCandidates,
  parseWebSdkRuntime,
  parseWebSdkRuntimeCandidates,
  readTokenCache,
  refreshYostarCredentials,
  saveTokenCache
};
