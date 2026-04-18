// ============================================
// services/customerLinking.js
// LINE × カルテ紐づけ（1ターン型）
// IDLE → AWAITING_NAME_AND_PHONE → 完了 or エスカレーション
// 初回に「名前＋電話番号下4桁」を1回で聞き、1件一致なら即紐付け確定。
// 確認ステップ（「○○さまでお間違いないですか?」）は廃止。
// ============================================

const {
  findCustomersByName,
  findCustomersByPhoneLast4,
  linkLineUserToCustomer,
  getCustomerProfile,
  logCustomerAccess,
} = require('../supabase-client');
const { generateAcknowledgement } = require('./acknowledgement');

const STATES = {
  IDLE: 'idle',
  AWAITING_NAME_AND_PHONE: 'awaiting_name_and_phone',
};

const GREETING_RE = /^(こんにちは|こんばんは|おはよう|はじめまして|初めまして|お世話になっ|お久しぶり|ども|どうも)/;
const BANNED_RE = /AI|システム|マイコン|サービス|導入/;

const INTRO = 'こんにちは😊 初めましてサロンコンシェルジュです！';
const ASK_BOTH = 'お名前と電話番号の下4桁を教えていただけますか？';

const MSG = {
  // 初回: [ack] あり版
  ASK_FIRST_TEMPLATE: (ack) => `${INTRO}\n${ack}\n${ASK_BOTH}`,
  // 初回: 挨拶のみ / ack生成失敗時
  ASK_FIRST_GREETING: `${INTRO}\nご利用ありがとうございます！\n${ASK_BOTH}`,
  // 再問: 片方欠けていた
  ASK_BOTH_AGAIN: 'お名前（フルネーム）と電話番号の下4桁を両方教えていただけますか？😊',
  ESCALATE: '一度担当の者にも確認しますね😊',
};

// ─── ヘルパー ───

const SUFFIX_RE = /(?:です|と申します|だよ|だと思います|だと?)[。.!！]*$/u;
const HONORIFIC_RE = /(?:さま|さん|様)$/u;

/**
 * 入力文から名前部分を抽出する。
 * 「田丸弘美です、1234」「090-1234-5678 田丸です」「田丸弘美、電話番号下4桁は1234です」等から
 * 電話関連キーワード・数字・語尾「です」「さん」等を除いて「田丸弘美」を取り出す。
 */
function extractNamePart(text) {
  if (!text) return '';
  let s = String(text);
  // 1. 電話関連の複合キーワードを先に除去（数字より先に処理する必要がある）
  s = s.replace(/電話番号の下\s*[4４]\s*桁/g, ' ');
  s = s.replace(/下\s*[4４]\s*桁/g, ' ');
  s = s.replace(/下\s*四\s*桁/g, ' ');
  s = s.replace(/電話番号|電話|番号/g, ' ');
  // 2. 数字連続を除去
  s = s.replace(/\d+/g, ' ');
  // 3. 区切り記号・句読点を空白化
  s = s.replace(/[、,。.!！？?\-＿_／\/\s　]+/g, ' ');
  // 4. サフィックス除去（trim後でないと $ に当たらない）
  s = s.trim().replace(SUFFIX_RE, '').trim();
  // 5. 敬称を除去
  s = s.replace(HONORIFIC_RE, '').trim();
  // 6. 末尾に残った助詞（「は」「を」「が」「の」「と」）を繰り返し除去
  let prev;
  do {
    prev = s;
    s = s.replace(/(は|を|が|の|と)\s*$/u, '').trim();
  } while (s !== prev);
  // 7. 空白を全て詰める
  return s.replace(/[\s　]+/g, '').trim();
}

function extractLast4(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{4})(?!\d)/);
  return m ? m[1] : null;
}

function pickName(customer) {
  return (customer && customer.customer_name) || '';
}

function getLinkingState(session) {
  if (!session.linking) {
    session.linking = {
      state: STATES.IDLE,
      lastInputName: null,
      originalIntent: null,
    };
  }
  return session.linking;
}

function resetLinking(session) {
  session.linking = {
    state: STATES.IDLE,
    lastInputName: null,
    originalIntent: null,
  };
}

async function logAttempt(userId, inputName, hits, result) {
  logCustomerAccess({
    action: 'customer_linking_attempt',
    actor: 'ai',
    customerId: null,
    details: { lineUserId: userId, inputName, hits, result },
  }).catch(() => {});
}

// ─── 初回メッセージ構築 ───

async function buildInitialMsg(userMessage) {
  if (!userMessage || GREETING_RE.test(userMessage.trim())) {
    return MSG.ASK_FIRST_GREETING;
  }
  let ack = null;
  try {
    ack = await generateAcknowledgement(userMessage);
  } catch (_) {}
  if (ack && BANNED_RE.test(ack)) ack = null;
  if (!ack) return MSG.ASK_FIRST_GREETING;
  return MSG.ASK_FIRST_TEMPLATE(ack);
}

// ─── 名前＋下4桁で検索 ───

async function findCustomerByNameAndLast4(name, last4) {
  const { customers } = await findCustomersByName(name);
  if (!customers || customers.length === 0) return [];
  return await findCustomersByPhoneLast4(last4, customers);
}

// ─── 紐づけ完了 ───

async function completeLinking(session, customer, helpers, userId, inputName) {
  const ok = await linkLineUserToCustomer(customer.id, userId);
  await logAttempt(userId, inputName, 1, ok ? 'success' : 'success_partial');

  if (ok) {
    try {
      const profile = await getCustomerProfile(userId, 'line_id');
      if (profile) helpers.setCustomerProfile(profile);
    } catch (_) {}
  }

  const name = pickName(customer);
  if (name) helpers.setDisplayName(name);

  const originalIntent = session.linking?.originalIntent || null;
  resetLinking(session);
  return { linked: true, originalIntent };
}

// ============================================
// メインフロー（1ターン型）
// ============================================

async function runLinkingFlow(session, userId, userMessage, helpers) {
  const linking = getLinkingState(session);
  if (session.customerProfile) return { handled: false };

  switch (linking.state) {

    // ─── IDLE: 用件に反応 + 名前＋下4桁を1回で聞く ───
    case STATES.IDLE: {
      linking.originalIntent = userMessage;
      linking.state = STATES.AWAITING_NAME_AND_PHONE;
      const msg = await buildInitialMsg(userMessage);
      await helpers.sendReply(msg);
      return { handled: true };
    }

    // ─── AWAITING_NAME_AND_PHONE: 名前と下4桁を同時に受け取って即判定 ───
    case STATES.AWAITING_NAME_AND_PHONE: {
      const name = extractNamePart(userMessage);
      const last4 = extractLast4(userMessage);

      // 片方欠けている → もう一度両方お願い
      if (!name || name.length < 2 || !last4) {
        await helpers.sendReply(MSG.ASK_BOTH_AGAIN);
        return { handled: true };
      }

      linking.lastInputName = name;

      const matched = await findCustomerByNameAndLast4(name, last4);

      if (matched.length === 1) {
        const result = await completeLinking(
          session,
          matched[0],
          helpers,
          userId,
          name,
        );
        return { handled: false, ...result };
      }

      // 0件 or 複数 → エスカレーション
      await logAttempt(userId, name, matched.length, 'escalated');
      await helpers.sendReply(MSG.ESCALATE);
      helpers.markEscalated();
      resetLinking(session);
      return { handled: true };
    }
  }

  // 想定外 → リセット
  resetLinking(session);
  return { handled: false };
}

module.exports = {
  runLinkingFlow,
  resetLinking,
  STATES,
  // テスト用
  extractNamePart,
  extractLast4,
};
