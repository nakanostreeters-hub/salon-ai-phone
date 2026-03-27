// ============================================
// services/smsService.js
// Tasker経由SMS送信サービス
// ============================================

/**
 * Tasker (楽天ミニ) 経由でSMS送信
 * @param {string} to - 送信先電話番号（+81形式）
 * @param {string} body - メッセージ本文
 */
async function sendSms(to, body) {
  const endpoint = process.env.TASKER_ENDPOINT_URL;
  if (!endpoint) {
    throw new Error("TASKER_ENDPOINT_URL が未設定です");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, body }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tasker送信失敗 (${response.status}): ${text}`);
  }

  console.log(`[SMS] Tasker経由送信 → ${to}`);
  return response.json();
}

module.exports = { sendSms };
