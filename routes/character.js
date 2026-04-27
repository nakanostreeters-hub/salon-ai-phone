// ============================================
// routes/character.js
// Maikon Quest — お客様キャラクターカード（じゅうみんカード）
// ============================================

const express = require('express');
const path = require('path');
const { getAdminClient, getAnonClient } = require('../supabase-client');

const router = express.Router();

function getSupabase() {
  return getAdminClient() || getAnonClient();
}

// ─── 16タイプ仮データ（DBに無い場合の補完） ───
// 田丸さん(karte_no=9215) のみ固定値で返す。他は null のまま。
function fallbackMqType(karteNo) {
  if (Number(karteNo) === 9215) {
    return { mq_type_4letter: 'INFJ', mq_type_nickname: '静かな賢者' };
  }
  return { mq_type_4letter: null, mq_type_nickname: null };
}

// ─── バッジ算出（visits/年数から機械的に） ───
function computeBadges(customer) {
  const badges = [];
  const vc = Number(customer.visit_count) || 0;
  const first = customer.first_visit_at ? new Date(customer.first_visit_at) : null;

  if (first && !isNaN(first)) {
    const years = (Date.now() - first.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (years >= 10) badges.push({ emoji: '🏅', label: '10年クルー' });
    else if (years >= 5) badges.push({ emoji: '🎖️', label: '5年クルー' });
    else if (years >= 1) badges.push({ emoji: '🌱', label: '1年クルー' });
  }

  if (vc >= 100) badges.push({ emoji: '👑', label: '100回達成' });
  else if (vc >= 48) badges.push({ emoji: '💎', label: '48回達成' });
  else if (vc >= 20) badges.push({ emoji: '⭐', label: '20回達成' });
  else if (vc >= 10) badges.push({ emoji: '✨', label: '10回達成' });

  if (customer.mq_state === 'とびっきり') {
    badges.push({ emoji: '🔥', label: 'とびっきりバッジ' });
  }

  // DB の mq_titles が配列ならそのまま追加
  if (Array.isArray(customer.mq_titles)) {
    for (const t of customer.mq_titles) {
      if (typeof t === 'string') badges.push({ emoji: '🎗️', label: t });
    }
  }
  return badges;
}

// ============================================
// GET /character/api/:karte_no — 顧客データ JSON
// ============================================
router.get('/api/:karte_no', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: 'データベース未接続' });

  const karteNo = Number(req.params.karte_no);
  if (!Number.isFinite(karteNo)) {
    return res.status(400).json({ error: 'karte_no が不正です' });
  }

  try {
    const { data: customer, error } = await sb
      .from('customers')
      .select('*')
      .eq('karte_no', karteNo)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    if (!customer) {
      return res.status(404).json({ error: 'お客様が見つかりませんでした', karte_no: karteNo });
    }

    // 16タイプ補完
    const fallback = fallbackMqType(karteNo);
    const mqType4 = customer.mq_type_4letter || fallback.mq_type_4letter;
    const mqTypeNick = customer.mq_type_nickname || fallback.mq_type_nickname;

    const badges = computeBadges(customer);

    res.json({
      success: true,
      customer: {
        id: customer.id,
        karte_no: customer.karte_no,
        name: customer.customer_name || customer.name || 'お客様',
        customer_segment: customer.customer_segment || null,
        visit_count: customer.visit_count || 0,
        first_visit_at: customer.first_visit_at || null,
        last_visit_at: customer.last_visit_at || null,
        stylist: customer.stylist || null,
        mq_level: customer.mq_level || 1,
        mq_experience: customer.mq_experience || 0,
        mq_animal: customer.mq_animal || 'sheep',
        mq_personality: customer.mq_personality || null,
        mq_state: customer.mq_state || null,
        mq_titles: customer.mq_titles || [],
        mq_type_4letter: mqType4,
        mq_type_nickname: mqTypeNick,
      },
      badges,
    });
  } catch (err) {
    console.error('[character/api] Error:', err.message);
    res.status(500).json({ error: '取得に失敗しました: ' + err.message });
  }
});

// ============================================
// GET /character/:karte_no — カードHTML
// ============================================
router.get('/:karte_no', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'character.html'));
});

module.exports = router;
