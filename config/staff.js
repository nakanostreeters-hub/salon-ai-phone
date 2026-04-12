// ============================================
// config/staff.js
// スタイリスト設定（名前 → LINE userId マッピング）
// ============================================
//
// LINE userIdの登録方法：
// スタイリストがPREMIER MODELS 中野のLINE公式アカウントに
// 「スタッフ登録:名前」と送信すると、自動でuserIdが登録されます。
// 例: 「スタッフ登録:梶原広樹」
//
// または、このファイルに直接userIdを記入してください。
// userIdはサーバーログに表示されます。
// ============================================

const STAFF_LIST = [
  { name: '梶原広樹', lineUserId: 'U28f5e93879c736892236ae2b2b5540b2', slackUserId: '' },
  { name: '森美奈子', lineUserId: '', slackUserId: '' },
  { name: '大田夏帆', lineUserId: '', slackUserId: '' },
  { name: '渡邊達也', lineUserId: '', slackUserId: '' },
  { name: 'JUN', lineUserId: '', slackUserId: '' },
  { name: 'じゃっきー', lineUserId: '', slackUserId: '' },
];

/**
 * 名前でスタッフを検索（部分一致）
 * @param {string} name
 * @returns {object|null}
 */
function findStaffByName(name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  return STAFF_LIST.find((s) => {
    const staffName = s.name.toLowerCase();
    return staffName.includes(normalized) || normalized.includes(staffName);
  }) || null;
}

/**
 * LINE userIdでスタッフを検索
 * @param {string} lineUserId
 * @returns {object|null}
 */
function findStaffByLineUserId(lineUserId) {
  if (!lineUserId) return null;
  return STAFF_LIST.find((s) => s.lineUserId === lineUserId) || null;
}

/**
 * スタッフのLINE userIdを登録
 * @param {string} name
 * @param {string} lineUserId
 * @returns {boolean}
 */
function registerStaffLineUserId(name, lineUserId) {
  const staff = findStaffByName(name);
  if (staff) {
    staff.lineUserId = lineUserId;
    console.log(`[Staff] LINE userId登録: ${staff.name} → ${lineUserId}`);
    return true;
  }
  return false;
}

/**
 * スタッフ名の一覧を返す
 * @returns {string[]}
 */
function getStaffNames() {
  return STAFF_LIST.map((s) => s.name);
}

module.exports = {
  STAFF_LIST,
  findStaffByName,
  findStaffByLineUserId,
  registerStaffLineUserId,
  getStaffNames,
};
