# majsoul-monthTicket-auto

> 警告: このプロジェクトの利用によって生じる不利益、アカウント制裁、その他すべての結果については、利用者自身が責任を負うものとします。

![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/89844790-9a47-40b7-8e65-ed07430f3917)
![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/720689fa-7237-4d85-8979-c3e768c7f1d9)

このプロジェクトは GitHub Actions を使って雀魂へ自動ログインし、毎日の出席報酬を受け取ります。  

## 事前準備
1. ブラウザで雀魂を開きます。
2. `F12` を押し、`Console` タブへ移動します。
3. 次のコードを実行します。
   ```js
   {
     const r = await test_sdk.Login({ openQuickLogin: true });
     if (r.code !== 0) throw new Error(`${r.code}: ${r.msg}`);
     console.log(`UID: ${r.data.LOGIN_UID}\nTOKEN: ${r.data.LOGIN_TOKEN}`);
   }
   ```
4. 表示された `UID` と `TOKEN` を JP/EN/KR の Secret に保存します。
5. JP では同じブラウザの `YOSTAR_DEVICE_ID` も設定してください。CN は `EMAIL` と `PASSWORD` を使います。

## セットアップ
1. このリポジトリをフォークし、`Settings > Secrets and variables > Actions` を開きます。
2. `MS_SERVER` に `jp`、`en`、`kr`、`cn` のいずれかを設定します。未設定時は `jp` です。
3. JP/EN/KR は `UID` と `TOKEN`、または再利用可能な `ACCESS_TOKEN` を設定します。CN は `EMAIL` と `PASSWORD` を設定します。
4. `Settings > Actions > General` で `Workflow permissions` を `Read and write permissions` にします。
5. `Login to Majsoul` と `Attendance Watchdog` の両方を有効化します。
6. 06:17〜10:17（Asia/Seoul）に毎時実行し、12:13 に最終復旧を行います。Watchdog は 11:31 と 13:31 に成功記録を確認します。

## 手動実行
1. `Actions > Login to Majsoul > Run workflow` を開きます。
2. **`Use workflow from` は必ず `main` を選択してください。** 他のブランチは Secret 保護のため実行前に拒否され、理由が Summary に表示されます。
3. 手動実行では `attendance-run-report.json` がアップロードされ、判定と各段階の結果を確認できます。

## 注意事項
- GitHub Actions の予約イベントは遅延または欠落する場合があります。複数回の朝実行と独立 Watchdog で補完しますが、正確な開始時刻は保証されません。
- 認証情報を第三者に公開しないでください。

## お問い合わせ
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)
