const {
  prepareOfficialClientVersionDiscovery
} = require('./official-client-version');

async function bootstrap() {
  try {
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
