// ============================================
// server.js
// 美容室AI電話受付システム メインサーバー
// ============================================
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const { handleIncomingCall, handleCallStatus } = require("./callHandler");
const { handleIncomingSms } = require("./smsHandler");
const { handleSlackEvent } = require("./slackHandler");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// ミドルウェア
// ============================================

// Slack署名検証用にrawBodyを保存
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(bodyParser.urlencoded({ extended: false }));

// ============================================
// ルーティング
// ============================================

// --- ヘルスチェック ---
app.get("/", (_req, res) => {
  res.json({
    status: "running",
    service: "美容室AI電話受付システム",
    endpoints: {
      "POST /voice": "Twilio電話着信Webhook",
      "POST /voice/status": "Twilio通話ステータスCallback",
      "POST /sms": "Twilio SMS受信Webhook",
      "POST /slack/events": "Slack Events API",
    },
  });
});

// --- Twilio 電話着信 ---
app.post("/voice", handleIncomingCall);

// --- Twilio 通話ステータス ---
app.post("/voice/status", handleCallStatus);

// --- Twilio SMS受信 ---
app.post("/sms", handleIncomingSms);

// --- Slack Events ---
app.post("/slack/events", handleSlackEvent);
// --- AI Relay 自動起動（Gensparkからの命令受付） ---
const { exec } = require("child_process");
app.post("/run-relay", (req, res) => {
  console.log("🤖 Gensparkからの命令受信 → aiRelay.js起動");
  res.json({ status: "started", message: "aiRelay.js を起動しました" });
  exec("npm run ai:relay", (error, stdout, stderr) => {
    if (error) {
      console.error("❌ エラー:", error.message);
      return;
    }
    console.log("✅ aiRelay.js 完了:", stdout);
  });
});


// ============================================
// サーバー起動
// ============================================
app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log("  美容室AI電話受付システム");
  console.log("========================================");
  console.log(`  サーバー起動: http://localhost:${PORT}`);
  console.log("");
  console.log("  エンドポイント:");
  console.log(`    POST /voice          → 電話着信`);
  console.log(`    POST /voice/status   → 通話ステータス`);
  console.log(`    POST /sms            → SMS受信`);
  console.log(`    POST /slack/events   → Slack Events`);
  console.log("========================================");
  console.log("");

  // 環境変数チェック
  const required = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "SLACK_BOT_TOKEN",
    "SLACK_CHANNEL_ID",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn("⚠️  未設定の環境変数:");
    missing.forEach((key) => console.warn(`   - ${key}`));
    console.warn("   .env.example を参考に .env を設定してください");
    console.warn("");
  }
});
