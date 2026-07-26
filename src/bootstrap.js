const {
  installGlobalMetadataFetchGuard,
  scopeStructureFetch
} = require('./network-hardening');
const {
  prepareOfficialStructureFallbacks
} = require('./official-structure-fallbacks');
const {
  finalizeProtocolSnapshot,
  prepareProtocolMonitor
} = require('./protocol-monitor-hardened');
const {
  clearAutomationFailureReport,
  writeAutomationFailureReport
} = require('./automation-alert');
const {
  installHardenedWebSocket
} = require('./websocket-hardening');

function installHardenedYostarExports() {
  const current = require('./yostar-websdk');
  const safe = require('./yostar-websdk-safe');
  const cache = require('./auth-cache-hardening');
  current.loadOfficialWebSdkMetadata = safe.loadOfficialWebSdkMetadata;
  current.loadOfficialWebSdkMetadataCandidates = safe.loadOfficialWebSdkMetadataCandidates;
  current.refreshYostarCredentials = safe.refreshYostarCredentials;
  current.readTokenCache = cache.readTokenCache;
  current.saveTokenCache = cache.saveTokenCache;
}

function wrapProtocolSafetyError(error) {
  if (error?.code === 'PROTOCOL_BREAKING_CHANGE') return error;
  const wrapped = new Error(
    `Protocol safety validation could not complete before attendance: ${error?.message || error}`,
    { cause: error }
  );
  wrapped.code = error?.code || 'PROTOCOL_SAFETY_UNAVAILABLE';
  wrapped.retryable = false;
  return wrapped;
}

async function bootstrap() {
  let structure;
  clearAutomationFailureReport();
  installGlobalMetadataFetchGuard();
  installHardenedWebSocket();
  installHardenedYostarExports();

  try {
    structure = await prepareOfficialStructureFallbacks();
    scopeStructureFetch(structure);
  } catch (error) {
    console.warn(
      `official structure discovery first pass unavailable: ${error?.message || error}; ` +
      'the mandatory protocol check will retry discovery'
    );
  }

  try {
    await prepareProtocolMonitor({ structure });
  } catch (error) {
    throw wrapProtocolSafetyError(error);
  }

  try {
    const {
      prepareOfficialClientVersionDiscovery
    } = require('./official-client-version');
    await prepareOfficialClientVersionDiscovery();
  } catch (error) {
    console.warn(
      `official client discovery unavailable: ${error?.message || error}; continuing with generated recovery candidates`
    );
  }

  const { run } = require('./index');
  await run();

  const changed = finalizeProtocolSnapshot();
  if (changed) console.log('protocol baseline updated after successful attendance');
}

if (require.main === module) {
  bootstrap().catch(error => {
    try {
      writeAutomationFailureReport(error);
    } catch (reportError) {
      console.warn(`automation failure report could not be written: ${reportError?.message || reportError}`);
    }
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  bootstrap,
  installHardenedYostarExports,
  wrapProtocolSafetyError
};