# majsoul-monthTicket-auto

> 警告：使用本项目所产生的任何不利影响、账号处罚或其他后果，均由使用者自行承担责任。

![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/89844790-9a47-40b7-8e65-ed07430f3917)
![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/720689fa-7237-4d85-8979-c3e768c7f1d9)

本项目通过 GitHub Actions 自动登录雀魂并领取每日出勤奖励。  

## 前置准备
1. 在浏览器中打开雀魂。
2. 按 `F12` 并切换到 `Console`。
3. 执行：
   ```js
   {
     const r = await test_sdk.Login({ openQuickLogin: true });
     if (r.code !== 0) throw new Error(`${r.code}: ${r.msg}`);
     console.log(`UID: ${r.data.LOGIN_UID}\nTOKEN: ${r.data.LOGIN_TOKEN}`);
   }
   ```
4. 将输出的 `UID` 和 `TOKEN` 保存为 JP/EN/KR 的 Secret。
5. JP 还应配置同一浏览器会话中的 `YOSTAR_DEVICE_ID`；CN 使用 `EMAIL` 和 `PASSWORD`。

## 配置
1. Fork 本仓库并打开 `Settings > Secrets and variables > Actions`。
2. 将 `MS_SERVER` 设置为 `jp`、`en`、`kr` 或 `cn`，未设置时默认为 `jp`。
3. JP/EN/KR 配置 `UID` 与 `TOKEN`，或可复用的 `ACCESS_TOKEN`；CN 配置 `EMAIL` 与 `PASSWORD`。
4. 在 `Settings > Actions > General` 中将 `Workflow permissions` 改为 `Read and write permissions`。
5. 同时启用 `Login to Majsoul` 和 `Attendance Safety Check`。
6. 自动登录仅在 Asia/Seoul 时间 **06:07 和 06:17** 尝试。如果 GitHub 实际在 **06:25 或更晚**启动，代码会拒绝登录。
7. `Attendance Safety Check` 在 **06:50** 只检查成功记录，不会再次触发登录。

## 保护正在游戏的会话
- 游戏认证前没有可靠且无侵入的 API 可以确认账号是否正在对局。
- 自动化执行到 `oauth2Login` 时，现有浏览器或手机会话可能因重复登录而断开。
- 因此自动登录只允许在 KST 06:00 至 06:24 的短时间窗口内进行。
- 06:25 之后即使没有成功记录，也不会自动再次登录。
- 未完成时 Safety Check 只会留下失败提示。请先在所有设备退出雀魂，再手动运行。

## 手动运行
1. 确认浏览器和手机应用都已退出雀魂。
2. 打开 `Actions > Login to Majsoul > Run workflow`。
3. **`Use workflow from` 必须选择 `main`。** 其他分支会在使用账号 Secret 前被拒绝。
4. 勾选**确认当前未连接游戏，并知晓重复登录可能终止现有会话**。未勾选时手动登录会被阻止。
5. 仅在确实需要当天再次登录时勾选 `今天已成功仍再次运行`，默认关闭。
6. 手动运行会上传 `attendance-run-report.json`，其中包含判定与各阶段结果。

## 注意事项
- GitHub Actions 的定时事件可能延迟或丢失。06:25 之后才启动的任务会优先保护当前游戏会话并跳过出勤。
- 本策略优先避免对局中断，而不是最大化自动出勤成功率。Safety Check 失败后，请退出游戏再手动运行。
- 请勿泄露任何账号凭据。

## 联系方式
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)
