# majsoul-monthTicket-auto

> Warning: Any disadvantages, account sanctions, or other consequences resulting from use of this project are solely the user's responsibility.

![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/89844790-9a47-40b7-8e65-ed07430f3917)
![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/720689fa-7237-4d85-8979-c3e768c7f1d9)

[日本語](README-ja.md) [한국어](README-ko.md) [中文](README-zh.md)

This project automates daily Majsoul login and attendance rewards with GitHub Actions.  

## Prerequisites
1. Open Majsoul in your browser.
2. Press `F12` and switch to the `Console` tab.
3. Run:
   ```js
   {
     const r = await test_sdk.Login({ openQuickLogin: true });
     if (r.code !== 0) throw new Error(`${r.code}: ${r.msg}`);
     console.log(`UID: ${r.data.LOGIN_UID}\nTOKEN: ${r.data.LOGIN_TOKEN}`);
   }
   ```
4. Save the printed `UID` and `TOKEN` values for JP/EN/KR. If `test_sdk` is unavailable, wait for the game to finish loading and retry.
5. CN uses the account email and password.

## Setup
1. Fork this repository.
2. Open `Settings > Secrets and variables > Actions` in the fork.
3. Add `MS_SERVER` with `jp`, `en`, `kr`, or `cn`; the default is `jp`.
4. JP/EN/KR require `UID` and `TOKEN`, or a reusable `ACCESS_TOKEN`. JP should also configure `YOSTAR_DEVICE_ID` from the same browser session.
5. CN requires `EMAIL` and `PASSWORD`.
6. In `Settings > Actions > General`, set `Workflow permissions` to `Read and write permissions`.
7. Enable both `Login to Majsoul` and `Attendance Watchdog` in the Actions tab.
8. Attendance is attempted hourly from 06:17 through 10:17 Asia/Seoul, with a final recovery at 12:13. The independent watchdog checks at 11:31 and 13:31 and dispatches trusted `main` when no success marker exists.

## Manual run
1. Open `Actions > Login to Majsoul` and click `Run workflow`.
2. **Always select `main` under `Use workflow from`.** Other refs are rejected before account secrets are used and the run summary explains the cause.
3. Leave `Run even when attendance already succeeded today` enabled when you want to force another check.
4. Manual runs upload `attendance-run-report.json` with the branch, decision, and per-stage outcomes.

## Client update handling
- Small official metadata is checked first and the last successful client settings remain the fast path.
- Official client strings, Unity structure, YoStar WebSDK metadata, and the used `liqi.json` contract are monitored without executing downloaded JavaScript.
- New protocol baselines are promoted only after a complete successful attendance run.
- Successful login state is encrypted using the configured UID/TOKEN and no plaintext token is committed.

## Caution
- Scheduled GitHub Actions can be delayed or individual events can be dropped. Multiple morning attempts and an independent watchdog reduce this risk but cannot guarantee exact start times.
- Keep all account credentials private.

## Contact
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)
