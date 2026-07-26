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
5. `Login to Majsoul` と `Attendance Safety Check` の両方を有効化します。
6. 自動ログインは Asia/Seoul 基準の **06:07 と 06:17** のみです。実際の開始時刻が **06:25 以降**になった場合、ログインせず終了します。
7. `Attendance Safety Check` は **06:50** に成功記録だけを確認し、追加ログインは実行しません。

## プレイ中セッションの保護
- ゲーム認証前に、アカウントが現在プレイ中かを安全に確認できる信頼性の高い API はありません。
- `oauth2Login` まで進むと、重複ログインにより既存のブラウザまたはアプリのセッションが切断される場合があります。
- そのため自動ログインは 06:00〜06:24 KST の短い時間帯に限定します。
- 06:25 以降は成功記録がなくても自動再ログインしません。
- 未完了の場合は Safety Check が失敗表示を残すだけです。全端末でログアウトした後に手動実行してください。

## 手動実行
1. ブラウザとモバイルアプリの両方で雀魂からログアウトしていることを確認します。
2. `Actions > Login to Majsoul > Run workflow` を開きます。
3. **`Use workflow from` は必ず `main` を選択してください。** 他のブランチは Secret 保護のため実行前に拒否されます。
4. **現在ゲームに接続していないことと、重複ログインで既存セッションが終了する可能性を確認する項目**を有効にします。無効のままでは手動ログインが拒否されます。
5. 当日の成功後に意図して再実行する場合だけ `今日すでに成功していても再実行` を有効にします。既定値は無効です。
6. 手動実行では `attendance-run-report.json` がアップロードされ、判定と各段階の結果を確認できます。

## 注意事項
- GitHub Actions の予約イベントは遅延または欠落する場合があります。06:25 以降に遅延した実行は、現在のゲームセッション保護を優先して出席をスキップします。
- 自動出席の成功率よりプレイ中の切断防止を優先する方針です。Safety Check が失敗した場合は、ログアウト後に手動実行してください。
- 認証情報を第三者に公開しないでください。

## お問い合わせ
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)
