const { Buffer } = require('node:buffer');
const { isUnsafeNetworkHostname } = require('./network-hardening');
const { isWithinAutomaticLoginWindow } = require('./attendance-schedule');

const INSTALL_STATE = Symbol.for('majsoul.hardenedWebSocket');
const GATEWAY_BUDGET_STATE = Symbol.for('majsoul.gatewayAttemptBudget');
const MAX_GATEWAY_PAYLOAD_BYTES = 4 * 1024 * 1024;
const GATEWAY_HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_GATEWAY_CONNECTION_ATTEMPTS = 24;
const MAX_GATEWAY_ATTEMPT_WINDOW_MS = 4 * 60 * 1000;

function validateGatewayEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Invalid MahjongSoul gateway WebSocket endpoint');
  }
  if (url.protocol !== 'wss:') throw new Error('MahjongSoul gateway must use wss');
  if (url.username || url.password) throw new Error('MahjongSoul gateway must not contain credentials');
  if (url.pathname !== '/gateway' || url.search || url.hash) {
    throw new Error('MahjongSoul gateway endpoint must use the exact /gateway path');
  }
  if (isUnsafeNetworkHostname(url.hostname)) {
    throw new Error(`MahjongSoul gateway resolved to an unsafe host: ${url.hostname}`);
  }
  return url.toString();
}

function assertScheduledGatewayWindow(now = new Date(), env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'schedule') return;
  if (isWithinAutomaticLoginWindow(now)) return;
  const error = new Error(
    'Scheduled gateway login was blocked because the 06:00-06:24 KST safety window has ended'
  );
  error.code = 'OUTSIDE_SAFE_LOGIN_WINDOW';
  error.retryable = false;
  throw error;
}

function consumeGatewayAttempt({ now = Date.now(), env = process.env } = {}) {
  assertScheduledGatewayWindow(new Date(now), env);
  let state = globalThis[GATEWAY_BUDGET_STATE];
  if (!state) {
    state = { startedAt: now, attempts: 0 };
    globalThis[GATEWAY_BUDGET_STATE] = state;
  }
  if (now - state.startedAt > MAX_GATEWAY_ATTEMPT_WINDOW_MS) {
    const error = new Error('Gateway authentication recovery exceeded its total time budget');
    error.code = 'GATEWAY_ATTEMPT_BUDGET_EXCEEDED';
    error.retryable = false;
    throw error;
  }
  state.attempts += 1;
  if (state.attempts > MAX_GATEWAY_CONNECTION_ATTEMPTS) {
    const error = new Error(
      `Gateway authentication recovery exceeded ${MAX_GATEWAY_CONNECTION_ATTEMPTS} connection attempts`
    );
    error.code = 'GATEWAY_ATTEMPT_BUDGET_EXCEEDED';
    error.retryable = false;
    throw error;
  }
  return { ...state };
}

function resetGatewayAttemptBudget() {
  delete globalThis[GATEWAY_BUDGET_STATE];
}

function frameByteLength(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return Buffer.byteLength(String(data || ''));
}

function installHardenedWebSocket({ maxPayload = MAX_GATEWAY_PAYLOAD_BYTES } = {}) {
  const existing = globalThis[INSTALL_STATE];
  if (existing) return existing;

  const modulePath = require.resolve('ws');
  const OriginalWebSocket = require(modulePath);
  const messageWrappers = new WeakMap();

  class HardenedWebSocket extends OriginalWebSocket {
    constructor(address, protocols, options) {
      const endpoint = validateGatewayEndpoint(address);
      consumeGatewayAttempt();
      let resolvedProtocols = protocols;
      let resolvedOptions = options;
      if (
        protocols && typeof protocols === 'object' &&
        !Array.isArray(protocols) && !(protocols instanceof String)
      ) {
        resolvedOptions = protocols;
        resolvedProtocols = undefined;
      }
      const requestedMax = Number(resolvedOptions?.maxPayload);
      const payloadLimit = Number.isFinite(requestedMax) && requestedMax > 0
        ? Math.min(requestedMax, maxPayload)
        : maxPayload;
      const hardenedOptions = {
        ...(resolvedOptions || {}),
        perMessageDeflate: false,
        maxPayload: payloadLimit,
        handshakeTimeout: Math.min(
          Number(resolvedOptions?.handshakeTimeout) || GATEWAY_HANDSHAKE_TIMEOUT_MS,
          GATEWAY_HANDSHAKE_TIMEOUT_MS
        )
      };
      if (resolvedProtocols === undefined) super(endpoint, hardenedOptions);
      else super(endpoint, resolvedProtocols, hardenedOptions);
      this.__majsoulMaxPayload = payloadLimit;
    }

    on(eventName, listener) {
      if (eventName !== 'message' || typeof listener !== 'function') {
        return super.on(eventName, listener);
      }
      const wrapped = (data, isBinary) => {
        const length = frameByteLength(data);
        if (length < 3 || length > this.__majsoulMaxPayload) {
          this.terminate();
          return;
        }
        return listener.call(this, data, isBinary);
      };
      messageWrappers.set(listener, wrapped);
      return super.on(eventName, wrapped);
    }

    addListener(eventName, listener) {
      return this.on(eventName, listener);
    }

    removeListener(eventName, listener) {
      return super.removeListener(eventName, messageWrappers.get(listener) || listener);
    }

    off(eventName, listener) {
      return this.removeListener(eventName, listener);
    }
  }

  require.cache[modulePath].exports = HardenedWebSocket;
  const state = { OriginalWebSocket, HardenedWebSocket, maxPayload };
  globalThis[INSTALL_STATE] = state;
  return state;
}

module.exports = {
  GATEWAY_ATTEMPT_BUDGET_STATE: GATEWAY_BUDGET_STATE,
  GATEWAY_HANDSHAKE_TIMEOUT_MS,
  INSTALL_STATE,
  MAX_GATEWAY_ATTEMPT_WINDOW_MS,
  MAX_GATEWAY_CONNECTION_ATTEMPTS,
  MAX_GATEWAY_PAYLOAD_BYTES,
  assertScheduledGatewayWindow,
  consumeGatewayAttempt,
  frameByteLength,
  installHardenedWebSocket,
  resetGatewayAttemptBudget,
  validateGatewayEndpoint
};