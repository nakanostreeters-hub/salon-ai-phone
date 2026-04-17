// ============================================
// services/customerLinking.js
// LINE × カルテ紐づけ MVP
// 状態機械でお客様から名前/電話下4桁を聞いて顧客を確定する
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

const MSG = {
  ASK_NAME_GREETING: 'ご利用ありがとうございます！まずお名前をフルネームで教えていただけますか？😊',
  ASK_NAME_TEMPLATE: (ack) => `${ack} 確認いたしますので、お名前をフルネームで教えていただけますか？`,
  CONFIRM:  (name) => `${name}さまでお間違いないでしょうか？😊`,
  MAYBE:    (name) => `もしかして${name}さまでしょうか？😊`,
  ASK_LAST4: 'お電話番号の下4桁だけ教えていただけますか？😊',
  ESCALATE: '一度担当の者にも確認しますね😊',
};

/**
 * お客様の最初の発話内容に応じた「名前を教えてください」文を構築する。
 * - 挨拶のみ   → 既定の ASK_NAME_GREETING
 * - それ以外   → AI生成の受け止め（文脈に合った一言）+ 名前要求
 *   例: 「本日かほさん空きありますか?」→「承知しました😊 確認いたしますので、お名前を…」
 *       「カラーしたい」                 →「いいですね😊 確認いたしますので、お名前を…」
 *       「予約を間違えた」               →「ご確認いたしますね 確認いたしますので、お名前を…」
 */
async function buildAskNameMsg(userMessage) {
  if (!userMessage || GREETING_RE.test(userMessage.trim())) {
    return MSG.ASK_NAME_GREETING;
  }
  const ack = await generateAcknowledgement(userMessage);
  if (!ack) return MSG.ASK_NAME_GREETING;
  return MSG.ASK_NAME_TEMPLATE(ack);
}

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
  // 連続した4桁を抽出（電話番号の下4桁を想定）
  const m = String(text).match(/(\d{4})(?!\d)/);
  return m ? m[1] : null;
}

function pickName(customer) {
  return (customer && customer.customer_name) || '';
}

function getLinkingState(session) {
  if (!session.linking) {
    session.linking = { state: STATES.IDLE, candidates: [], lastInputName: null, originalIntent: null };
  }
  return session.linking;
}

function resetLinking(session) {
  session.linking = { state: STATES.IDLE, candidates: [], lastInputName: null };
}

/**
 * @typedef {object} LinkingHelpers
 * @property {(text: string) => Promise<void>} sendReply  - replyTokenでLINEに送信
 * @property {(name: string) => void} setDisplayName       - セッションの表示名を更新
 * @property {(profile: object) => void} setCustomerProfile - セッションのcustomerProfileを更新
 * @property {() => void} markEscalated                    - スタッフ引き継ぎフラグを立てる
 */

async function logAttempt(userId, inputName, hits, result) {
  logCustomerAccess({
    action: 'customer_linking_attempt',
    actor: 'ai',
    customerId: null,
    details: { lineUserId: userId, inputName, hits, result },
  }).catch(() => {});
}

/**
 * 紐づけ完了処理: DB更新 + セッション更新 + ログ
 * 返り値: 紐づけ完了後に通常AIフローへ移行するための情報
 */
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

  // 紐づけ後に「次回もお気軽に」で会話を終わらせない。
  // originalIntent を返して呼び出し元のAIフローに引き継ぐ。
  const originalIntent = session.linking?.originalIntent || null;
  resetLinking(session);

  return { linked: true, originalIntent };
}

/**
 * 紐づけフローを1ターン進める。
 * @returns {Promise<{handled: boolean}>}
 *   handled=true なら通常のAIフローはスキップ。false なら通常フローへ。
 */
async function runLinkingFlow(session, userId, userMessage, helpers) {
  const linking = getLinkingState(session);

  // 既に紐づけ済み（呼び出し元でチェックすべきだが念のため）
  if (session.customerProfile) return { handled: false };

  // 状態機械
  switch (linking.state) {
    case STATES.IDLE: {
      // 初回 → お客様の用件に一言反応してから名前を聞く
      linking.originalIntent = userMessage;
      linking.state = STATES.AWAITING_NAME;
      const askMsg = await buildAskNameMsg(userMessage);
      await helpers.sendReply(askMsg);
      return { handled: true };
    }

    case STATES.AWAITING_NAME: {
      const inputName = normalizeName(userMessage);
      if (!inputName || inputName.length < 2) {
        // 名前として認識できない → もう一度
        await helpers.sendReply(MSG.ASK_NAME_GREETING);
        return { handled: true };
      }
      linking.lastInputName = inputName;

      const { customers, matchKind } = await findCustomersByName(inputName);

      if (customers.length === 1 && matchKind === 'exact') {
        // 1件確定候補
        linking.candidates = customers;
        linking.state = STATES.AWAITING_CONFIRM;
        await helpers.sendReply(MSG.CONFIRM(pickName(customers[0])));
        return { handled: true };
      }

      if (customers.length > 1) {
        // 複数 → 電話番号で絞り込み
        linking.candidates = customers;
        linking.state = STATES.AWAITING_PHONE_LAST4;
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }

      if (customers.length === 1 && matchKind === 'partial') {
        // 部分一致1件 → 「もしかして」確認
        linking.candidates = customers;
        linking.state = STATES.AWAITING_MAYBE_CONFIRM;
        await helpers.sendReply(MSG.MAYBE(pickName(customers[0])));
        return { handled: true };
      }

      // 0件 or 部分一致複数 → 電話番号で
      if (customers.length > 1) {
        linking.candidates = customers;
      } else {
        linking.candidates = [];
      }
      linking.state = STATES.AWAITING_PHONE_LAST4;
      await helpers.sendReply(MSG.ASK_LAST4);
      return { handled: true };
    }

    case STATES.AWAITING_CONFIRM: {
      if (isYes(userMessage)) {
        const cand = linking.candidates[0];
        if (cand) {
          const result = await completeLinking(session, cand, helpers, userId, linking.lastInputName);
          return { handled: false, ...result };
        }
      }
      if (isNo(userMessage)) {
        // 違う → 電話番号で再特定
        linking.candidates = [];
        linking.state = STATES.AWAITING_PHONE_LAST4;
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }
      // YES/NO以外 → もう一度確認
      const cand = linking.candidates[0];
      if (cand) {
        await helpers.sendReply(MSG.CONFIRM(pickName(cand)));
      } else {
        linking.state = STATES.AWAITING_NAME;
        await helpers.sendReply(MSG.ASK_NAME_GREETING);
      }
      return { handled: true };
    }

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
        await helpers.sendReply(MSG.ASK_NAME_GREETING);
      }
      return { handled: true };
    }

    case STATES.AWAITING_PHONE_LAST4: {
      const last4 = extractLast4(userMessage);
      if (!last4) {
        await helpers.sendReply(MSG.ASK_LAST4);
        return { handled: true };
      }
      const restrictTo = (linking.candidates && linking.candidates.length > 0) ? linking.candidates : null;
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

  // 想定外の状態 → リセット
  resetLinking(session);
  return { handled: false };
}

module.exports = {
  runLinkingFlow,
  resetLinking,
  STATES,
  // テスト用
  normalizeName,
  isYes,
  isNo,
  extractLast4,
};
