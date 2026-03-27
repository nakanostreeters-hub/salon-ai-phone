# salon-ai-phone

美容室向けAI電話受付システム — Tasker (楽天ミニ) + Slack連携

## アーキテクチャ

```
楽天ミニ (Tasker)  ──POST──▶  Express サーバー  ──通知──▶  Slack #sms自動受信
                                    │
Slack reply:+81xxx msg ──Events──▶  │  ──POST──▶  楽天ミニ (Tasker) ──SMS送信
```

- **着信検知**: 楽天ミニ上の Tasker が電話着信を検知し、`POST /incoming-call` でサーバーに通知
- **SMS受信**: Tasker が SMS 受信を検知し、`POST /incoming-sms` でサーバーに通知
- **SMS送信**: Slack で `reply:+81xxx メッセージ` と投稿 → サーバーが `TASKER_ENDPOINT_URL` へ POST → 楽天ミニから SMS 送信

## エンドポイント

| Method | Path | 説明 |
|--------|------|------|
| POST | `/incoming-call` | Tasker から着信通知を受信 |
| POST | `/incoming-sms` | Tasker から SMS 受信通知を受信 |
| POST | `/slack/events` | Slack Events API (reply: コマンド処理) |
| POST | `/run-relay` | AI Relay 起動 |
| GET | `/health` | ヘルスチェック |

## ファイル構成

- `server.js` — Express サーバー・ルーティング
- `callHandler.js` — 着信ハンドラー (Tasker → Slack)
- `smsHandler.js` — SMS受信ハンドラー (Tasker → Slack)
- `smsService.js` — SMS送信サービス (Tasker へ HTTP POST)
- `slackHandler.js` — Slack イベント処理・reply: コマンド → SMS送信
- `slackService.js` — Slack 通知送信 (Block Kit)

## 環境変数

- `TASKER_ENDPOINT_URL` — 楽天ミニの Tasker HTTP エンドポイント
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `SLACK_CHANNEL_ID` — Slack 接続
- `ANTHROPIC_API_KEY` — Claude AI (AI Relay 用)

## 開発

```bash
npm install
cp .env.example .env  # 値を設定
npm start
```
