// ============================================
// handlers/callHandler.js
// Tasker 電話着信ハンドラー
// ============================================
const { notifySlack } = require("./slackService");

/**
 * Taskerからの着信通知を処理
 * POST /incoming-call
 * Body: { from: "+81xxxxxxxxxx", type: "mobile" | "fixed", timestamp: number }
 */
async function handleIncomingCall(req, res) {
  const { from, type, timestamp } = req.body;

  console.log(`[着信] From: ${from} | Type: ${type}`);

  try {
    if (type === "mobile") {
      await notifySlack({
        type: "call",
        from,
        message: `📱 携帯から着信: ${from}\nSMSチャット開始 — reply:${from} メッセージ本文`,
      });
    } else {
      await notifySlack({
        type: "call",
        from,
        message: `☎️ 固定電話から着信: ${from}\n折り返し対応が必要です`,
      });
    }
    console.log(`[Slack通知完了] 着信: ${from}`);
    res.json({ status: "ok" });
  } catch (error) {
    console.error("[着信処理エラー]", error.message);
    res.status(500).json({ status: "error", message: error.message });
  }
}

module.exports = { handleIncomingCall };
