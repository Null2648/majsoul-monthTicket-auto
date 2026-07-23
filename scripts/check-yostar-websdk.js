const {
  loadOfficialWebSdkMetadata
} = require('../src/yostar-websdk');

async function run() {
  const metadata = await loadOfficialWebSdkMetadata(
    'https://game.mahjongsoul.com/'
  );

  console.log(
    `official YoStar WebSDK -> version=${metadata.version} ` +
    `pid=${metadata.pid} routes=${metadata.hosts.length}`
  );
}

run().catch(error => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
