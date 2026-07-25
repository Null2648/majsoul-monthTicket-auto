const {
  prepareOfficialClientVersionDiscovery
} = require('../src/official-client-version');

async function check() {
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

  console.log(
    `JP client metadata is current: product=${context.productVersion}, ` +
    `resource=${context.version}, exact=${discovery.strings.join(', ')}, ` +
    `candidate=${context.clientVersionStringCandidates[0]}, assets=${discovery.assetUrls.length}`
  );
}

check().catch(error => {
  console.error(error?.stack || error.message);
  process.exitCode = 1;
});
