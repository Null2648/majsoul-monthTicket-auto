const {
  loadOfficialWebSdkMetadataCandidates
} = require('../src/yostar-websdk');

async function run() {
  const candidates = await loadOfficialWebSdkMetadataCandidates(
    'https://game.mahjongsoul.com/'
  );
  const metadata = candidates[0];

  if (!metadata?.version || !metadata?.pid || !metadata?.hosts?.length) {
    throw new Error('Official YoStar WebSDK metadata candidate is incomplete');
  }

  console.log(
    `official YoStar WebSDK -> version=${metadata.version} ` +
    `pid=${metadata.pid} routes=${metadata.hosts.length} ` +
    `strategy=${metadata.strategy} candidates=${candidates.length}`
  );
}

run().catch(error => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
