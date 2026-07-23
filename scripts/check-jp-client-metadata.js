const {
  getServerConfig,
  loadServerContext
} = require('../src/index');

async function check() {
  const server = getServerConfig('jp');
  const context = await loadServerContext(server);
  const expectedClientVersionString = `web-${context.version.replace(/\.w$/, '')}`;
  const [currentClientVersionString] = context.clientVersionStringCandidates;

  if (currentClientVersionString !== expectedClientVersionString) {
    throw new Error(
      `Unexpected JP client version candidate: expected ${expectedClientVersionString}, received ${currentClientVersionString}`
    );
  }

  console.log(
    `JP client metadata is current: product=${context.productVersion}, resource=${context.version}, client=${currentClientVersionString}`
  );
}

check().catch(error => {
  console.error(error?.stack || error.message);
  process.exitCode = 1;
});
