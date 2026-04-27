// ============================================
// services/questEngine.js
// Maikon Quest — 経験値・レベル・動物・じょうたい計算エンジン
// Phase 0: 初期シンプルロジック
// ============================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;

const ANIMAL_PERSONALITY = {
  cat:      'おっとり',
  rabbit:   'げんき',
  dog:      'ぼくとつ',
  sheep:    'ふつう',
  squirrel: 'きちょうめん',
  panda:    'まったり',
  bear:     'こだわり',
  fox:      'キザ',
};

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function daysSince(date, now = new Date()) {
  const d = toDate(date);
  if (!d) return null;
  return Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY);
}

function yearsBetween(start, end) {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return 0;
  return Math.max(0, (e.getTime() - s.getTime()) / MS_PER_YEAR);
}

/**
 * 経験値計算。
 *   base  = visit_count * 50
 *   loyal = relation_years * 50
 *   bonus = 最終来店90日以内なら +100
 */
function calcExperience(customer, now = new Date()) {
  const visitCount = Number(customer.visit_count) || 0;
  const relationYears = yearsBetween(customer.first_visit_at, now);
  const lastVisitDays = daysSince(customer.last_visit_at, now);

  const base = visitCount * 50;
  const loyal = Math.floor(relationYears * 50);
  const recencyBonus = (lastVisitDays != null && lastVisitDays <= 90) ? 100 : 0;

  return {
    exp: base + loyal + recencyBonus,
    breakdown: { base, loyal, recencyBonus, visitCount, relationYears, lastVisitDays },
  };
}

/**
 * レベル計算。
 *   Lv = floor(sqrt(Exp / 100)) + 1
 */
function calcLevel(exp) {
  const safe = Math.max(0, Number(exp) || 0);
  return Math.floor(Math.sqrt(safe / 100)) + 1;
}

/**
 * どうぶつ判定（Phase 0 シンプルロジック）
 *   visit_count >= 30 かつ 関係10年以上 → cat  / おっとり
 *   visit_count >= 50                 → rabbit / げんき
 *   visit_count < 3                   → dog    / ぼくとつ
 *   その他                             → sheep  / ふつう
 * 上から順に評価し、最初にマッチしたものを採用。
 */
function determineAnimal(customer, now = new Date()) {
  const visitCount = Number(customer.visit_count) || 0;
  const relationYears = yearsBetween(customer.first_visit_at, now);

  let animal;
  if (visitCount >= 30 && relationYears >= 10) {
    animal = 'cat';
  } else if (visitCount >= 50) {
    animal = 'rabbit';
  } else if (visitCount < 3) {
    animal = 'dog';
  } else {
    animal = 'sheep';
  }

  return {
    animal,
    personality: ANIMAL_PERSONALITY[animal] || null,
  };
}

/**
 * じょうたい判定
 *   visit_count <= 3                                  → NEW
 *   visit_count >= 30 かつ 最終来店90日以内            → とびっきり
 *   最終来店90日以内                                  → げんき
 *   最終来店90日超                                    → おやすみ
 *   最終来店不明（first/last ともに null）             → NEW 扱い
 */
function determineState(customer, now = new Date()) {
  const visitCount = Number(customer.visit_count) || 0;
  const lastVisitDays = daysSince(customer.last_visit_at, now);

  if (visitCount <= 3) return 'NEW';
  if (lastVisitDays == null) return 'NEW';
  if (visitCount >= 30 && lastVisitDays <= 90) return 'とびっきり';
  if (lastVisitDays <= 90) return 'げんき';
  return 'おやすみ';
}

/**
 * 顧客1人分のMaikon Questステータスを一気に算出。
 * 既存カラム（visit_count / first_visit_at / last_visit_at）のみ使用。
 */
function computeCustomerQuest(customer, now = new Date()) {
  const { exp, breakdown } = calcExperience(customer, now);
  const level = calcLevel(exp);
  const { animal, personality } = determineAnimal(customer, now);
  const state = determineState(customer, now);

  return {
    mq_experience: exp,
    mq_level: level,
    mq_animal: animal,
    mq_personality: personality,
    mq_state: state,
    _debug: breakdown,
  };
}

module.exports = {
  ANIMAL_PERSONALITY,
  calcExperience,
  calcLevel,
  determineAnimal,
  determineState,
  computeCustomerQuest,
};
