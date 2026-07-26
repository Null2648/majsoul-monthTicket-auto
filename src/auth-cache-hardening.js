const fs = require('node:fs');
const path = require('node:path');
const original = require('./yostar-websdk');

const MAX_AUTH_CACHE_BYTES = 512 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_CREDENTIAL_CHARS = 16384;
const MAX_DEVICE_ID_CHARS = 256;

function decodedBase64Length(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
  try { return Buffer.from(value, 'base64').length; } catch { return -1; }
}

function validateEncryptedCacheEnvelope(cache) {
  if (!cache || cache.version !== 1 || cache.algorithm !== 'aes-256-gcm') return false;
  if (decodedBase64Length(cache.iv) !== 12) return false;
  if (decodedBase64Length(cache.tag) !== 16) return false;
  const ciphertextLength = decodedBase64Length(cache.ciphertext);
  return ciphertextLength > 0 && ciphertextLength <= MAX_AUTH_CACHE_BYTES;
}

function validateCachePayload(payload, expectedUid) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (String(payload.uid || '') !== String(expectedUid || '')) return false;
  if (
    typeof payload.token !== 'string' || !payload.token ||
    payload.token.length > MAX_CREDENTIAL_CHARS
  ) return false;
  if (
    payload.deviceId != null &&
    (typeof payload.deviceId !== 'string' || payload.deviceId.length > MAX_DEVICE_ID_CHARS)
  ) return false;
  if (payload.webSdkMetadata != null) {
    let serialized;
    try { serialized = JSON.stringify(payload.webSdkMetadata); } catch { return false; }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) return false;
  }
  return true;
}

function assertBaseCredentials(uid, baseToken) {
  if (!uid || !baseToken) throw new Error('UID and base token are required for encrypted cache');
  if (String(uid).length > MAX_CREDENTIAL_CHARS || String(baseToken).length > MAX_CREDENTIAL_CHARS) {
    throw new Error('Authentication credential exceeds the cache safety limit');
  }
}

function readTokenCache(uid, baseToken, cachePath = original.AUTH_CACHE_PATH) {
  try {
    assertBaseCredentials(uid, baseToken);
    const stat = fs.lstatSync(cachePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_AUTH_CACHE_BYTES) {
      return null;
    }
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!validateEncryptedCacheEnvelope(cache)) return null;
    const payload = original.decryptTokenCache(cache, String(uid), String(baseToken));
    return validateCachePayload(payload, uid) ? payload : null;
  } catch {
    return null;
  }
}

function saveTokenCache(payload, uid, baseToken, cachePath = original.AUTH_CACHE_PATH) {
  assertBaseCredentials(uid, baseToken);
  if (!validateCachePayload(payload, uid)) {
    throw new Error('Refusing to save an invalid or oversized authentication cache payload');
  }
  const encrypted = original.encryptTokenCache(payload, String(uid), String(baseToken));
  if (!validateEncryptedCacheEnvelope(encrypted)) {
    throw new Error('Generated authentication cache envelope failed validation');
  }
  const serialized = `${JSON.stringify(encrypted, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AUTH_CACHE_BYTES) {
    throw new Error('Generated authentication cache exceeds the safety limit');
  }

  const directory = path.dirname(cachePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(cachePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, cachePath);
  } finally {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
  }
}

module.exports = {
  MAX_AUTH_CACHE_BYTES,
  MAX_CREDENTIAL_CHARS,
  MAX_DEVICE_ID_CHARS,
  MAX_METADATA_BYTES,
  readTokenCache,
  saveTokenCache,
  validateCachePayload,
  validateEncryptedCacheEnvelope
};