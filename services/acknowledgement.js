// ============================================
// services/acknowledgement.js
// お客様の最初の発話に対する「一言の受け止め」を Claude Haiku で生成する。
// 「いいですね」が指名確認・料金確認・予約間違い等で不自然になる問題を解消するため、
// 発話内容に応じた短い受け止め表現だけを返す。
// ============================================

const Anthropic = require('@anthropic-ai/sdk');

let anthropic = null;
function getAnthropic() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').trim() });
  }
  return anthropic;
}

// Claude が使えない/失敗したときのニュートラル・フォールバック
// 「いいですね」は絶対に選ばない（指示書の要件）
const FALLBACK_ACK = '承知しました😊';

const GREETING_ONLY_RE = /^(こんにちは|こんばんは|おはよう|はじめまして|初めまして|お世話になっ|お久しぶり|ども|どうも)[！!。、\s]*$/;

/**
 * 発話に対する受け止め表現を生成する。
 * - 挨拶のみ  → 空文字列（呼び出し側は通常の挨拶文を使う）
 * - それ以外 → Haiku で文脈に沿った一言を生成（15字以内、絵文字1つまで）
 *
 * @param {string} userMessage
 * @returns {Promise<string>} 受け止め文（空文字列なら受け止め不要）
 */
async function generateAcknowledgement(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') return '';
  const trimmed = userMessage.trim();
  if (!trimmed) return '';

  // 挨拶のみ → 受け止めを付けない（通常挨拶に任せる）
  if (GREETING_ONLY_RE.test(trimmed)) return '';

  const client = getAnthropic();
  if (!client) return FALLBACK_ACK;

  const prompt = `あなたは美容室のAIコンシェルジュです。
お客様からの最初のメッセージに対して、本題に入る前の「一言の受け止め」だけを出力してください。

## ルール
- 出力は 15字以内、絵文字は1つ以下
- 受け止めのみ。質問や次の提案は書かない
- 「新規」「初回」「はじめまして」「ご利用ありがとうございます」は禁止
- 「いいですね」は施術希望（「カラーしたい」「カットしたい」等、お客様自身のポジティブな希望表明）のときだけ使う

## カテゴリ別の例
- 施術希望（「カラーしたい」「カットお願いしたい」）→「いいですね😊」
- 指名/スタイリスト確認（「〇〇さん空きある?」「誰が得意?」）→「承知しました😊」
- 予約関連の確認（「空き状況教えて」「予約取りたい」）→「承知しました😊」
- 料金・値段の確認（「いくら?」「料金知りたい」）→「承知しました」
- 予約の間違い・変更・キャンセル →「ご確認いたしますね」
- クレーム・苦情・強い不満 →「恐れ入ります」
- 相談・迷い（「どれがいいか迷ってて」）→「もちろんです😊」
- 判断に迷う場合 →「承知しました😊」

出力は受け止め文のみ。引用符・前置き・改行なし。

## メッセージ
"""
${trimmed.slice(0, 300)}
"""

受け止め:`;

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = (res.content?.[0]?.text || '').trim();
    return sanitizeAck(raw) || FALLBACK_ACK;
  } catch (err) {
    console.warn('[Acknowledgement] 生成失敗、フォールバック使用:', err.message);
    return FALLBACK_ACK;
  }
}

// モデル出力の清掃: 改行、前置き、引用符、過剰な絵文字を取り除く
function sanitizeAck(text) {
  if (!text) return '';
  // 改行は最初の1行のみ採用
  let t = text.split(/\r?\n/)[0].trim();
  // 「受け止め:」「A:」等の前置きを剥がす
  t = t.replace(/^受け止め[:：]\s*/u, '').trim();
  // 前後の引用符を剥がす
  t = t.replace(/^["'「『]|["'」』]$/gu, '').trim();
  // 18字を超える場合は打ち切り
  if ([...t].length > 18) {
    t = [...t].slice(0, 18).join('');
  }
  // 「新規」「初回」「はじめまして」「ご利用ありがとうございます」が混入したらフォールバック
  if (/新規|初回|はじめまして|初めまして|ご利用ありがとうございます/.test(t)) {
    return '';
  }
  return t;
}

module.exports = {
  generateAcknowledgement,
  // テスト用
  _sanitizeAck: sanitizeAck,
  FALLBACK_ACK,
};
