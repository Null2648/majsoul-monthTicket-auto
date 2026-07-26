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
5. 同时启用 `Login to Majsoul` 和 `Attendance Watchdog`。
6. 工作流在 Asia/Seoul 06:17 至 10:17 每小时尝试，并在 12:13 最终恢复。Watchdog 在 11:31 和 13:31 检查成功记录。

## 手动运行
1. 打开 `Actions > Login to Majsoul > Run workflow`。
2. **`Use workflow from` 必须选择 `main`。** 其他分支会在使用账号 Secret 前被拒绝，原因会显示在 Summary 中。
3. 手动运行会上传 `attendance-run-report.json`，其中包含判定与各阶段结果。

## 注意事项
- GitHub Actions 的定时事件可能延迟或丢失。多次晨间执行和独立 Watchdog 可降低风险，但不能保证精确启动时间。
- 请勿泄露任何账号凭据。

## 联系方式
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)
