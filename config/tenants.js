// ============================================
// config/tenants.js
// テナント（契約者）ごとの設定管理
// ============================================

const tenants = {
  // サロンモード（既存 PREMIER MODELS）
  'premier-models': {
    id: 'premier-models',
    mode: 'salon',
    name: 'PREMIER MODELS 中野',
    lineChannelId: process.env.LINE_CHANNEL_ID,
    lineChannelSecret: process.env.LINE_CHANNEL_SECRET,
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackChannel: 'C0AL35N4Y06',
    karutekunWebhook: 'https://line-webhook.karutekun.com/webhook/salons/227',
    staffList: ['梶原広樹', '森美奈子', '大田夏帆', '渡邊達也', 'JUN'],
    businessHours: { open: '10:00', close: '20:00' },
    closedDays: ['火曜日'],
  },

  // フリーランスモードのテンプレート
  // 将来的に管理画面から追加される
  'freelance-template': {
    id: 'freelance-template',
    mode: 'freelance',
    name: '',
    lineChannelId: '',
    lineChannelSecret: '',
    lineChannelAccessToken: '',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY,
    staffList: [], // 本人のみ（1人）
    notification: {
      type: 'email', // 'email' | 'line' | 'push'
      destination: '',
    },
    businessHours: { open: '10:00', close: '20:00' },
    closedDays: [],
    karteSource: 'none', // 'csv' | 'manual' | 'none'
  },
};

/**
 * テナントIDでテナントを取得
 * @param {string} tenantId
 * @returns {object|null}
 */
function getTenant(tenantId) {
  return tenants[tenantId] || null;
}

/**
 * LINE Channel IDからテナントを特定
 * @param {string} channelId
 * @returns {object|null}
 */
function getTenantByLineChannel(channelId) {
  if (!channelId) return null;
  return Object.values(tenants).find(t => t.lineChannelId === channelId) || null;
}

module.exports = {
  tenants,
  getTenant,
  getTenantByLineChannel,
};
