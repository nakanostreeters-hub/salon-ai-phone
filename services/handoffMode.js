// ============================================
// services/handoffMode.js
// 引き継ぎ済みモード（handoff）のロジック：
//  - お客様メッセージ分類（Claude）
//  - SLAタイマー（5/10/20分）
// ============================================

const Anthropic = require('@anthropic-ai/sdk');

// セッション横断のSLAタイマー: userId -> { t5, t10, t20 }
const slaTimers = new Map();

let anthropic = null;
function getAnthropic() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').trim() });
  }
  return anthropic;
}

/**
 * 引き継ぎ後のお客様メッセージを分類する。
 * 返り値: 'level0' | 'level1' | 'level2' | 'emergency'
 *   level0    無反応：感謝・了解・スタンプ的・終話。AI返信なし、Slack通知も不要
 *   level1    サイレント通知のみ：遅刻連絡・予約変更・軽い質問。Slackに通知だけ
 *   level2    条件付き一次受け：本題の問い合わせ。スタッフ未応答10分超なら一次受けOK
 *   emergency クレーム・苦情・強い不満：AI絶対返信しない、Slackに⚠️タグで緊急通知
 */
async function classifyHandoffMessage(text) {
  if (!text) return 'level1';
  const trimmed = text.trim();
  if (!trimmed) return 'level0';

  // 軽量な前段ヒューリスティック（API無しで判定できるものはここで返す）
  if (/^[ありがとうございますはいわかりました了解承知！。、!\.\?\s😊👍🙏✨🙇\u{1F300}-\u{1FAFF}]+$/u.test(trimmed) && trimmed.length <= 20) {
    return 'level0';
  }

  const client = getAnthropic();
  // Claude未設定時のフォールバックはlevel1（安全側＝サイレント通知）
  if (!client) return 'level1';

  const prompt = `次のお客様メッセージを以下4分類に1つ判定し、ラベルだけ返してください。説明禁止。

ラベル定義:
- level0    : 感謝・了解・スタンプ的・終話のみ（「ありがとうございます」「了解です」「👍」など）
- level1    : 遅刻連絡・予約変更・軽い確認・補足情報など、緊急ではない業務連絡
- level2    : 新規の本題質問や予約・相談など、回答や調整が必要な内容
- emergency : クレーム・苦情・強い不満・怒り・「責任者出せ」「最悪」「もう行かない」「返金」など

メッセージ:
"""
${trimmed.slice(0, 500)}
"""

ラベル:`;

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [{ role: 'user', content: prompt }],
    });
    const out = (res.content?.[0]?.text || '').toLowerCase().trim();
    if (out.includes('emergency')) return 'emergency';
    if (out.includes('level0')) return 'level0';
    if (out.includes('level2')) return 'level2';
    return 'level1';
  } catch (err) {
    console.warn('[Handoff] 分類失敗、level1扱い:', err.message);
    return 'level1';
  }
}

// ─── SLAタイマー管理 ───
function clearSlaTimers(userId) {
  const t = slaTimers.get(userId);
  if (!t) return;
  if (t.t5)  clearTimeout(t.t5);
  if (t.t10) clearTimeout(t.t10);
  if (t.t20) clearTimeout(t.t20);
  slaTimers.delete(userId);
}

/**
 * SLAタイマーをスケジュール
 * @param {string} userId
 * @param {object} hooks - { onFiveMin, onTenMin, onTwentyMin }
 *   各 hook は async () => void
 */
function scheduleSla(userId, hooks) {
  clearSlaTimers(userId);
  const t = {
    t5:  setTimeout(() => safeRun(hooks.onFiveMin, '5min'),   5 * 60 * 1000),
    t10: setTimeout(() => safeRun(hooks.onTenMin, '10min'),  10 * 60 * 1000),
    t20: setTimeout(() => safeRun(hooks.onTwentyMin, '20min'), 20 * 60 * 1000),
  };
  slaTimers.set(userId, t);
}

async function safeRun(fn, label) {
  if (typeof fn !== 'function') return;
  try {
    await fn();
  } catch (err) {
    console.error(`[Handoff SLA ${label}] 実行エラー:`, err.message);
  }
}

module.exports = {
  classifyHandoffMessage,
  scheduleSla,
  clearSlaTimers,
};
