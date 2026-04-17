// ============================================
// services/customerLinking.js
// LINE × カルテ紐づけ（段階的方式）
// IDLE → AWAITING_NAME → AWAITING_CONFIRM / AWAITING_PHONE_LAST4 → 完了
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
  AWAITING_NAME: 'awaiting_name',
  AWAITING_CONFIRM: 'awaiting_confirm',
  AWAITING_MAYBE_CONFIRM: 'awaiting_maybe_confirm',
  AWAITING_PHONE_LAST4: 'awaiting_phone_last4',
};

const GREETING_RE = /^(こんにちは|こんばんは|おはよう|はじめまして|初めまして|お世話になっ|お久しぶり|ども|どうも)/;
const BANNED_RE = /AI|システム|マイコン|サービス|導入/;

const INTRO = 'こんにちは😊 初めましてサロンコンシェルジュです！';

const MSG = {
  ASK_NAME_TEMPLATE: (ack) =>
    `${INTRO}\n${ack}\nお名前をフルネームで教えていただけますか？`,
  ASK_NAME_GREETING:
    `${INTRO}\nご利用ありがとうございます！\nお名前をフルネームで教えていただけますか？`,
  ASK_NAME_RETRY: 'お名前をフルネームで教えていただけますか？😊',
  CONFIRM: (name) => `${name}さまでお間違いないでしょうか？😊`,
  MAYBE:   (name) => `もしかして${name}さまでしょうか？😊`,
  ASK_LAST4: 'お電話番号の下4桁教えていただけますか？😊',
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

function isYes(text) {
  return /(はい|そう|間違いない|あって|そうです|そうだ|yes|ok|了解|お願いします)/i.test(text);
}
function isNo(text) {
  return /(いいえ|ちが|違|別人|別|no|ノー|別の)/i.test(text);
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
      candidates: [],
      lastInputName: null,
      originalIntent: null,
    };
  }
  return session.linking;
}

function resetLinking(session) {
  session.linking = {
    state: STATES.IDLE,
    candidates: [],
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
    return MSG.ASK_NAME_GREETING;
  }
  let ack = null;
  try {
    ack = await generateAcknowledgement(userMessage);
  } catch (_) {}
  if (ack && BANNED_RE.test(ack)) ack = null;
  const reaction = ack || '承知しました😊';
  return MSG.ASK_NAME_TEMPLATE(reaction);
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
// メインフロー（段階的方式）
// ============================================

async function runLinkingFlow(session, userId, userMessage, helpers) {
  const linking = getLinkingState(session);
  if (session.customerProfile) return { handled: false };

  switch (linking.state) {

    // ─── IDLE: 用件に反応 + 名前を聞く ───
    case STATES.IDLE: {
      linking.originalIntent = userMessage;
      linking.state = STATES.AWAITING_NAME;
      const msg = await buildInitialMsg(userMessage);
      await helpers.sendReply(msg);
      return { handled: true };
    }

    // ─── AWAITING_NAME: 名前を受け取って検索 ───
    case STATES.AWAITING_NAME: {
      const inputName = normalizeName(userMessage);
      if (!inputName || inputName.length < 2) {
        await helpers.sendReply(MSG.ASK_NAME_RETRY);
        return { handled: true };
      }
      linking.lastInputName = inputName;

      const { customers, matchKind } = await findCustomersByName(inputName);

      if (customers.length === 1 && matchKind === 'exact') {
        linking.candidates = customers;
        linking.state = STATES.AWAITING_CONFIRM;
        await helpers.sendReply(MSG.CONFIRM(pickName(customers[0])));
        return { handled: true };
      }

      if (customers.length === 1 && matchKind === 'partial') {
        linking.candidates = customers;
        linking.state = STATES.AWAITING_MAYBE_CONFIRM;
        await helpers.sendReply(MSG.MAYBE(pickName(customers[0])));
        return { handled: true };
      }

      if (customers.length > 1) {
        linking.candidates = customers;
        linking.state = STATES.AWAITING_PHONE_LAST4;
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }

      // 0件 → 電話番号で全件から探す
      linking.candidates = [];
      linking.state = STATES.AWAITING_PHONE_LAST4;
      await helpers.sendReply(MSG.ASK_LAST4);
      return { handled: true };
    }

    // ─── AWAITING_CONFIRM: 1件完全一致 → YES/NO ───
    case STATES.AWAITING_CONFIRM: {
      if (isYes(userMessage)) {
        const cand = linking.candidates[0];
        if (cand) {
          const result = await completeLinking(session, cand, helpers, userId, linking.lastInputName);
          return { handled: false, ...result };
        }
      }
      if (isNo(userMessage)) {
        linking.candidates = [];
        linking.state = STATES.AWAITING_PHONE_LAST4;
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }
      // YES/NO以外
      const cand = linking.candidates[0];
      if (cand) {
        await helpers.sendReply(MSG.CONFIRM(pickName(cand)));
      } else {
        linking.state = STATES.AWAITING_NAME;
        await helpers.sendReply(MSG.ASK_NAME_RETRY);
      }
      return { handled: true };
    }

    // ─── AWAITING_MAYBE_CONFIRM: 部分一致 → もしかして ───
    case STATES.AWAITING_MAYBE_CONFIRM: {
      if (isYes(userMessage)) {
        const cand = linking.candidates[0];
        if (cand) {
          const result = await completeLinking(session, cand, helpers, userId, linking.lastInputName);
          return { handled: false, ...result };
        }
      }
      if (isNo(userMessage)) {
        linking.candidates = [];
        linking.state = STATES.AWAITING_PHONE_LAST4;
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }
      const cand = linking.candidates[0];
      if (cand) {
        await helpers.sendReply(MSG.MAYBE(pickName(cand)));
      } else {
        linking.state = STATES.AWAITING_NAME;
        await helpers.sendReply(MSG.ASK_NAME_RETRY);
      }
      return { handled: true };
    }

    // ─── AWAITING_PHONE_LAST4: 電話番号で絞り込み ───
    case STATES.AWAITING_PHONE_LAST4: {
      const last4 = extractLast4(userMessage);
      if (!last4) {
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }
      const restrictTo = linking.candidates.length > 0 ? linking.candidates : null;
      const matched = await findCustomersByPhoneLast4(last4, restrictTo);

      if (matched.length === 1) {
        const result = await completeLinking(session, matched[0], helpers, userId, linking.lastInputName);
        return { handled: false, ...result };
      }

      // 0件 or 複数 → エスカレーション
      await logAttempt(userId, linking.lastInputName, matched.length, 'escalated');
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
  isYes,
  isNo,
  extractLast4,
};
