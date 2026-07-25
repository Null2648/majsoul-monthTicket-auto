const {
  prepareOfficialStructureFallbacks
} = require('../src/official-structure-fallbacks');

async function check() {
  const structure = await prepareOfficialStructureFallbacks({
    serverKey: 'jp',
    forceRefresh: true
  });
  const {
    prepareOfficialClientVersionDiscovery
  } = require('../src/official-client-version');
  const discovery = await prepareOfficialClientVersionDiscovery({
    serverKey: 'jp',
    forceRefresh: true
  });

  if (!discovery.strings.length) {
    throw new Error(
      `No exact JP client_version_string was found in ${discovery.assetUrls.length} official JavaScript assets`
    );
  }

  const {
    getServerConfig,
    loadServerContext
  } = require('../src/index');
  const server = getServerConfig('jp');
  const context = await loadServerContext(server);
  const missing = discovery.strings.filter(
    value => !context.clientVersionStringCandidates.includes(value)
  );

  if (missing.length) {
    throw new Error(
      `Official JP client strings were not installed as candidates: ${missing.join(', ')}`
    );
  }

  if (context.productVersion !== structure.productVersion) {
    throw new Error(
      `Official productVersion mismatch: structure=${structure.productVersion}, context=${context.productVersion}`
    );
  }

  if (context.buildId !== structure.buildId) {
    throw new Error(
      `Official Unity build mismatch: structure=${structure.buildId}, context=${context.buildId}`
    );
  }

  console.log(
    `JP client metadata is current: product=${context.productVersion}, ` +
    `build=${context.buildId}, resource=${context.version}, ` +
    `exact=${discovery.strings.join(', ')}, candidate=${context.clientVersionStringCandidates[0]}, ` +
    `config_paths=${structure.configUrls.length}, manifest_paths=${structure.manifestUrls.length}, ` +
    `liqi_paths=${structure.liqiUrls.length}, routes=${context.routes.length}`
  );
}

check().catch(error => {
  console.error(error?.stack || error.message);
  process.exitCode = 1;
});
