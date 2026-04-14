// ============================================
// routes/registration.js
// 顧客カルテ登録 API
// ============================================

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// 画像base64を受け取るため上限を大きめに
router.use(express.json({ limit: '15mb' }));

// ─── Supabase ───
let supabase = null;
function getSupabase() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return supabase;
}

// ─── Anthropic ───
let anthropic = null;
function getAnthropic() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').trim() });
  }
  return anthropic;
}

// ─── 電話番号正規化 ───
function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^\d+]/g, '');
}

// ============================================
// POST /analyze-photo - カルテ写真をAIで読み取る
// ============================================
router.post('/analyze-photo', async (req, res) => {
  const { image } = req.body;
  if (!image || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: '画像データが不正です' });
  }

  const client = getAnthropic();
  if (!client) {
    return res.status(503).json({ error: 'AIサービスが設定されていません' });
  }

  const match = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: '画像フォーマットが不正です' });
  }
  const mediaType = match[1];
  const data = match[2];

  const prompt = `この美容室の顧客カルテ写真から以下の項目を読み取ってJSONのみで返してください。不明な項目は空文字にしてください。余計な説明やマークダウンは一切含めないでください。

{
  "name": "顧客名",
  "phone": "電話番号（ハイフンなし数字のみ）",
  "lineName": "LINE名",
  "treatment": "施術内容（カット/カラー/パーマ等）",
  "chemical": "使用薬剤",
  "cycle": "来店周期（例: 2ヶ月）",
  "gender": "性別（男性/女性/その他）",
  "age": "年代（例: 30代）",
  "stylist": "担当スタイリスト",
  "memo": "メモ・備考"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // JSON部分を抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'AI応答からJSONを抽出できませんでした', raw: text });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[registration/analyze-photo] Error:', err.message);
    res.status(500).json({ error: '画像解析に失敗しました: ' + err.message });
  }
});

// ============================================
// GET /check-phone/:phone - 電話番号で既存顧客を検索
// ============================================
router.get('/check-phone/:phone', async (req, res) => {
  const sb = getSupabase();
  if (!sb) {
    return res.status(503).json({ error: 'データベース未接続' });
  }

  const phone = normalizePhone(req.params.phone);
  if (!phone) {
    return res.json({ exists: false });
  }

  try {
    const { data, error } = await sb
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;

    if (data) {
      res.json({ exists: true, customer: data });
    } else {
      res.json({ exists: false });
    }
  } catch (err) {
    console.error('[registration/check-phone] Error:', err.message);
    res.status(500).json({ error: '検索に失敗しました' });
  }
});

// ============================================
// POST /customer - 顧客を新規登録 or 更新
// ============================================
router.post('/customer', async (req, res) => {
  const sb = getSupabase();
  if (!sb) {
    return res.status(503).json({ error: 'データベース未接続' });
  }

  const {
    name,
    phone,
    lineName,
    treatment,
    chemical,
    cycle,
    gender,
    age,
    stylist,
    memo,
    salonId,
  } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: '名前と電話番号は必須です' });
  }

  const normalizedPhone = normalizePhone(phone);
  const now = new Date().toISOString();

  const record = {
    customer_name: name,
    name: name,
    phone: normalizedPhone,
    line_name: lineName || null,
    last_treatment: treatment || null,
    chemical: chemical || null,
    visit_cycle: cycle || null,
    gender: gender || null,
    age_group: age || null,
    stylist: stylist || null,
    memo: memo || null,
    salon_id: salonId || null,
    updated_at: now,
  };

  try {
    const { data: existing, error: findErr } = await sb
      .from('customers')
      .select('id')
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (findErr && findErr.code !== 'PGRST116') throw findErr;

    if (existing) {
      const { data, error } = await sb
        .from('customers')
        .update(record)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, mode: 'updated', customer: data });
    } else {
      const { data, error } = await sb
        .from('customers')
        .insert({ ...record, created_at: now })
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, mode: 'created', customer: data });
    }
  } catch (err) {
    console.error('[registration/customer] Error:', err.message);
    res.status(500).json({ error: '登録に失敗しました: ' + err.message });
  }
});

module.exports = router;
