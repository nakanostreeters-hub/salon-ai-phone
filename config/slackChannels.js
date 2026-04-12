// ============================================
// config/slackChannels.js
// Slack チャンネル設定（担当スタイリスト別振り分け）
// ============================================
//
// チャンネル作成後、各チャンネルIDを記入してください。
// Slackでチャンネル名を右クリック → 「チャンネル詳細」→ 下部にチャンネルIDがあります。
// ============================================

// 全件受付チャンネル（管理者が全体を把握する用）
const CHANNEL_ALL = process.env.SLACK_CHANNEL_ALL || '';

// 新規お客様チャンネル（担当未定）
const CHANNEL_NEW = process.env.SLACK_CHANNEL_NEW || '';

// スタイリスト別チャンネル
const STYLIST_CHANNELS = {
  '梶原広樹': process.env.SLACK_CH_KAJIWARA || '',
  '森美奈子': process.env.SLACK_CH_MORI || '',
  '大田夏帆': process.env.SLACK_CH_OTA || '',
  '渡邊達也': process.env.SLACK_CH_WATANABE || '',
  'JUN': process.env.SLACK_CH_JUN || '',
  'じゃっきー': process.env.SLACK_CH_JACKIE || '',
};

/**
 * スタイリスト名からチャンネルIDを取得
 * @param {string} stylistName
 * @returns {string} channelId（見つからなければ新規お客様チャンネル）
 */
function getChannelForStylist(stylistName) {
  if (!stylistName || stylistName === '未定') {
    return CHANNEL_NEW;
  }
  // 部分一致で検索
  const normalized = stylistName.trim();
  for (const [name, channelId] of Object.entries(STYLIST_CHANNELS)) {
    if (name.includes(normalized) || normalized.includes(name)) {
      return channelId;
    }
  }
  return CHANNEL_NEW;
}

module.exports = {
  CHANNEL_ALL,
  CHANNEL_NEW,
  STYLIST_CHANNELS,
  getChannelForStylist,
};
