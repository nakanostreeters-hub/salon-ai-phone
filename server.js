// ============================================
// server.js
// 美容室AI電話受付システム メインサーバー
// ============================================
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const { handleIncomingCall } = require("./callHandler");
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
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.json({
    status: "running",
    service: "美容室AI電話受付システム",
    endpoints: {
      "POST /incoming-call": "Tasker電話着信",
      "POST /incoming-sms": "Tasker SMS受信",
      "POST /send-sms": "Slack経由SMS送信",
      "POST /slack/events": "Slack Events API",
    },
  });
});

// --- Tasker 電話着信 ---
app.post("/incoming-call", handleIncomingCall);

// --- Tasker SMS受信 ---
app.post("/incoming-sms", handleIncomingSms);

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
  console.log("  美容室AI電話受付システム (Tasker版)");
  console.log("========================================");
  console.log(`  サーバー起動: http://localhost:${PORT}`);
  console.log("");
  console.log("  エンドポイント:");
  console.log(`    POST /incoming-call   → 電話着信 (Tasker)`);
  console.log(`    POST /incoming-sms    → SMS受信 (Tasker)`);
  console.log(`    POST /send-sms        → SMS送信 (Slack→Tasker)`);
  console.log(`    POST /slack/events    → Slack Events`);
  console.log("========================================");
  console.log("");

  // 環境変数チェック
  const required = [
    "TASKER_ENDPOINT_URL",
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
