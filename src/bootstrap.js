const {
  prepareOfficialStructureFallbacks
} = require('./official-structure-fallbacks');

async function bootstrap() {
  try {
    await prepareOfficialStructureFallbacks();
  } catch (error) {
    console.warn(
      `official structure discovery unavailable: ${error?.message || error}; continuing with legacy paths`
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
}

if (require.main === module) {
  bootstrap().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = { bootstrap };
