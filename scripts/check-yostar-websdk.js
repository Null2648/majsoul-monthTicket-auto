const fs = require('node:fs');
const {
  installGlobalMetadataFetchGuard
} = require('../src/network-hardening');
const {
  loadOfficialWebSdkMetadataCandidates
} = require('../src/yostar-websdk-safe');

const DIAGNOSTIC_PATH = 'yostar-safe-diagnostic.json';

async function run() {
  if (fs.existsSync(DIAGNOSTIC_PATH)) fs.unlinkSync(DIAGNOSTIC_PATH);
  installGlobalMetadataFetchGuard();
  const candidates = await loadOfficialWebSdkMetadataCandidates(
    'https://game.mahjongsoul.com/'
  );
  const metadata = candidates[0];
  if (!metadata?.version || !metadata?.pid || !metadata?.hosts?.length) {
    throw new Error('Official safe YoStar WebSDK metadata candidate is incomplete');
  }
  console.log(
    `official safe YoStar WebSDK -> version=${metadata.version} ` +
    `pid=${metadata.pid} routes=${metadata.hosts.length} ` +
    `strategy=${metadata.strategy} candidates=${candidates.length}`
  );
}

run().catch(error => {
  fs.writeFileSync(DIAGNOSTIC_PATH, `${JSON.stringify({
    failedAt: new Date().toISOString(),
    code: String(error?.code || ''),
    message: String(error?.message || error),
    observedHostnames: Array.isArray(error?.observedHostnames)
      ? error.observedHostnames.slice(0, 16)
      : []
  }, null, 2)}\n`, 'utf8');
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});

module.exports = { DIAGNOSTIC_PATH, run };