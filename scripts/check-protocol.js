const fs = require('node:fs');
const {
  installGlobalMetadataFetchGuard,
  scopeStructureFetch
} = require('../src/network-hardening');
const {
  prepareOfficialStructureFallbacks
} = require('../src/official-structure-fallbacks');
const {
  PROTOCOL_PENDING_PATH,
  finalizeProtocolSnapshot,
  prepareProtocolMonitor
} = require('../src/protocol-monitor-hardened');

async function run() {
  const writeBaseline = process.argv.includes('--write-baseline');
  installGlobalMetadataFetchGuard();
  const structure = await prepareOfficialStructureFallbacks({
    serverKey: 'jp',
    forceRefresh: true
  });
  scopeStructureFetch(structure);
  const result = await prepareProtocolMonitor({
    serverKey: 'jp',
    structure,
    forceRefresh: true,
    requireBaseline: !writeBaseline
  });

  if (writeBaseline) {
    const changed = finalizeProtocolSnapshot();
    console.log(
      `protocol baseline ${changed ? 'written' : 'unchanged'} -> ` +
      `source=${result.current.sourceVersion} contract=${result.current.contractHash} ` +
      `schema=${result.current.schemaVersion}`
    );
    return;
  }

  if (fs.existsSync(PROTOCOL_PENDING_PATH)) fs.unlinkSync(PROTOCOL_PENDING_PATH);
  console.log(
    `protocol baseline is current -> source=${result.current.sourceVersion} ` +
    `contract=${result.current.contractHash} warnings=${result.report.warnings.length}`
  );
}

run().catch(error => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
