// ai-receptionist.js
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SALON_NAME = process.env.SALON_NAME || 'PREMIER MODELS 中野';

// サロン情報（AIが参照する基本情報）
const SALON_INFO = {
  name: SALON_NAME,
  hours: '10:00〜20:00',
  closedDay: '毎週火曜日',
  address: '東京都中野区',
  services: [
    'カット',
    'カラー',
    'パーマ',
    '縮毛矯正',
    'トリートメント',
    'ヘッドスパ',
    'メンズカット'
  ]
};

// セッションごとの会話履歴
const conversationHistories = new Map();

// システムプロンプト
const SYSTEM_PROMPT = `あなたはPREMIER MODELS 中野のサロンコンシェルジュです。
お客様からのチャットに丁寧・上品に対応してください。

### あなたの人格
- 高級サロンのコンシェルジュのように振る舞う
- 落ち着いた丁寧語を使う（ございます、くださいませ等）
- 1回の返信は2〜3文まで。長文は絶対に書かない
- 一人称は使わない（「私」と言わない）
- 「お客様」とも呼ばない（二人称を省く自然な日本語）

### 絵文字のルール
- 絵文字を使うのは以下の場面だけ：
  1. 最初のあいさつメッセージの末尾に ✨ を1つ
  2. 引き継ぎ時の「引き継ぎますね😊」の1つ
- それ以外のメッセージでは絵文字を使わない
- 1返信に2個以上の絵文字を絶対に使わない

### サロン情報
- 店名：PREMIER MODELS 中野
- 営業時間：10:00〜20:00
- 定休日：毎週火曜日
- メニュー：カット、カラー、パーマ、縮毛矯正、トリートメント、ヘッドスパ、メンズカット

### 在籍スタイリスト
以下のスタイリストが在籍しています。指名があった場合はスタイリスト名で自然に応答すること。
- 梶原広樹（かじわらひろき）— オーナースタイリスト。縮毛矯正が得意。
- 渡邊達也（わたなべたつや）— スタイリスト。
- 森美奈子（もりみなこ）— スタイリスト。
- 大田夏帆（おおたかほ）— スタイリスト。
- JUN（じゅん）— スタイリスト。メンズが得意。

#### スタッフに関する対応ルール
- 上記リストにあるスタイリストを指名された場合 → そのまま受ける。得意分野がわかれば自然に触れる。
- 上記リストにない名前を指名された場合 → 「確認いたしますね」と受け止める。「おりません」「知りません」とは絶対に言わない。
- スタイリストの詳細（経歴・性格など）を聞かれた場合 → 「担当に確認いたしますね」と対応。知らない情報を作り出さない。

### カルテ未連携時の対応
お客様のカルテ情報がない場合（新規のお客様・LINE未連携のお客様）：
- 「情報がありません」「確認できません」とは言わない
- 代わりに自然に質問してヒアリングする：
  「ぜひ教えていただけますか？前回はどんな施術をされましたか？」
  「以前はどちらのサロンに通われていましたか？」
  「最後にカットされたのはいつ頃ですか？」
- お客様自身が情報源であるという姿勢で接する

### 会話テクニック（必ず実践すること）

1. ミラーリング：
   相手の言葉をそのまま繰り返して受け止める。
   「重たくて…」→「重さが気になっていらっしゃるんですね」
   「パサつきが…」→「パサつきが気になるのですね」

2. 2択式の質問：
   漠然とした質問ではなく選択肢を提示して答えやすくする。
   「重めと軽め、どちらがお好みですか？」
   「長さは変えたいですか、それとも整える程度がよろしいですか？」

3. 過去の体験を聞く：
   「以前の施術で気になった点はございますか？」
   「今までで嫌だったスタイルはありますか？」

4. ライフスタイルの確認：
   「普段のセットにどのくらいお時間をかけていますか？」
   「アイロンなどは使われますか？」

5. 共感→安心の流れ：
   悩みを聞いたら必ず共感してから、
   スタイリストの名前を出して安心感を与える。
   「〜ですよね。梶原が髪の状態を見ながらご提案いたしますのでご安心ください」

### 会話の流れ（2往復ルール）

最低2回はお客様と会話してから引き継ぐこと。
1回目で即引き継ぎは絶対にしない。

たとえメニュー・日時・指名が全て揃っていても、
必ず髪の状態について1つ質問してから引き継ぐ。

■ 1往復目：受け止め + 髪の状態を1つだけ質問
  お客様の要望をミラーリングで受け止め、
  髪の状態・悩み・過去の体験のどれか1つを聞く。
  情報が揃っていても、ここでは引き継がない。

■ 2往復目：共感 + 安心 → 引き継ぎ
  回答に共感し、スタイリスト名で安心感を添えて引き継ぐ。
  「どちらかというと〜の方が気になりますか？」のような
  2択で深掘りしてから安心感を添えるのが理想。

### 会話パターン例

■ 予約（情報揃ってる場合）— 情報が揃っていても髪の状態を聞く
客「梶原さんで明日14時、縮毛矯正お願いします」
AI「梶原への指名、ありがとうございます。縮毛矯正ですね✨ 最近の髪の状態はいかがですか？パサつきやダメージなど気になる点があればお聞かせください。」

客「傷んでる感じがするので、トリートメントもお願いします」
AI「髪が傷んでいる感じがするんですね。どちらかというと毛先の方が気になりますか？梶原が髪の状態をしっかり見させていただいて、最適な施術をご提案いたしますのでご安心ください😊 それでは梶原に引き継ぎますね。」

■ 難しいメニューの組み合わせ — すぐ引き継がず髪の状態を聞く
客「カラーと縮毛矯正を同時にやりたいんですが」
AI「カラーと縮毛矯正の同時施術をご希望なんですね。組み合わせによっては髪への負担も変わってきますので、今の髪の状態を少しお聞かせいただけますか？最後にカラーされたのはいつ頃ですか？」

客「3ヶ月前にカラーして、毛先がパサパサです」
AI「3ヶ月前のカラーから毛先のパサつきが出ているんですね。髪の状態を見てスタイリストから最適な順序をご提案させていただきます。担当のご希望はございますか？」

■ 相談から入る場合
客「相談なんですが」
AI「もちろんでございます。どのようなご相談でしょうか？髪のお悩みなど、お気軽にお聞かせください✨」

客「パサつきがひどくてトリートメントか縮毛矯正か迷ってます」
AI「パサつきが気になっていらっしゃるのですね。普段のセットにどのくらいお時間をかけていますか？それによってもおすすめが変わってまいります。」

客「ほぼ何もしてないです」
AI「乾かすだけで収まるスタイルが理想ですね。髪の状態を見てスタイリストから最適なご提案をさせていただきます。担当のご希望はございますか？」

■ 情報が少ない場合
客「予約したいです」
AI「お問い合わせありがとうございます✨ ご希望のメニューやお日にちはお決まりですか？」

客「カットで今週末がいいです」
AI「カットで今週末ですね、承知いたしました。担当スタイリストのご希望はございますか？また、長さやスタイルで気になる点があればお聞かせくださいませ。」

客「指名なしで、毛先が広がるのが気になります」
AI「毛先の広がりが気になっていらっしゃるのですね。カットの際に広がりを抑えるご提案もできますのでご安心ください。それではスタイリストに引き継ぎますね😊」

■ カルテ未連携の場合 — 冷たくならないよう自然にヒアリング
客「予約お願いします」
AI「お問い合わせありがとうございます✨ ぜひご予約を承ります。ご希望のメニューやお日にちはお決まりですか？」

客「カラーをお願いしたいです」
AI「カラーですね、承知いたしました。ぜひ教えていただきたいのですが、前回カラーをされたのはいつ頃ですか？今の髪の状態によってご提案が変わってまいります。」

### やってはいけないこと
- 料金の具体的な金額を言う
- 施術時間の確約をする
- 「できます」「大丈夫です」と技術的な保証をする
- 1回の返信で4文以上書く
- 「〜という情報を持っておりません」「確認できません」と言う
- 知らないスタッフ名に対して「おりません」と言う
- 最初の1回で引き継ぎを判断する（情報が揃っていても）

### 引き継ぎのルール
- user発言数が2未満 → 絶対に[HANDOFF]を出さない
- user発言数が2以上、かつ髪の状態について1つ以上聞いた → 引き継ぎ可
- 例外（即引き継ぎOK）：
  「スタッフと話したい」「人と話したい」「繋いで」
  クレーム・苦情・緊急の場合
`;

// Supabaseカルテ情報をプロンプト用テキストに変換
function buildKarteContext(profile) {
  if (!profile) return '';

  const { customer, visits, purchases } = profile;
  let context = '\n\n### このお客様のカルテ情報\n';
  context += `氏名: ${customer.customer_name || customer.name}\n`;

  if (visits.length > 0) {
    const lastVisit = visits[0];
    const daysSince = Math.floor(
      (Date.now() - new Date(lastVisit.visited_at)) / (1000 * 60 * 60 * 24)
    );
    context += `前回来店: ${lastVisit.visited_at}（${daysSince}日前）\n`;
    context += `前回メニュー: ${lastVisit.menu}\n`;
    context += `前回担当: ${lastVisit.staff_name}\n`;
    context += `来店回数: ${visits.length}回（直近データ）\n`;

    context += '\n直近の施術履歴:\n';
    visits.forEach((v, i) => {
      context += `  ${i + 1}. ${v.visited_at} - ${v.menu}（担当:${v.staff_name}）\n`;
    });
  } else {
    context += '来店履歴: なし（新規のお客様の可能性）\n';
  }

  if (customer.memo) {
    context += `スタッフメモ: ${customer.memo}\n`;
  }

  context += '\nこの情報を自然に会話に活かすこと。';
  context += '\n「前回の○○から○日経ちましたね」のように自然に触れる。';
  context += '\nデータをそのまま読み上げるのではなく、';
  context += '\n会話の流れの中でさりげなく活用する。';

  return context;
}

// 即時引き継ぎキーワード判定
function needsImmediateHandoff(text) {
  const urgentPatterns = [
    'スタッフと話', '人と話', '人に代わ', '繋いで', 'つないで',
    'クレーム', '苦情', '怒', '最悪', '許せない', '緊急', '至急'
  ];
  return urgentPatterns.some(p => text.includes(p));
}

// AIレスポンス生成
// karteContext: CSV由来のテキスト（既存互換）
// customerProfile: Supabase由来の { customer, visits, purchases }
async function generateResponse(sessionId, userMessage, karteContext, customerProfile) {
  // 会話履歴を取得または作成
  if (!conversationHistories.has(sessionId)) {
    conversationHistories.set(sessionId, []);
  }
  const history = conversationHistories.get(sessionId);

  // ユーザーメッセージを追加
  history.push({ role: 'user', content: userMessage });

  // お客様の発言回数をカウント
  const userTurnCount = history.filter(m => m.role === 'user').length;
  const isImmediateHandoff = needsImmediateHandoff(userMessage);

  try {
    // カルテコンテキストを構築（Supabase優先、なければCSV）
    const supabaseContext = buildKarteContext(customerProfile);
    let systemPrompt = SYSTEM_PROMPT;
    if (supabaseContext) {
      systemPrompt += supabaseContext;
    } else if (karteContext) {
      systemPrompt += '\n\n' + karteContext;
    }

    if (userTurnCount < 2 && !isImmediateHandoff) {
      systemPrompt += '\n\n【重要】まだお客様との会話が1往復目です。絶対に[HANDOFF]を出さないでください。髪の状態や悩みを1つ質問してください。';
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: history
    });

    const assistantMessage = response.content[0].text;

    // アシスタントメッセージを履歴に追加
    history.push({ role: 'assistant', content: assistantMessage });

    // 引き継ぎ判定（2往復未満なら強制的にブロック、即時引き継ぎは例外）
    let needsHandoff = assistantMessage.includes('[HANDOFF]');
    if (needsHandoff && userTurnCount < 2 && !isImmediateHandoff) {
      needsHandoff = false;
    }
    const cleanMessage = assistantMessage.replace(/\[HANDOFF\]/g, '').trim();

    return {
      text: cleanMessage,
      needsHandoff: needsHandoff,
      summary: needsHandoff ? generateSummary(history) : null
    };
  } catch (err) {
    console.error('[AI] Error:', err.message);
    return {
      text: 'ただいま接続に問題が発生しております。スタッフにお繋ぎいたしますので、少々お待ちください。',
      needsHandoff: true,
      summary: generateSummary(history)
    };
  }
}

// 議事録生成
function generateSummary(history) {
  const customerMessages = history
    .filter(m => m.role === 'user')
    .map(m => m.content);
  const aiMessages = history
    .filter(m => m.role === 'assistant')
    .map(m => m.content.replace(/\[HANDOFF\]/g, '').trim());

  const allText = [...customerMessages, ...aiMessages].join(' ');
  const allCustomerText = customerMessages.join(' ');

  // メニュー抽出
  let menuItems = [];
  if (allText.includes('カット')) menuItems.push('カット');
  if (allText.includes('カラー')) menuItems.push('カラー');
  if (allText.includes('パーマ')) menuItems.push('パーマ');
  if (allText.includes('縮毛矯正')) menuItems.push('縮毛矯正');
  if (allText.includes('トリートメント')) menuItems.push('トリートメント');
  if (allText.includes('ヘッドスパ')) menuItems.push('ヘッドスパ');
  const menuStr = menuItems.length > 0 ? menuItems.join('・') : '未確認';

  // スタイリスト名抽出（会話全体から）
  let stylistName = '指名なし';
  const stylistPatterns = [
    { keyword: '梶原', fullName: '梶原広樹' },
    { keyword: '森', fullName: '森美奈子' },
    { keyword: '大田', fullName: '大田夏帆' },
    { keyword: '渡邊', fullName: '渡邊達也' },
    { keyword: '渡辺', fullName: '渡邊達也' },
    { keyword: 'JUN', fullName: 'JUN' },
    { keyword: 'jun', fullName: 'JUN' },
    { keyword: 'ジュン', fullName: 'JUN' },
  ];
  for (const { keyword, fullName } of stylistPatterns) {
    if (allText.includes(keyword)) {
      stylistName = fullName;
      break;
    }
  }

  // 希望日時抽出
  let dateTime = '未確認';
  const dateMatch = allCustomerText.match(/(明日|明後日|来週|今週|今日|\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})/);
  if (dateMatch) dateTime = dateMatch[0];
  const timeMatch = allCustomerText.match(/(\d{1,2}時(半)?|\d{1,2}:\d{2}|午前|午後)/);
  if (timeMatch) dateTime += ' ' + timeMatch[0];

  // 髪の状態（2往復目のお客様の回答から抽出）
  let hairCondition = '';
  if (customerMessages.length >= 2) {
    hairCondition = customerMessages.slice(1).join('、');
  }

  // その他の補足情報
  let notes = [];
  if (allCustomerText.includes('予約') || allCustomerText.includes('よやく')) notes.push('予約希望');
  if (allCustomerText.includes('相談')) notes.push('施術相談あり');
  if (allCustomerText.includes('初めて') || allCustomerText.includes('はじめて')) notes.push('新規のお客様');
  const notesStr = notes.length > 0 ? notes.join('、') : '';

  let summary = '📋引き継ぎ議事録\n';
  summary += '━━━━━━━━━━\n';
  summary += '👤 お客様\n';
  summary += `💇 指名：${stylistName}\n`;
  summary += `📅 希望：${dateTime}\n`;
  summary += `✂️ メニュー：${menuStr}\n`;
  if (hairCondition) summary += `💬 髪の状態：${hairCondition}\n`;
  if (notesStr) summary += `📝 その他：${notesStr}\n`;
  summary += '━━━━━━━━━━\n';
  summary += '担当スタッフはこのスレッドで直接返信してください。';

  return summary;
}

// 会話履歴クリア
function clearHistory(sessionId) {
  conversationHistories.delete(sessionId);
}

// ウェルカムメッセージ（顧客名があればパーソナライズ）
function getWelcomeMessage(customerName) {
  if (customerName) {
    return `${customerName}様、いつもありがとうございます。${SALON_INFO.name}です。\nご予約やご相談を承ります。どのようなご用件でしょうか？`;
  }
  return `ご連絡ありがとうございます。${SALON_INFO.name}です。\nご予約やご相談を承ります。どのようなご用件でしょうか？`;
}

module.exports = {
  generateResponse,
  buildKarteContext,
  clearHistory,
  getWelcomeMessage,
  SALON_INFO
};
