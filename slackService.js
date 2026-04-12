// ============================================
// services/slackService.js
// Slack通知サービス
// ============================================
const { WebClient } = require("@slack/web-api");

let slackClient = null;

/**
 * Slackクライアント初期化（遅延初期化）
 */
function getClient() {
  if (!slackClient) {
    slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return slackClient;
}

/**
 * Slackチャンネルに通知送信
 * @param {object} params
 * @param {string} params.type - "call" or "sms"
 * @param {string} params.from - 発信元電話番号
 * @param {string} params.message - メッセージ内容
 */
async function notifySlack({ type, from, message }) {
  const client = getClient();
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!channelId) {
    console.error("[Slack] SLACK_CHANNEL_ID が未設定です");
    return;
  }

  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  // --- 着信通知 ---
  if (type === "call") {
    await client.chat.postMessage({
      channel: channelId,
      text: `👤 ${from}（電話）\n${message || "着信あり"}`,
    });
  }

  // --- SMS受信通知 ---
  if (type === "sms") {
    await client.chat.postMessage({
      channel: channelId,
      text: `👤 ${from}（SMS）\n${message}`,
    });
  }
}

module.exports = { notifySlack };
