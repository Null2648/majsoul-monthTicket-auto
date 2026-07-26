const fs = require('node:fs');
const {
  installGlobalMetadataFetchGuard,
  scopeStructureFetch
} = require('../src/network-hardening');
const {
  prepareOfficialStructureFallbacks
} = require('../src/official-structure-fallbacks');
const {
  validateGatewayEndpoint
} = require('../src/websocket-hardening');

const DIAGNOSTIC_PATH = 'jp-metadata-diagnostic.json';

async function diagnoseManifestCandidates(structure) {
  const results = [];
  const fetchImpl = structure?.originalFetch;
  if (typeof fetchImpl !== 'function') return results;
  for (const candidate of (structure.manifestUrls || []).slice(0, 20)) {
    try {
      const response = await fetchImpl(candidate, {
        headers: { Accept: 'application/json,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      const entry = {
        url: candidate,
        status: response.status,
        contentType: response.headers.get('content-type') || null
      };
      if (response.ok) {
        const text = await response.text();
        entry.bytes = Buffer.byteLength(text, 'utf8');
        try {
          const json = JSON.parse(text);
          entry.liqiPrefix = json?.res?.['res/proto/liqi.json']?.prefix || null;
          entry.topLevelKeys = Object.keys(json || {}).slice(0, 12);
        } catch {
          entry.parse = 'invalid-json';
        }
      }
      results.push(entry);
    } catch (error) {
      results.push({ url: candidate, error: String(error?.message || error).slice(0, 500) });
    }
  }
  return results;
}

async function check() {
  installGlobalMetadataFetchGuard();
  const structure = await prepareOfficialStructureFallbacks({
    serverKey: 'jp',
    forceRefresh: true
  });
  scopeStructureFetch(structure);
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
  try {
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
    for (const route of context.routes) validateGatewayEndpoint(route.endpoint);

    if (fs.existsSync(DIAGNOSTIC_PATH)) fs.unlinkSync(DIAGNOSTIC_PATH);
    console.log(
      `JP client metadata is current: product=${context.productVersion}, ` +
      `build=${context.buildId}, resource=${context.version}, ` +
      `exact=${discovery.strings.join(', ')}, candidate=${context.clientVersionStringCandidates[0]}, ` +
      `config_paths=${structure.configUrls.length}, manifest_paths=${structure.manifestUrls.length}, ` +
      `liqi_paths=${structure.liqiUrls.length}, safe_routes=${context.routes.length}`
    );
  } catch (error) {
    error.jpStructureDiagnostic = {
      version: structure.version,
      base: structure.base,
      manifestCandidates: await diagnoseManifestCandidates(structure)
    };
    throw error;
  }
}

check().catch(error => {
  const message = String(error?.stack || error?.message || error)
    .replace(/(authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 12000);
  try {
    fs.writeFileSync(DIAGNOSTIC_PATH, `${JSON.stringify({
      message,
      structure: error?.jpStructureDiagnostic || null
    }, null, 2)}\n`, 'utf8');
  } catch { /* diagnostic write is best-effort */ }
  console.error(message);
  process.exitCode = 1;
});