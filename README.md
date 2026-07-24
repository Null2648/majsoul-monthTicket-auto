# majsoul-monthTicket-auto

> Warning: Any disadvantages, account sanctions, or other consequences resulting from use of this project are solely the user's responsibility.

![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/89844790-9a47-40b7-8e65-ed07430f3917)
![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/720689fa-7237-4d85-8979-c3e768c7f1d9)

[日本語](README-ja.md) [한국어](README-ko.md) [中文](README-zh.md)

This project automates daily logins to Majsoul to achieve the attendance achievement (8bit Riichi BGM) and collect the daily Fortune Charm using GitHub Actions.  

## Prerequisites
1. Open Majsoul in your browser.
2. Press `F12` and switch to the `Console` tab.
3. Run the following code:
   ```js
   {
     const r = await test_sdk.Login({ openQuickLogin: true });
     if (r.code !== 0) throw new Error(`${r.code}: ${r.msg}`);
     console.log(`UID: ${r.data.LOGIN_UID}\nTOKEN: ${r.data.LOGIN_TOKEN}`);
   }
   ```
4. Save the printed `UID` and `TOKEN` values for JP/EN/KR server setup. If `test_sdk` is not defined, wait until the game finishes loading and try again.
5. For CN, use your account email and password instead. The script calculates the required password hash internally.

## Setup Instructions
1. Fork this repository on GitHub.
2. In your fork, go to `Settings > Secrets and variables > Actions`.
3. Click `New repository secret` and add `MS_SERVER`.
4. Set `MS_SERVER` to one of `jp`, `en`, `kr`, or `cn`. If you do not set it, the default is `jp`.
5. If you use the `jp`, `en`, or `kr` server, click `New repository secret` again and add `UID` and `TOKEN`. An existing `ACCESS_TOKEN` is reused first, with automatic reauthorization through `UID` and `TOKEN` if it is rejected.
6. If you use the `cn` server, click `New repository secret` again and add `EMAIL` and `PASSWORD` with your account email and plaintext password.
7. Go to `Settings > Actions > General` and change `Workflow permissions` to `Read and write permissions`.
8. Scheduled attendance runs at 6:17 AM in the `Asia/Seoul` timezone, with a 6:47 AM fallback. After a successful scheduled run, the fallback checks the saved date and exits without logging in again. To change the schedule, edit the `cron` and `timezone` values in `.github/workflows/main.yml`.
9. Open the `Actions` tab and click `I understand my workflows, go ahead and enable them` to enable workflows.
10. Select `Login to Majsoul` from the left-side `Workflows` list and click `Enable workflow`.

## Testing Instructions
1. Stay logged in to Majsoul in your browser.
2. In GitHub, go to `Actions > Workflows` and click `Run workflow`.
3. If it works correctly, your browser session may be disconnected because of a duplicate login.

## Client update handling
- Each run checks the small official `version.json` and Unity `productVersion` first.
- If they are unchanged, the last successful client settings are reused immediately.
- Unity `productVersion` is used for package and route metadata. The last successful authentication resource version remains the fast path; only the official outdated-client error 150 activates a bounded sequential recovery scan, and the successful value is cached for later runs.
- The route handshake mirrors the current Unity client, including its Web platform field and second-based timestamp. Login-queue error 151 refreshes the route/session instead of incorrectly scanning client versions.
- The Unity client derives the authentication resource from `docs_version/version.json`; recovery alternates around the last successful value instead of assuming every update increments it.
- The current Unity client no longer exposes the old `game`/`Laya` globals, so use the `test_sdk.Login` method above.

## Caution
- GitHub Actions scheduled workflows can be delayed or dropped during periods of high load. The fallback schedule reduces this risk, but an exact start time is not guaranteed.
- Be careful not to expose your access token or other credentials to anyone.

## Contact
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)
