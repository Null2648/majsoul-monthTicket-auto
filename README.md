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
7. Enable both `Login to Majsoul` and `Attendance Safety Check` in the Actions tab.
8. Automatic login is scheduled only at **06:07 and 06:17 Asia/Seoul**. If GitHub starts the job at or after **06:25**, the code refuses to log in.
9. `Attendance Safety Check` runs at **06:50** and only reads the success marker. It never dispatches another login.

## Active-session protection
- There is no reliable non-invasive API that can confirm whether the account is currently playing before game authentication.
- Reaching `oauth2Login` may terminate an existing browser or mobile session as a duplicate login.
- Automatic game login is therefore permitted only from 06:00 through 06:24 KST.
- After 06:25, a missing attendance marker produces a failed safety-check run instead of another login attempt.
- Run the workflow manually only after logging out of Majsoul on every device.

## Manual run
1. Confirm that Majsoul is logged out in the browser and mobile app.
2. Open `Actions > Login to Majsoul` and click `Run workflow`.
3. **Always select `main` under `Use workflow from`.** Other refs are rejected before account secrets are used.
4. Enable **`Confirm that the game is not currently connected and that duplicate login can terminate the existing session`**. Manual login is blocked when it is off.
5. Enable `Run even when attendance already succeeded today` only when another login is intentionally required. Its default is off.
6. Manual runs upload `attendance-run-report.json` with the decision and per-stage outcomes.

## Client update handling
- Small official metadata is checked first and the last successful client settings remain the fast path.
- Official client strings, Unity structure, YoStar WebSDK metadata, and the used `liqi.json` contract are monitored without executing downloaded JavaScript.
- New protocol baselines are promoted only after a complete successful attendance run.
- Successful login state is encrypted using the configured UID/TOKEN and no plaintext token is committed.

## Caution
- Scheduled GitHub Actions can be delayed or dropped. A delayed run after 06:25 intentionally skips attendance to prioritize the active game session.
- This policy prioritizes avoiding an in-game disconnect over maximizing automatic attendance success. Log out and run manually after a safety-check failure.
- Keep all account credentials private.

## Contact
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)
