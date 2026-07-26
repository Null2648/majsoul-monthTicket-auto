async function createSessionWithYostarRefresh(context, credentials) {
  let credentialCandidates = [credentials];
  let refreshed;
  let refreshError;

  if (
    credentials.server.key === 'jp' &&
    credentials.uid &&
    credentials.token &&
    credentials.baseUid &&
    credentials.baseToken
  ) {
    try {
      try {
        refreshed = await refreshYostarCredentials({
          gameBase: credentials.server.base,
          uid: credentials.uid,
          token: credentials.token,
          deviceId: credentials.yostarDeviceId,
          metadata: credentials.yostarMetadata
        });
      } catch (error) {
        if (!credentials.yostarMetadata || error?.officialMetadataAttempted) {
          throw error;
        }

        console.warn(
          'cached YoStar WebSDK metadata was rejected -> refreshing official SDK metadata'
        );
        refreshed = await refreshYostarCredentials({
          gameBase: credentials.server.base,
          uid: credentials.uid,
          token: credentials.token,
          deviceId: credentials.yostarDeviceId
        });
      }

      credentialCandidates = buildYostarCredentialCandidates(
        credentials,
        refreshed
      );
      console.log('YoStar login token validated before game authentication');
    } catch (error) {
      refreshError = error;
      console.warn(
        error?.yostarCode === 100403
          ? 'YoStar login token is expired; trying the remaining configured game credential'
          : `YoStar login validation was unavailable: ${error?.message || error}`
      );
    }
  }

  let session;
  let successfulCredentials;

  try {
    session = await createSession(context, credentialCandidates, {
      onCredentialAccepted: activeCredentials => {
        successfulCredentials = activeCredentials;
      }
    });
  } catch (error) {
    if (
      shouldRefreshYostarCredentials(error, credentials) &&
      refreshError?.yostarCode === 100403
    ) {
      const expiredError = new Error(
        'YoStar login token expired (WebSDK code 100403). ' +
        'Issue a fresh LOGIN_UID/LOGIN_TOKEN once with test_sdk.Login and update ' +
        'the repository UID/TOKEN secrets; later runs will renew and cache it automatically.'
      );
      expiredError.retryable = false;
      expiredError.yostarCode = 100403;
      throw expiredError;
    }

    throw error;
  }

  return {
    session,
    successfulCredentials,
    refreshed
  };
}