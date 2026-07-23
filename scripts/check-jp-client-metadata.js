const {
  getServerConfig,
  loadServerContext
} = require('../src/index');

async function check() {
  const server = getServerConfig('jp');
  const context = await loadServerContext(server);
  const productVersion = context.clientMetadata.routeVersion;
  const expectedClientVersionString = `WebGL_2022-${productVersion}`;
  const currentClientVersionString = context.clientMetadata.clientVersionString;

  if (currentClientVersionString !== expectedClientVersionString) {
    throw new Error(
      `Unexpected JP client version candidate: expected ${expectedClientVersionString}, received ${currentClientVersionString}`
    );
  }

  console.log(
    `JP client metadata is current: product=${productVersion}, resource=${context.clientMetadata.clientVersion.resource}, client=${currentClientVersionString}`
  );
}

check().catch(error => {
  console.error(error?.stack || error.message);
  process.exitCode = 1;
});
