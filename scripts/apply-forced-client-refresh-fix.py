from pathlib import Path
import re


def regex_once(path, pattern, replacement):
    p = Path(path)
    text = p.read_text()
    updated, count = re.subn(pattern, lambda _: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{path}: expected one regex match, found {count}: {pattern[:80]}')
    p.write_text(updated)


regex_once(
    'src/index.js',
    r"function isConnectionQueueError\(error\) \{.*?\n\}\n\nfunction buildRoutesUrl",
    r'''function isConnectionQueueError(error) {
  return (
    error instanceof MajsoulRpcError &&
    error.operation === 'oauth2Auth' &&
    error.rpcCode === 151 &&
    !isClientVersionProbeError(error)
  );
}

function shouldForceClientVersionRefresh(error, alreadyForced = false) {
  return Boolean(
    !alreadyForced &&
    (
      error?.clientVersionCandidatesExhausted === true ||
      error?.code === 'CLIENT_VERSION_CANDIDATES_EXHAUSTED'
    )
  );
}

function buildRoutesUrl'''
)

regex_once(
    'src/index.js',
    r"  let session;\n\n  for \(let attempt = 1; attempt <= SESSION_BOOTSTRAP_ATTEMPTS; attempt \+= 1\) \{",
    r'''  let session;
  let forcedClientMetadataRefresh = false;

  for (let attempt = 1; attempt <= SESSION_BOOTSTRAP_ATTEMPTS; attempt += 1) {'''
)

regex_once(
    'src/index.js',
    r"      session = await createSessionWithYostarRefresh\(context, credentials\);\n      break;\n    \} catch \(error\) \{\n      const shouldRetry =",
    r'''      session = await createSessionWithYostarRefresh(context, credentials);
      break;
    } catch (error) {
      if (
        shouldForceClientVersionRefresh(error, forcedClientMetadataRefresh) &&
        attempt < SESSION_BOOTSTRAP_ATTEMPTS
      ) {
        forcedClientMetadataRefresh = true;
        console.warn(
          'all current client-version candidates were rejected -> force-refreshing official client assets once'
        );
        try {
          const { prepareOfficialClientVersionDiscovery } = require('./official-client-version');
          await prepareOfficialClientVersionDiscovery({
            serverKey: server.key,
            base: server.base,
            forceRefresh: true
          });
          console.log('official client assets force-refreshed; rebuilding login candidates');
          continue;
        } catch (refreshError) {
          console.warn(
            `forced official client refresh failed: ${refreshError?.message || refreshError}`
          );
        }
      }

      const shouldRetry ='''
)

regex_once(
    'src/index.js',
    r"  runActions,\n  shouldRefreshYostarCredentials,",
    r'''  runActions,
  shouldForceClientVersionRefresh,
  shouldRefreshYostarCredentials,'''
)

regex_once(
    'test/client-version-update-resilience.test.js',
    r"  isClientVersionProbeError,\n  isConnectionQueueError\n",
    r'''  isClientVersionProbeError,
  isConnectionQueueError,
  shouldForceClientVersionRefresh
'''
)

p = Path('test/client-version-update-resilience.test.js')
text = p.read_text()
text += r'''

test('exhausted version candidates trigger one forced official refresh only', () => {
  const error = Object.assign(new Error('all client versions rejected'), {
    code: 'CLIENT_VERSION_CANDIDATES_EXHAUSTED',
    clientVersionCandidatesExhausted: true
  });
  assert.equal(shouldForceClientVersionRefresh(error, false), true);
  assert.equal(shouldForceClientVersionRefresh(error, true), false);
  assert.equal(shouldForceClientVersionRefresh(new Error('network error'), false), false);
});
'''
p.write_text(text)
