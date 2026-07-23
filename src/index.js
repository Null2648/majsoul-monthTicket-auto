require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { createHmac, randomUUID } = require('node:crypto');
const protobuf = require('protobufjs/light');
const WebSocket = require('ws');
const {
  buildClientMetadata,
  buildClientVersionStringCandidates,
  buildResourceVersionCandidates,
  buildOauth2AuthPayload,
  buildOauth2LoginPayload,
  buildPasswordLoginPayload,
  buildUnityWebGLClientVersionString,
  normalizeResourceVersion,
  parseProductVersion,
  parseUnityBuildId
} = require('./client-metadata');
const {
  readTokenCache,
  refreshYostarCredentials,
  saveTokenCache
} = require('./yostar-websdk');

const DEFAULT_SERVER = 'jp';
const BUY_GREEN_GIFT = false;
const GREEN_GIFT_PRICE_GOLD = 15000;
const GREEN_GIFT_MAX_COUNT_PER_GOODS = 4;
const REVIVE_COIN_GOLD_BONUS = 18000;
const BUY_FROM_ZHP_LIMIT_REACHED_CODE = 2402;
const HTTP_REQUEST_ATTEMPTS = 3;
const HTTP_REQUEST_TIMEOUT_MS = 15000;
const SESSION_BOOTSTRAP_ATTEMPTS = 3;
// A successful client string is persisted and remains the first candidate, so the
// normal daily path still performs one authentication attempt. This wider bound is
// only consumed after MahjongSoul rejects that fast path during a client update.
const MAX_CLIENT_VERSION_PROBES = 96;
const CLIENT_VERSION_PROBE_DELAY_MS = 150;
const RESOURCE_VERSION_CACHE_PATH = path.join(process.cwd(), 'resource-version.json');

const DEFAULT_DEVICE = {
  platform: 'pc',
  hardware: 'pc',
  os: 'Windows',
  os_version: 'Windows 10',
  is_browser: true,
  software: 'Chrome',
  sale_platform: 'web',
  hardware_vendor: 'Google Inc.',
  model_number: 'Chrome',
  screen_width: 1920,
  screen_height: 1080,
  user_agent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  screen_type: 2
};

const SERVER_CONFIGS = {
  jp: {
    key: 'jp',
    base: 'https://game.mahjongsoul.com/',
    origin: 'https://game.mahjongsoul.com',
    routeLang: 'jp',
    tag: 'jp',
    loginMode: 'oauth_code',
    oauthType: 21,
    currencyPlatforms: [1, 3, 5, 9, 12]
  },
  en: {
    key: 'en',
    base: 'https://mahjongsoul.game.yo-star.com/',
    origin: 'https://mahjongsoul.game.yo-star.com',
    routeLang: 'en',
    tag: 'en',
    loginMode: 'oauth_code',
    oauthType: 22,
    currencyPlatforms: [1, 4, 5, 9, 12]
  },
  kr: {
    key: 'kr',
    base: 'https://mahjongsoul.game.yo-star.com/kr/',
    origin: 'https://mahjongsoul.game.yo-star.com',
    routeLang: 'kr',
    tag: 'kr',
    loginMode: 'oauth_code',
    oauthType: 23,
    currencyPlatforms: [1, 4, 5, 9],
    device: {
      sale_platform: 'kr_web'
    }
  },
  cn: {
    key: 'cn',
    base: 'https://game.maj-soul.com/1/',
    origin: 'https://game.maj-soul.com',
    routeLang: 'chst',
    tag: 'cn',
    loginMode: 'account_password',
    loginType: 0,
    currencyPlatforms: [1, 2, 5, 6, 8, 10, 11]
  }
};

const PROTO_TYPES = {
  Wrapper: 'Wrapper',
  ReqRequestConnection: 'lq.ReqRequestConnection',
  ReqHeartbeat: 'lq.ReqHeartbeat',
  ReqHeatBeat: 'lq.ReqHeatBeat',
  ReqLogin: 'lq.ReqLogin',
  ReqOauth2Auth: 'lq.ReqOauth2Auth',
  ReqOauth2Check: 'lq.ReqOauth2Check',
  ReqOauth2Login: 'lq.ReqOauth2Login',
  ReqBuyFromZHP: 'lq.ReqBuyFromZHP',
  ReqCommon: 'lq.ReqCommon',
  ResRequestConnection: 'lq.ResRequestConnection',
  ResHeartbeat: 'lq.ResHeartbeat',
  ResOauth2Auth: 'lq.ResOauth2Auth',
  ResOauth2Check: 'lq.ResOauth2Check',
  ResOauth2Login: 'lq.ResLogin',
  ResCommon: 'lq.ResCommon',
  ResShopInfo: 'lq.ResShopInfo',
  ResPayMonthTicket: 'lq.ResPayMonthTicket',
  ResFetchMonthTicketInfo: 'lq.ResMonthTicketInfo'
};

const fail = message => {
  throw new Error(message);
};

class MajsoulRpcError extends Error {
  constructor(operation, response) {
    const rpcCode = Number(response?.error?.code ?? 0);
    super(`${operation} failed: ${JSON.stringify(response)}`);
    this.name = 'MajsoulRpcError';
    this.operation = operation;
    this.rpcCode = rpcCode;
    this.response = response;
  }
}

function requireRpcSuccess(operation, response) {
  const rpcCode = Number(response?.error?.code ?? 0);

  if (rpcCode !== 0) {
    throw new MajsoulRpcError(operation, response);
  }

  return response;
}

const must = (value, message) => value || fail(message);

const normalizeBase = raw => {
  const base = must((raw || '').trim(), 'Server base URL must not be empty');

  if (!/^https?:\/\//i.test(base)) {
    fail('Server base URL must start with http:// or https://');
  }

  return base.replace(/\/+$/, '');
};

const buildUrl = (base, path) => `${base}/${path.replace(/^\/+/, '')}`;

const normalizeServerKey = raw => (raw || '').trim().toLowerCase();

function normalizeSecretCredential(raw, label) {
  if (raw == null) {
    return undefined;
  }

  let value = String(raw).trim();
  const labeledValue = value.match(
    new RegExp(`(?:^|\\r?\\n)${label}\\s*:\\s*([^\\r\\n]+)`, 'i')
  )?.[1];

  if (labeledValue) {
    value = labeledValue.trim();
  }

  if (
    value.length >= 2 &&
    (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    value = value.slice(1, -1).trim();
  }

  return value || undefined;
}

const buildRandv = () => {
  const now = Date.now();
  return String(now + Math.floor(Math.random() * now));
};

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const hashCnPassword = password =>
  createHmac('sha256', 'lailai').update(password).digest('hex');

const buildDevice = server => ({
  ...DEFAULT_DEVICE,
  ...server.device
});

function getServerConfig(serverKey) {
  const key = normalizeServerKey(serverKey || DEFAULT_SERVER);
  const server = SERVER_CONFIGS[key];

  if (!server) {
    fail(`Unsupported MS_SERVER "${serverKey}". Use one of: ${Object.keys(SERVER_CONFIGS).join(', ')}`);
  }

  let base = normalizeBase(server.base);

  if (server.key === 'cn' && new URL(base).pathname === '/') {
    base = `${base}/1`;
  }

  return {
    ...server,
    base
  };
}

async function requestWithRetry(url, options = {}) {
  const {
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
    ...fetchOptions
  } = options;
  let lastError;

  for (let attempt = 1; attempt <= HTTP_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });

      if (response.ok) {
        return response;
      }

      const error = new Error(`Request failed ${response.status} ${response.statusText} for ${url}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    } catch (error) {
      lastError = error;

      if (error?.retryable === false || attempt === HTTP_REQUEST_ATTEMPTS) {
        throw error;
      }

      console.warn(
        `request attempt ${attempt}/${HTTP_REQUEST_ATTEMPTS} failed for ${url}: ${error?.message || error}`
      );
      await delay(500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function requestJson(url, { body, headers, ...options } = {}) {
  const init = { ...options, headers };

  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);

    if (typeof body !== 'string') {
      init.headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers
      };
    }
  }

  const response = await requestWithRetry(url, init);

  return response.json();
}

async function requestText(url, options = {}) {
  const response = await requestWithRetry(url, options);

  return response.text();
}

function compareDottedVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const length = Math.max(pa.length, pb.length);

  for (let i = 0; i < length; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;

    if (da !== db) {
      return da - db;
    }
  }

  return 0;
}

function getOverrideResourceVersion() {
  return process.env.MS_RESOURCE_VERSION || process.env.RESOURCE_VERSION || null;
}

function getOverrideClientVersionString() {
  return process.env.MS_CLIENT_VERSION_STRING || process.env.CLIENT_VERSION_STRING || null;
}

function readResourceVersionCache() {
  try {
    if (!fs.existsSync(RESOURCE_VERSION_CACHE_PATH)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(RESOURCE_VERSION_CACHE_PATH, 'utf8'));
  } catch (error) {
    console.warn(`resource version cache read failed: ${error?.message || error}`);
    return {};
  }
}

function saveSuccessfulClientVersion(
  serverKey,
  {
    resourceVersion,
    clientVersionString,
    sourceVersion,
    productVersion,
    buildId
  }
) {
  if (
    !serverKey ||
    !resourceVersion ||
    !clientVersionString ||
    !sourceVersion ||
    !productVersion ||
    !buildId
  ) {
    return;
  }

  const cache = readResourceVersionCache();

  if (
    cache[serverKey] === resourceVersion &&
    cache.clientVersionStrings?.[serverKey] === clientVersionString &&
    cache.sourceVersions?.[serverKey] === sourceVersion &&
    cache.productVersions?.[serverKey] === productVersion &&
    cache.buildIds?.[serverKey] === buildId
  ) {
    return;
  }

  cache[serverKey] = resourceVersion;
  cache.clientVersionStrings = {
    ...cache.clientVersionStrings,
    [serverKey]: clientVersionString
  };
  cache.sourceVersions = {
    ...cache.sourceVersions,
    [serverKey]: sourceVersion
  };
  cache.productVersions = {
    ...cache.productVersions,
    [serverKey]: productVersion
  };
  cache.buildIds = {
    ...cache.buildIds,
    [serverKey]: buildId
  };
  cache.updatedAt = new Date().toISOString();

  fs.writeFileSync(RESOURCE_VERSION_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');

  console.log(
    `client version cache saved -> ${serverKey}: ${clientVersionString} (resource ${resourceVersion})`
  );
}

function isClientMetadataCacheCurrent(serverKey, sourceVersion, productVersion, buildId) {
  const cache = readResourceVersionCache();

  return (
    cache.sourceVersions?.[serverKey] === sourceVersion &&
    cache.productVersions?.[serverKey] === productVersion &&
    cache.buildIds?.[serverKey] === buildId &&
    Boolean(cache.clientVersionStrings?.[serverKey])
  );
}

function getClientVersionStringCandidates({
  serverKey,
  detectedClientVersionStrings = [],
  webResourceVersion,
  productVersion,
  buildId
}) {
  const cache = readResourceVersionCache();
  const cachedResourceVersion = cache[serverKey];
  const cachedClientVersionString = cache.clientVersionStrings?.[serverKey];
  const overrideResourceVersion = getOverrideResourceVersion();
  const detectedResourceVersion = detectedClientVersionStrings
    .filter(value => /^WebGL_\d{4}-0\./.test(value))
    .map(normalizeResourceVersion)
    .filter(Boolean)
    .sort(compareDottedVersions)
    .at(-1);
  const cacheIsCurrent = isClientMetadataCacheCurrent(
    serverKey,
    webResourceVersion,
    productVersion,
    buildId
  );
  const resourceVersionCandidates = buildResourceVersionCandidates({
    cachedResourceVersion,
    detectedResourceVersion,
    overrideResourceVersion
  });

  return buildClientVersionStringCandidates({
    overrideClientVersionString: getOverrideClientVersionString(),
    detectedClientVersionStrings,
    cachedClientVersionString,
    resourceVersionCandidates,
    webResourceVersion,
    preferCachedClientVersion: cacheIsCurrent
  });
}

function isVersionStringError(error) {
  const message = error?.message || String(error);
  return (
    message.includes('version_str') ||
    message.includes('client_version_string')
  );
}

function isClientVersionProbeError(error) {
  return (
    isVersionStringError(error) ||
    (
      error instanceof MajsoulRpcError &&
      error.operation === 'oauth2Auth' &&
      error.rpcCode === 151
    )
  );
}

function buildRoutesUrl(gatewayUrl, version, lang) {
  const url = new URL(`${gatewayUrl.replace(/\/+$/, '')}/api/clientgate/routes`);
  url.searchParams.set('platform', 'Web');
  url.searchParams.set('version', version);

  if (lang) {
    url.searchParams.set('lang', lang);
  }

  url.searchParams.set('randv', buildRandv());
  return url;
}

function resolveClientVersionStrings({ productVersion } = {}) {
  const unityPackageCandidate =
    buildUnityWebGLClientVersionString(productVersion);

  console.log(
    `official Unity metadata -> product=${productVersion} package_candidate=${unityPackageCandidate}`
  );

  return [unityPackageCandidate];
}

function loadProtoTypes(liqiJson) {
  const root = protobuf.Root.fromJSON(liqiJson);

  return Object.fromEntries(
    Object.entries(PROTO_TYPES).map(([key, typeName]) => [key, root.lookupType(typeName)])
  );
}

function encode(type, payload) {
  const error = type.verify(payload);

  if (error) {
    fail(error);
  }

  return type.encode(payload).finish();
}

function shuffle(items) {
  const values = [...items];

  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }

  return values;
}

async function loadServerContext(server) {
  const { base, routeLang } = server;
  const versionUrl = new URL(buildUrl(base, 'version.json'));
  versionUrl.searchParams.set('randv', buildRandv());

  const [versionInfo, indexHtml] = await Promise.all([
    requestJson(versionUrl),
    requestText(buildUrl(base, 'index.html'))
  ]);

  must(versionInfo?.version, `Unexpected version payload: ${JSON.stringify(versionInfo)}`);

  const version = versionInfo.version;
  const codeDir = must(String(versionInfo.code || '').split('/')[0], 'Missing code directory for config fetch');
  const productVersion = parseProductVersion(indexHtml);
  const buildId = parseUnityBuildId(indexHtml);

  const [config, resManifest] = await Promise.all([
    requestJson(buildUrl(base, `${codeDir}/config.json`)),
    requestJson(buildUrl(base, `resversion${version}.json`))
  ]);

  const liqiPrefix = must(
    resManifest?.res?.['res/proto/liqi.json']?.prefix,
    'liqi prefix missing from resversion manifest'
  );
  console.log(`liqi prefix: ${liqiPrefix}`);

  const gatewayUrl = must(
    config?.ip?.find(entry => Array.isArray(entry?.gateways) && entry.gateways.length)?.gateways?.[0]?.url,
    'Gateway URL missing from config'
  ).replace(/\/+$/, '');

  const cacheIsCurrent = isClientMetadataCacheCurrent(
    server.key,
    version,
    productVersion,
    buildId
  );
  let detectedClientVersionStrings = [];

  if (cacheIsCurrent) {
    console.log('client metadata unchanged -> using the last successful cached settings');
  } else {
    console.log('client metadata update detected -> refreshing official version sources');
    detectedClientVersionStrings = resolveClientVersionStrings({
      productVersion
    });
  }

  const clientVersionStringCandidates = getClientVersionStringCandidates({
    serverKey: server.key,
    detectedClientVersionStrings,
    webResourceVersion: version,
    productVersion,
    buildId
  });

  console.log(`version.json -> version=${version} force_version=${versionInfo.force_version} code=${versionInfo.code}`);
  console.log(`Unity build -> ${buildId} (productVersion=${productVersion})`);
  console.log(
    `client version candidates -> ${clientVersionStringCandidates.slice(0, 8).join(', ')}${
      clientVersionStringCandidates.length > 8
        ? ` ... total=${clientVersionStringCandidates.length}`
        : ''
    }`
  );

  const [routes, liqiJson] = await Promise.all([
    requestJson(buildRoutesUrl(gatewayUrl, productVersion, routeLang)),
    requestJson(buildUrl(base, `${liqiPrefix.replace(/^\/+/, '')}/res/proto/liqi.json`))
  ]);

  const routeList = routes?.data?.routes?.filter(route => route?.id && route?.domain) ?? [];

  if (!routeList.length) {
    fail('No available gateway servers found.');
  }

  const routesToTry = shuffle(routeList).map(route => ({
    id: route.id,
    endpoint: `wss://${route.domain}/gateway`
  }));

  console.log(`available gateway routes: ${routesToTry.map(route => route.id).join(', ')}`);

  return {
    server,
    base,
    routes: routesToTry,
    version,
    productVersion,
    buildId,
    clientVersionStringCandidates,
    proto: loadProtoTypes(liqiJson)
  };
}

async function openChannel(endpoint, origin, Wrapper) {
  const ws = new WebSocket(endpoint, { origin, perMessageDeflate: false });
  const pending = new Map();
  let nextRequestId = 1;

  const settlePending = error => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }

    pending.clear();
  };

  await new Promise((resolve, reject) => {
    const openTimeout = setTimeout(() => {
      cleanup();
      ws.terminate();
      reject(new Error(`WebSocket connection timeout for ${endpoint}`));
    }, 15000);

    const cleanup = () => {
      clearTimeout(openTimeout);
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = error => {
      cleanup();
      reject(error);
    };

    ws.once('open', onOpen);
    ws.once('error', onError);
  });

  ws.on('message', data => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buffer[0] !== 3) {
      return;
    }

    const requestId = buffer.readUInt16LE(1);
    const request = pending.get(requestId);

    if (!request) {
      return;
    }

    pending.delete(requestId);
    clearTimeout(request.timeout);

    try {
      request.resolve(Wrapper.decode(buffer.subarray(3)));
    } catch (error) {
      request.reject(error);
    }
  });

  ws.on('error', settlePending);
  ws.on('close', () => settlePending(new Error('WebSocket connection closed.')));

  return {
    send(name, payload) {
      const requestId = nextRequestId;
      nextRequestId = (nextRequestId + 1) % 60007 || 1;

      const header = Buffer.alloc(3);
      header.writeUInt8(0x02, 0);
      header.writeUInt16LE(requestId, 1);

      const wrapper = Wrapper.encode(Wrapper.create({ name, data: payload })).finish();
      const packet = Buffer.concat([header, Buffer.from(wrapper)]);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`RPC request timeout for ${name}`));
        }, 15000);

        pending.set(requestId, {
          timeout,
          resolve,
          reject
        });

        ws.send(packet, error => {
          if (!error) {
            return;
          }

          clearTimeout(timeout);
          pending.delete(requestId);
          reject(error);
        });
      });
    },

    async close() {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        return;
      }

      await new Promise(resolve => {
        let settled = false;
        let forceCloseTimeout;
        const finish = () => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(forceCloseTimeout);
          ws.removeListener('close', finish);
          resolve();
        };
        forceCloseTimeout = setTimeout(() => {
          ws.terminate();
          finish();
        }, 2000);

        ws.once('close', finish);
        ws.close();
      });
    }
  };
}

async function createSessionForRoute(context, route, credentials) {
  const { server, proto, clientMetadata } = context;
  const {
    uid,
    token,
    accessToken: configuredAccessToken,
    email,
    password
  } = credentials;
  const authState = credentials.authState || (credentials.authState = {});
  const device = buildDevice(server);

  console.log(`trying gateway route ${route.id}: ${route.endpoint}`);

  const channel = await openChannel(route.endpoint, server.origin, proto.Wrapper);

  const call = async (name, requestType, payload, responseType) => {
    try {
      const wrapper = await channel.send(name, encode(requestType, payload));
      return responseType ? responseType.decode(wrapper.data) : wrapper;
    } catch (error) {
      await channel.close().catch(() => {});
      throw error;
    }
  };

  const requireSuccess = async (operation, response) => {
    try {
      return requireRpcSuccess(operation, response);
    } catch (error) {
      await channel.close().catch(() => {});
      throw error;
    }
  };

  const common = (name, responseType) => call(name, proto.ReqCommon, {}, responseType);

  await requireSuccess(
    'requestConnection',
    await call(
      '.lq.Route.requestConnection',
      proto.ReqRequestConnection,
      {
        type: 1,
        route_id: route.id,
        timestamp: Date.now()
      },
      proto.ResRequestConnection
    )
  );

  await requireSuccess(
    'heartbeat',
    await call(
      '.lq.Route.heartbeat',
      proto.ReqHeartbeat,
      {
        delay: 0,
        no_operation_counter: 0,
        platform: 11,
        network_quality: 0
      },
      proto.ResHeartbeat
    )
  );

  if (server.loginMode === 'account_password') {
    const loginResponse = await requireSuccess(
      'login',
      await call(
        '.lq.Lobby.login',
        proto.ReqLogin,
        buildPasswordLoginPayload({
          account: email,
          password: hashCnPassword(password),
          device,
          randomKey: randomUUID(),
          clientVersion: clientMetadata.clientVersion,
          clientVersionString: clientMetadata.clientVersionString,
          currencyPlatforms: server.currencyPlatforms,
          loginType: server.loginType,
          tag: server.tag
        }),
        proto.ResOauth2Login
      )
    );

    if (!loginResponse.account) {
      fail('login failed: account not found.');
    }

    return {
      proto,
      common,
      call,
      close: () => channel.close(),
      loginGold: Number(loginResponse.account.gold ?? 0)
    };
  }

  const requestOauth2Check = accessToken => call(
    '.lq.Lobby.oauth2Check',
    proto.ReqOauth2Check,
    {
      type: server.oauthType,
      access_token: accessToken
    },
    proto.ResOauth2Check
  );

  let accessToken = authState.configuredAccessTokenRejected
    ? null
    : configuredAccessToken;
  let checkResponse;

  if (accessToken) {
    console.log('using configured MahjongSoul access token');
    const configuredCheckResponse = await requestOauth2Check(accessToken);

    if (
      shouldRetryWithOauthCode(configuredCheckResponse, {
        uid,
        token
      })
    ) {
      console.warn(
        'configured access token was not accepted -> retrying the official UID/TOKEN login flow'
      );
      authState.configuredAccessTokenRejected = true;
      accessToken = null;
    } else {
      checkResponse = await requireSuccess('oauth2Check', configuredCheckResponse);
    }
  } else if (
    server.loginMode === 'oauth_code' &&
    !authState.tokenAccessCheckRejected
  ) {
    const directCheckResponse = await requestOauth2Check(token);
    const directCheckCode = Number(directCheckResponse?.error?.code ?? 0);

    if (directCheckCode === 0 && directCheckResponse?.has_account) {
      console.log('TOKEN contains a reusable MahjongSoul access token');
      accessToken = token;
      checkResponse = directCheckResponse;
    } else {
      authState.tokenAccessCheckRejected = true;
    }
  }

  if (!accessToken && server.loginMode === 'oauth_code') {
    const authResponse = await requireSuccess(
      'oauth2Auth',
      await call(
        '.lq.Lobby.oauth2Auth',
        proto.ReqOauth2Auth,
        buildOauth2AuthPayload({
          oauthType: server.oauthType,
          token,
          uid,
          clientVersionString: clientMetadata.clientVersionString
        }),
        proto.ResOauth2Auth
      )
    );

    accessToken = must(authResponse?.access_token, `oauth2Auth failed: ${JSON.stringify(authResponse)}`);
  }

  if (!checkResponse) {
    checkResponse = await requireSuccess(
      'oauth2Check',
      await requestOauth2Check(accessToken)
    );
  }

  if (!checkResponse?.has_account) {
    fail(`oauth2Check failed: ${JSON.stringify(checkResponse)}`);
  }

  const loginResponse = await requireSuccess(
    'oauth2Login',
    await call(
      '.lq.Lobby.oauth2Login',
      proto.ReqOauth2Login,
      buildOauth2LoginPayload({
        oauthType: server.oauthType,
        accessToken,
        device,
        randomKey: randomUUID(),
        clientVersion: clientMetadata.clientVersion,
        clientVersionString: clientMetadata.clientVersionString,
        currencyPlatforms: server.currencyPlatforms,
        tag: server.tag
      }),
      proto.ResOauth2Login
    )
  );

  if (!loginResponse.account) {
    fail('oauth2Login failed: account not found.');
  }

  return {
    proto,
    common,
    call,
    close: () => channel.close(),
    loginGold: Number(loginResponse.account.gold ?? 0)
  };
}

async function createSessionWithRoutes(context, credentials) {
  const errors = [];

  for (const route of context.routes) {
    try {
      return await createSessionForRoute(context, route, credentials);
    } catch (error) {
      errors.push({ route: route.id, message: error?.message || String(error) });
      console.warn(`gateway route ${route.id} failed: ${error?.message || error}`);

      if (error instanceof MajsoulRpcError || isVersionStringError(error)) {
        throw error;
      }
    }
  }

  fail(`All gateway routes failed: ${JSON.stringify(errors)}`);
}

async function createSession(context, credentials) {
  const errors = [];
  const clientVersionStringCandidates =
    context.clientVersionStringCandidates.slice(0, MAX_CLIENT_VERSION_PROBES);
  const sessionCredentials = {
    ...credentials,
    authState: {}
  };

  if (context.clientVersionStringCandidates.length > clientVersionStringCandidates.length) {
    console.log(
      `client version recovery is armed; at most ${MAX_CLIENT_VERSION_PROBES} candidates will be tried only if the fast path is rejected`
    );
  }

  for (let index = 0; index < clientVersionStringCandidates.length; index += 1) {
    const clientVersionString = clientVersionStringCandidates[index];
    const clientMetadata = buildClientMetadata({
      productVersion: context.productVersion,
      resourceVersion: context.version,
      clientVersionString
    });

    const candidateContext = {
      ...context,
      clientMetadata
    };

    console.log(
      `trying resource version: ${clientMetadata.clientVersion.resource} -> ${clientMetadata.clientVersionString}`
    );

    try {
      const session = await createSessionWithRoutes(candidateContext, sessionCredentials);
      saveSuccessfulClientVersion(
        context.server.key,
        {
          resourceVersion: clientMetadata.clientVersion.resource,
          clientVersionString: clientMetadata.clientVersionString,
          sourceVersion: context.version,
          productVersion: context.productVersion,
          buildId: context.buildId
        }
      );
      return session;
    } catch (error) {
      const message = error?.message || String(error);

      if (!isClientVersionProbeError(error)) {
        error.resourceVersion = clientMetadata.clientVersion.resource;
        error.clientVersionString = clientMetadata.clientVersionString;
        throw error;
      }

      errors.push({
        clientVersionString: clientMetadata.clientVersionString,
        operation: error?.operation,
        rpcCode: error?.rpcCode,
        message
      });

      console.warn(`client version rejected: ${clientMetadata.clientVersionString}`);

      if (index + 1 < clientVersionStringCandidates.length) {
        await delay(CLIENT_VERSION_PROBE_DELAY_MS);
      }
    }
  }

  const error = new Error(
    `All supported client metadata candidates were rejected during authentication: ${JSON.stringify(errors)}`
  );
  error.yostarAuthRejected = errors.some(
    candidate =>
      candidate.operation === 'oauth2Auth' &&
      candidate.rpcCode === 151
  );
  error.retryable = false;
  throw error;
}

async function runActions(session) {
  const { proto, common, call, loginGold } = session;

  console.log('oauth2Login.account.gold:', loginGold);

  const payResponse = await common('.lq.Lobby.payMonthTicket', proto.ResPayMonthTicket);
  console.log('payMonthTicket:', JSON.stringify(payResponse));

  const infoResponse = await common('.lq.Lobby.fetchMonthTicketInfo', proto.ResFetchMonthTicketInfo);
  console.log('fetchMonthTicketInfo:', JSON.stringify(infoResponse));

  if (!BUY_GREEN_GIFT) {
    return;
  }

  const gainReviveCoinResponse = await common('.lq.Lobby.gainReviveCoin', proto.ResCommon);
  const gainReviveCoinErrorCode = Number(gainReviveCoinResponse?.error?.code ?? 0);

  if (gainReviveCoinErrorCode === 0) {
    console.log('gainReviveCoin: success');
  } else {
    console.log('gainReviveCoin: skipped', JSON.stringify(gainReviveCoinResponse));
  }

  const latestGold = loginGold + (gainReviveCoinErrorCode === 0 ? REVIVE_COIN_GOLD_BONUS : 0);
  console.log('estimatedGoldForPurchase:', latestGold);

  const shopInfoResponse = await common('.lq.Lobby.fetchShopInfo', proto.ResShopInfo);
  const zhpGoods = shopInfoResponse.shop_info?.zhp?.goods;

  if (!zhpGoods) {
    fail('fetchShopInfo failed: shop_info.zhp not found.');
  }

  console.log('fetchShopInfo.shop_info.zhp.goods:', JSON.stringify(zhpGoods));

  const greenGoodsIds = zhpGoods.slice(0, 4).map(Number).filter(id => Number.isInteger(id) && id > 0);
  const maxTotalBuyable = Math.floor(latestGold / GREEN_GIFT_PRICE_GOLD);
  let remainingPurchaseCount = Math.min(maxTotalBuyable, greenGoodsIds.length * GREEN_GIFT_MAX_COUNT_PER_GOODS);
  let spentGold = 0;
  const purchasePlan = [];

  for (const goodsId of greenGoodsIds) {
    if (remainingPurchaseCount <= 0) {
      break;
    }

    const count = Math.min(GREEN_GIFT_MAX_COUNT_PER_GOODS, remainingPurchaseCount);

    const buyResponse = await call(
      '.lq.Lobby.buyFromZHP',
      proto.ReqBuyFromZHP,
      { goods_id: goodsId, count },
      proto.ResCommon
    );

    const errorCode = Number(buyResponse?.error?.code ?? 0);

    if (errorCode === BUY_FROM_ZHP_LIMIT_REACHED_CODE) {
      console.log(
        `buyFromZHP: skip all purchases for this run (goods_id=${goodsId}, count=${count}, purchase limit reached):`,
        JSON.stringify(buyResponse)
      );
      break;
    }

    if (errorCode !== 0) {
      fail(`buyFromZHP failed for goods_id=${goodsId} count=${count}: ${JSON.stringify(buyResponse)}`);
    }

    purchasePlan.push({ goods_id: goodsId, count });
    remainingPurchaseCount -= count;
    spentGold += count * GREEN_GIFT_PRICE_GOLD;
  }

  console.log('buyFromZHP.purchasePlan:', JSON.stringify(purchasePlan));
  console.log('buyFromZHP.spentGold:', spentGold);
  console.log('buyFromZHP.remainingGoldEstimate:', Math.max(0, latestGold - spentGold));
}

function loadRuntimeConfig() {
  const server = getServerConfig(process.env.MS_SERVER);
  const baseUid = normalizeSecretCredential(process.env.UID, 'UID');
  const baseToken = normalizeSecretCredential(process.env.TOKEN, 'TOKEN');
  const accessToken = normalizeSecretCredential(
    process.env.ACCESS_TOKEN,
    'ACCESS_TOKEN'
  );
  const configuredYostarDeviceId = normalizeSecretCredential(
    process.env.YOSTAR_DEVICE_ID,
    'YOSTAR_DEVICE_ID'
  );
  const email = process.env.EMAIL;
  const password = process.env.PASSWORD;
  const tokenCache =
    server.key === 'jp' && baseUid && baseToken
      ? readTokenCache(baseUid, baseToken)
      : null;
  const uid = tokenCache?.uid || baseUid;
  const token = tokenCache?.token || baseToken;

  if (server.loginMode === 'account_password') {
    if (!email || !password) {
      fail('EMAIL and PASSWORD environment variables are required for CN server.');
    }
  } else if (!accessToken && (!uid || !token)) {
    fail('Set ACCESS_TOKEN, or both UID and TOKEN, for JP/EN/KR servers.');
  }

  if (tokenCache) {
    console.log('encrypted YoStar login cache loaded');
  }

  return {
    uid,
    token,
    baseUid,
    baseToken,
    yostarDeviceId: configuredYostarDeviceId || tokenCache?.deviceId,
    yostarMetadata: tokenCache?.webSdkMetadata,
    accessToken,
    email,
    password,
    server
  };
}

function shouldRetryWithOauthCode(checkResponse, { uid, token } = {}) {
  const rpcCode = Number(checkResponse?.error?.code ?? 0);
  const accessTokenIsUsable = rpcCode === 0 && checkResponse?.has_account;

  return Boolean(uid && token && !accessTokenIsUsable);
}

function shouldRefreshYostarCredentials(error, credentials) {
  return Boolean(
    error?.yostarAuthRejected &&
    credentials?.server?.key === 'jp' &&
    credentials?.uid &&
    credentials?.token &&
    credentials?.baseUid &&
    credentials?.baseToken
  );
}

function buildYostarCredentialCandidates(credentials, refreshed) {
  const candidates = [
    {
      ...credentials,
      uid: refreshed.uid,
      token: refreshed.token,
      accessToken: null
    }
  ];

  if (
    refreshed.responseUid &&
    refreshed.responseToken &&
    (
      refreshed.responseUid !== refreshed.uid ||
      refreshed.responseToken !== refreshed.token
    )
  ) {
    candidates.push({
      ...credentials,
      uid: refreshed.responseUid,
      token: refreshed.responseToken,
      accessToken: null
    });
  }

  return candidates;
}

async function createSessionWithYostarRefresh(context, credentials) {
  let credentialCandidates = [credentials];
  let refreshed;
  let refreshError;

  if (
    credentials.server.key === 'jp' &&
    credentials.uid &&
    credentials.token &&
    credentials.baseUid &&
    credentials.baseToken
  ) {
    try {
      try {
        refreshed = await refreshYostarCredentials({
          gameBase: credentials.server.base,
          uid: credentials.uid,
          token: credentials.token,
          deviceId: credentials.yostarDeviceId,
          metadata: credentials.yostarMetadata
        });
      } catch (error) {
        if (!credentials.yostarMetadata) {
          throw error;
        }

        console.warn(
          'cached YoStar WebSDK metadata was rejected -> refreshing official SDK metadata'
        );
        refreshed = await refreshYostarCredentials({
          gameBase: credentials.server.base,
          uid: credentials.uid,
          token: credentials.token,
          deviceId: credentials.yostarDeviceId
        });
      }

      credentialCandidates = buildYostarCredentialCandidates(
        credentials,
        refreshed
      );
      console.log('YoStar login token validated before game authentication');
    } catch (error) {
      refreshError = error;
      console.warn(
        error?.yostarCode === 100403
          ? 'YoStar login token is expired; trying the remaining configured game credential'
          : `YoStar login validation was unavailable: ${error?.message || error}`
      );
    }
  }

  let session;
  let successfulCredentials;

  for (let index = 0; index < credentialCandidates.length; index += 1) {
    const activeCredentials = credentialCandidates[index];

    try {
      session = await createSession(context, activeCredentials);
      successfulCredentials = activeCredentials;
      break;
    } catch (error) {
      const hasQuickLoginResponseFallback =
        index + 1 < credentialCandidates.length &&
        error?.yostarAuthRejected;

      if (hasQuickLoginResponseFallback) {
        console.warn(
          'official YoStar login credential was rejected -> trying quick-login response credential'
        );
        continue;
      }

      if (
        shouldRefreshYostarCredentials(error, credentials) &&
        refreshError?.yostarCode === 100403
      ) {
        const expiredError = new Error(
          'YoStar login token expired (WebSDK code 100403). ' +
          'Issue a fresh LOGIN_UID/LOGIN_TOKEN once with test_sdk.Login and update ' +
          'the repository UID/TOKEN secrets; later runs will renew and cache it automatically.'
        );
        expiredError.retryable = false;
        expiredError.yostarCode = 100403;
        throw expiredError;
      }

      if (refreshError && !refreshError.yostarCode) {
        error.retryable = true;
      }

      throw error;
    }
  }

  if (refreshed && successfulCredentials) {
    saveTokenCache(
      {
        uid: successfulCredentials.uid,
        token: successfulCredentials.token,
        deviceId: refreshed.deviceId,
        webSdkMetadata: refreshed.metadata,
        updatedAt: new Date().toISOString()
      },
      credentials.baseUid,
      credentials.baseToken
    );
    console.log('validated YoStar login state saved to encrypted runtime cache');
  }

  return session;
}

async function run() {
  const credentials = loadRuntimeConfig();
  const { server } = credentials;

  console.log(`selected server: ${server.key}`);

  let session;

  for (let attempt = 1; attempt <= SESSION_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      const context = await loadServerContext(server);
      session = await createSessionWithYostarRefresh(context, credentials);
      break;
    } catch (error) {
      const shouldRetry =
        error?.retryable !== false &&
        !(error instanceof MajsoulRpcError) &&
        !isVersionStringError(error) &&
        attempt < SESSION_BOOTSTRAP_ATTEMPTS;

      if (!shouldRetry) {
        throw error;
      }

      console.warn(
        `session bootstrap attempt ${attempt}/${SESSION_BOOTSTRAP_ATTEMPTS} failed: ${error?.message || error}`
      );
      await delay(1000 * 2 ** (attempt - 1));
    }
  }

  if (!session) {
    fail('Session bootstrap ended without a session.');
  }

  try {
    await runActions(session);
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error?.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildYostarCredentialCandidates,
  createSession,
  getServerConfig,
  getClientVersionStringCandidates,
  isClientVersionProbeError,
  isVersionStringError,
  loadRuntimeConfig,
  loadServerContext,
  MajsoulRpcError,
  normalizeSecretCredential,
  requireRpcSuccess,
  run,
  runActions,
  shouldRefreshYostarCredentials,
  shouldRetryWithOauthCode
};
