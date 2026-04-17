// ============================================
// services/customerLinking.js
// LINE × カルテ紐づけ
// 名前 + 電話番号下4桁を1回で聞いて照合、両方一致で紐づけ確定
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
  AWAITING_INFO: 'awaiting_info',        // 名前+電話下4桁を待っている
  AWAITING_REMAINING: 'awaiting_remaining', // 片方だけ来た→残りを待っている
};

const GREETING_RE = /^(こんにちは|こんばんは|おはよう|はじめまして|初めまして|お世話になっ|お久しぶり|ども|どうも)/;

// 禁止ワード: AI, システム, マイコン, サービス, 導入
const BANNED_RE = /AI|システム|マイコン|サービス|導入/;

const INTRO = 'こんにちは😊 初めましてサロンコンシェルジュです！';

const MSG = {
  ASK_BOTH_TEMPLATE: (ack) =>
    `${INTRO}\n${ack}\n念のためお名前と電話番号の下4桁教えていただけますか？`,
  ASK_BOTH_GREETING:
    `${INTRO}\nご利用ありがとうございます！\n念のためお名前と電話番号の下4桁教えていただけますか？`,
  ASK_LAST4: '電話番号の下4桁も教えていただけますか？😊',
  ASK_NAME: 'お名前も教えていただけますか？😊',
  ESCALATE: '一度担当の者にも確認しますね😊',
};

// ─── ヘルパー ───

const SUFFIX_RE = /(?:です|と申します|だよ|だと思います|だと?)[。.!！]*$/u;
const HONORIFIC_RE = /(?:さま|さん|様)$/u;

function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .replace(SUFFIX_RE, '')
    .replace(HONORIFIC_RE, '')
    .replace(/[\s　]+/g, '')
    .trim();
}

function extractLast4(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{4})(?!\d)/);
  return m ? m[1] : null;
}

/** メッセージから名前部分を抽出（数字4桁を除去→トリム→正規化） */
function extractNamePart(text) {
  if (!text) return '';
  let s = String(text).replace(/\d{4}/g, '').trim();
  return normalizeName(s);
}

function pickName(customer) {
  return (customer && customer.customer_name) || '';
}

function getLinkingState(session) {
  if (!session.linking) {
    session.linking = {
      state: STATES.IDLE,
      originalIntent: null,
      collectedName: null,
      collectedLast4: null,
    };
  }
  return session.linking;
}

function resetLinking(session) {
  session.linking = {
    state: STATES.IDLE,
    originalIntent: null,
    collectedName: null,
    collectedLast4: null,
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

/**
 * 名前 + 電話下4桁の両方で照合し、1件ヒットなら紐づけ完了
 */
async function tryMatch(session, helpers, userId, name, last4) {
  // 名前で候補取得
  const { customers } = await findCustomersByName(name);
  if (customers.length === 0) {
    // 名前ヒットなし → 電話だけで試す
    const byPhone = await findCustomersByPhoneLast4(last4);
    if (byPhone.length === 1) {
      return await completeLinking(session, byPhone[0], helpers, userId, name);
    }
    await logAttempt(userId, name, 0, 'escalated');
    return null;
  }

  // 名前候補の中から電話下4桁で絞る
  const matched = customers.filter(c => {
    const p = String(c.phone || '').replace(/\D/g, '');
    return p.endsWith(last4);
  });

  if (matched.length === 1) {
    return await completeLinking(session, matched[0], helpers, userId, name);
  }

  // 0件 or 複数 → エスカレーション
  await logAttempt(userId, name, matched.length, 'escalated');
  return null;
}

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

/**
 * 初回メッセージを構築（用件への反応付き）
 */
async function buildInitialMsg(userMessage) {
  if (!userMessage || GREETING_RE.test(userMessage.trim())) {
    return MSG.ASK_BOTH_GREETING;
  }
  let ack = null;
  try {
    ack = await generateAcknowledgement(userMessage);
  } catch (_) {}

  // 禁止ワードチェック
  if (ack && BANNED_RE.test(ack)) ack = null;

  const reaction = ack || '承知しました😊';
  return MSG.ASK_BOTH_TEMPLATE(reaction);
}

// ============================================
// メインフロー
// ============================================

async function runLinkingFlow(session, userId, userMessage, helpers) {
  const linking = getLinkingState(session);

  if (session.customerProfile) return { handled: false };

  switch (linking.state) {
    case STATES.IDLE: {
      linking.originalIntent = userMessage;
      linking.state = STATES.AWAITING_INFO;
      const msg = await buildInitialMsg(userMessage);
      await helpers.sendReply(msg);
      return { handled: true };
    }

    case STATES.AWAITING_INFO: {
      // メッセージから名前と電話番号下4桁を抽出
      const last4 = extractLast4(userMessage);
      const name = extractNamePart(userMessage);

      if (name && name.length >= 2 && last4) {
        // 両方揃った → 照合
        linking.collectedName = name;
        linking.collectedLast4 = last4;
        const result = await tryMatch(session, helpers, userId, name, last4);
        if (result) return { handled: false, ...result };
        // マッチなし → エスカレーション
        await helpers.sendReply(MSG.ESCALATE);
        helpers.markEscalated();
        resetLinking(session);
        return { handled: true };
      }

      if (name && name.length >= 2 && !last4) {
        // 名前のみ → 電話下4桁を追加で聞く
        linking.collectedName = name;
        linking.state = STATES.AWAITING_REMAINING;
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }

      if (last4 && (!name || name.length < 2)) {
        // 電話のみ → 名前を追加で聞く
        linking.collectedLast4 = last4;
        linking.state = STATES.AWAITING_REMAINING;
        await helpers.sendReply(MSG.ASK_NAME);
        return { handled: true };
      }

      // どちらも取れない → もう一度
      await helpers.sendReply('お名前と電話番号の下4桁を教えていただけますか？😊');
      return { handled: true };
    }

    case STATES.AWAITING_REMAINING: {
      // 足りなかった方を補完
      const last4 = linking.collectedLast4 || extractLast4(userMessage);
      const name = linking.collectedName || extractNamePart(userMessage);

      if ((!name || name.length < 2) && !last4) {
        await helpers.sendReply('お名前と電話番号の下4桁を教えていただけますか？😊');
        return { handled: true };
      }

      // 片方がまだ無い
      if (!last4) {
        if (!linking.collectedName && name && name.length >= 2) {
          linking.collectedName = name;
        }
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }
      if (!name || name.length < 2) {
        if (!linking.collectedLast4 && last4) {
          linking.collectedLast4 = last4;
        }
        await helpers.sendReply(MSG.ASK_NAME);
        return { handled: true };
      }

      // 両方揃った
      const result = await tryMatch(session, helpers, userId, name, last4);
      if (result) return { handled: false, ...result };

      await helpers.sendReply(MSG.ESCALATE);
      helpers.markEscalated();
      resetLinking(session);
      return { handled: true };
    }
  }

  resetLinking(session);
  return { handled: false };
}

module.exports = {
  runLinkingFlow,
  resetLinking,
  STATES,
  normalizeName,
  extractLast4,
  extractNamePart,
};
