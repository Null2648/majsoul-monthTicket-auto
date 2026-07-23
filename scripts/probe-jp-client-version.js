const {
  createSession,
  getServerConfig,
  isVersionStringError,
  loadServerContext,
  MajsoulRpcError
} = require('../src/index');

async function probe() {
  const server = getServerConfig('jp');
  const credentials = {
    server,
    uid: '0',
    token: 'invalid-token-used-only-for-client-version-probe'
  };
  const context = await loadServerContext(server);

  try {
    const session = await createSession(context, credentials);
    await session.close();
    throw new Error('Version probe unexpectedly authenticated with placeholder credentials.');
  } catch (error) {
    if (error instanceof MajsoulRpcError && !isVersionStringError(error)) {
      console.log(
        `JP client version accepted by gateway: ${error.resourceVersion}; placeholder credentials rejected with RPC code ${error.rpcCode}.`
      );
      return;
    }

    throw error;
  }
}

probe().catch(error => {
  console.error(error?.stack || error.message);
  process.exitCode = 1;
});
