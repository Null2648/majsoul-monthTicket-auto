const {
  prepareOfficialStructureFallbacks
} = require('./official-structure-fallbacks');
const {
  finalizeProtocolSnapshot,
  prepareProtocolMonitor
} = require('./protocol-monitor');
const {
  clearAutomationFailureReport,
  writeAutomationFailureReport
} = require('./automation-alert');

async function bootstrap() {
  let structure;
  let protocolPrepared = false;
  clearAutomationFailureReport();

  try {
    structure = await prepareOfficialStructureFallbacks();
  } catch (error) {
    console.warn(
      `official structure discovery unavailable: ${error?.message || error}; continuing with legacy paths`
    );
  }

  try {
    await prepareProtocolMonitor({ structure });
    protocolPrepared = true;
  } catch (error) {
    if (error?.code === 'PROTOCOL_BREAKING_CHANGE') {
      throw error;
    }
    console.warn(
      `protocol monitor unavailable: ${error?.message || error}; continuing with the live protocol loader`
    );
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

  if (protocolPrepared) {
    const changed = finalizeProtocolSnapshot();
    if (changed) {
      console.log('protocol baseline updated after successful attendance');
    }
  }
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

module.exports = { bootstrap };
