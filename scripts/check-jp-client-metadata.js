const {
  buildUnityWebGLClientVersionString
} = require('../src/client-metadata');
const {
  prepareOfficialClientVersionDiscovery
} = require('../src/official-client-version');

async function check() {
  const discovery = await prepareOfficialClientVersionDiscovery({ serverKey: 'jp' });
  const {
    getServerConfig,
    loadServerContext
  } = require('../src/index');
  const server = getServerConfig('jp');
  const context = await loadServerContext(server);
  const expectedGeneratedClientVersionString =
    buildUnityWebGLClientVersionString(context.productVersion);

  if (discovery.strings.length) {
    const missing = discovery.strings.filter(
      value => !context.clientVersionStringCandidates.includes(value)
    );

    if (missing.length) {
      throw new Error(
        `Official JP client strings were not installed as candidates: ${missing.join(', ')}`
      );
    }
  } else if (
    context.clientVersionStringCandidates[0] !== expectedGeneratedClientVersionString
  ) {
    throw new Error(
      `Unexpected JP fallback candidate: expected ${expectedGeneratedClientVersionString}, ` +
      `received ${context.clientVersionStringCandidates[0]}`
    );
  }

  console.log(
    `JP client metadata is current: product=${context.productVersion}, ` +
    `resource=${context.version}, exact=${discovery.strings.join(', ') || 'not exposed'}, ` +
    `candidate=${context.clientVersionStringCandidates[0]}, assets=${discovery.assetUrls.length}`
  );
}

check().catch(error => {
  console.error(error?.stack || error.message);
  process.exitCode = 1;
});
