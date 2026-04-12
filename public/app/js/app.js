// ============================================
// js/app.js
// mycon SPA メインアプリケーション
// ============================================

import {
  getToken, getUser, login, logout,
  getChats, getChatMessages, sendChatReply,
  getCustomers, getCustomerDetail,
  getDashboard, getDashboardStaff, getDashboardAlerts,
} from './api.js';

// ─── State ───
let currentPage = '';
let chatState = { chats: [], activeChat: null, messages: [], customer: null, visits: [], filter: 'all' };
let customerState = { customers: [], total: 0, search: '', segment: 'all', sort: 'created_at', order: 'desc' };

// ─── DOM ───
const $login = document.getElementById('login-page');
const $app = document.getElementById('app-shell');
const $content = document.getElementById('page-content');
const $title = document.getElementById('page-title');

// ============================================
// Router
// ============================================
function navigate(hash) {
  window.location.hash = hash;
}

function getRoute() {
  const hash = window.location.hash || '#/chat';
  return hash.replace('#/', '') || 'chat';
}

function handleRoute() {
  const token = getToken();
  const route = getRoute();

  if (!token && route !== 'login') {
    navigate('#/login');
    return;
  }

  if (token && route === 'login') {
    navigate('#/chat');
    return;
  }

  if (route === 'login') {
    showLogin();
    return;
  }

  showApp();
  renderPage(route);
}

window.addEventListener('hashchange', handleRoute);

// ============================================
// Login Page
// ============================================
function showLogin() {
  $login.style.display = '';
  $app.classList.remove('active');
  currentPage = 'login';

  const form = document.getElementById('login-form');

  // Clone to remove old listeners
  const newForm = form.cloneNode(true);
  form.parentNode.replaceChild(newForm, form);

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = newForm.querySelector('#login-email').value;
    const password = newForm.querySelector('#login-password').value;
    const btn = newForm.querySelector('.btn-primary');
    const err = document.getElementById('login-error');

    btn.disabled = true;
    btn.textContent = 'ログイン中...';
    err.classList.remove('show');

    try {
      await login(email, password);
      navigate('#/chat');
    } catch (ex) {
      err.textContent = ex.message || 'ログインに失敗しました';
      err.classList.add('show');
    } finally {
      btn.disabled = false;
      btn.textContent = 'ログイン';
    }
  });
}

// ============================================
// App Shell
// ============================================
function showApp() {
  $login.style.display = 'none';
  $app.classList.add('active');

  const user = getUser();
  const nameEl = document.querySelector('.user-name');
  if (nameEl && user) {
    nameEl.textContent = user.email || 'User';
  }
}

// Nav items
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    if (page) {
      navigate('#/' + page);
      closeMobileSidebar();
    }
  });
});

// Logout
document.querySelector('.logout-btn')?.addEventListener('click', async () => {
  await logout();
  navigate('#/login');
});

// Mobile sidebar
const sidebar = document.querySelector('.sidebar');
const sidebarOverlay = document.querySelector('.sidebar-overlay');

document.querySelector('.mobile-menu-btn')?.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

sidebarOverlay?.addEventListener('click', closeMobileSidebar);

function closeMobileSidebar() {
  sidebar.classList.remove('open');
}

// ============================================
// Page Router
// ============================================
const PAGE_TITLES = {
  chat: 'チャット',
  customers: '顧客一覧',
  dashboard: 'ダッシュボード',
  settings: '設定',
};

function renderPage(route) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === route);
  });

  currentPage = route;
  $title.textContent = PAGE_TITLES[route] || 'チャット';

  switch (route) {
    case 'chat': renderChatPage(); break;
    case 'customers': renderCustomersPage(); break;
    case 'dashboard': renderDashboardPage(); break;
    case 'settings': renderSettingsPage(); break;
    default: renderChatPage();
  }
}

// ============================================
// Helper: 顧客名を取得
// ============================================
function customerName(c) {
  if (!c) return '';
  return c.customer_name || c.name || '';
}

// ============================================
// Chat Page
// ============================================
async function renderChatPage() {
  $content.innerHTML = `
    <div class="chat-layout" id="chat-layout">
      <div class="chat-list-panel">
        <div class="chat-list-header">
          <input type="text" class="chat-search" placeholder="名前で検索..." id="chat-search">
        </div>
        <div class="chat-list-filters">
          <button class="chat-filter-btn active" data-filter="all">すべて</button>
          <button class="chat-filter-btn" data-filter="ai_active">AI対応中</button>
          <button class="chat-filter-btn" data-filter="handoff">引き継ぎ済</button>
          <button class="chat-filter-btn" data-filter="completed">完了</button>
        </div>
        <div class="chat-list-items" id="chat-list-items">
          <div class="loading"><span class="spinner"></span>読み込み中...</div>
        </div>
      </div>
      <div class="chat-messages-panel">
        <div class="chat-messages-header">
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn-icon chat-back-btn" id="chat-back-btn" style="display:none;">&#8592;</button>
            <h3 id="chat-partner-name">チャットを選択してください</h3>
          </div>
          <button class="btn btn-outline btn-sm" id="karte-toggle-btn">カルテ</button>
        </div>
        <div class="chat-messages-body" id="chat-messages-body">
          <div class="chat-empty">左のリストからお客様を選択してください</div>
        </div>
        <div class="chat-input-area" id="chat-input-area" style="display:none;">
          <div class="chat-input-row">
            <input type="text" class="chat-input" id="chat-input" placeholder="返信を入力...">
            <button class="chat-send-btn" id="chat-send-btn">&#9654;</button>
          </div>
        </div>
      </div>
      <div class="karte-panel" id="karte-panel">
        <div class="karte-header">
          <span>カルテ</span>
          <button class="modal-close" id="karte-close-btn">&times;</button>
        </div>
        <div id="karte-body">
          <div class="empty-state" style="padding:30px;">
            <div class="empty-state-text">お客様を選択してください</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Event: filters
  $content.querySelectorAll('.chat-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $content.querySelectorAll('.chat-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chatState.filter = btn.dataset.filter;
      renderChatList();
    });
  });

  // Event: search
  document.getElementById('chat-search')?.addEventListener('input', (e) => {
    renderChatList(e.target.value);
  });

  // Event: karte toggle
  document.getElementById('karte-toggle-btn')?.addEventListener('click', () => {
    document.getElementById('karte-panel')?.classList.toggle('open');
  });
  document.getElementById('karte-close-btn')?.addEventListener('click', () => {
    document.getElementById('karte-panel')?.classList.remove('open');
  });

  // Event: back button (mobile)
  document.getElementById('chat-back-btn')?.addEventListener('click', () => {
    document.getElementById('chat-layout')?.classList.remove('has-active-chat');
    chatState.activeChat = null;
  });

  // Event: send
  document.getElementById('chat-send-btn')?.addEventListener('click', sendReply);
  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  });

  // Load chats
  try {
    const data = await getChats();
    chatState.chats = data.chats || [];
    renderChatList();
  } catch (err) {
    document.getElementById('chat-list-items').innerHTML =
      `<div class="empty-state"><div class="empty-state-text">チャットの読み込みに失敗しました</div></div>`;
  }
}

function renderChatList(searchQuery = '') {
  const container = document.getElementById('chat-list-items');
  if (!container) return;

  let chats = chatState.chats;

  if (chatState.filter !== 'all') {
    chats = chats.filter(c => c.status === chatState.filter);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    chats = chats.filter(c =>
      (c.customerName || '').toLowerCase().includes(q) ||
      (c.lastMessage || '').toLowerCase().includes(q)
    );
  }

  if (chats.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-text">お問い合わせはありません</div></div>`;
    return;
  }

  container.innerHTML = chats.map(chat => {
    const name = chat.customerName || 'ゲスト';
    const initial = name.charAt(0);
    const time = formatTime(chat.lastAt);
    const isActive = chatState.activeChat === chat.lineUserId;

    return `
      <div class="chat-item ${isActive ? 'active' : ''}" data-line-user-id="${chat.lineUserId}">
        <div class="chat-item-avatar">${initial}</div>
        <div class="chat-item-body">
          <div class="chat-item-name">
            ${escapeHtml(name)}
            <span class="status-badge ${chat.status}">${statusLabel(chat.status)}</span>
          </div>
          <div class="chat-item-preview">${escapeHtml(chat.lastMessage || '')}</div>
        </div>
        <div class="chat-item-meta">
          <div class="chat-item-time">${time}</div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.chat-item').forEach(item => {
    item.addEventListener('click', () => {
      openChat(item.dataset.lineUserId);
    });
  });
}

async function openChat(lineUserId) {
  chatState.activeChat = lineUserId;
  document.getElementById('chat-layout')?.classList.add('has-active-chat');

  document.querySelectorAll('.chat-item').forEach(item => {
    item.classList.toggle('active', item.dataset.lineUserId === lineUserId);
  });

  const messagesBody = document.getElementById('chat-messages-body');
  messagesBody.innerHTML = `<div class="loading"><span class="spinner"></span>読み込み中...</div>`;
  document.getElementById('chat-input-area').style.display = 'none';

  try {
    const data = await getChatMessages(lineUserId);
    chatState.messages = data.messages || [];
    chatState.customer = data.customer;
    chatState.visits = data.visits || [];

    const name = customerName(data.customer) || 'ゲスト';
    document.getElementById('chat-partner-name').textContent = name;
    document.getElementById('chat-input-area').style.display = '';

    renderMessages();
    renderKarte();
  } catch (err) {
    messagesBody.innerHTML = `<div class="empty-state"><div class="empty-state-text">メッセージの読み込みに失敗しました</div></div>`;
  }
}

function renderMessages() {
  const body = document.getElementById('chat-messages-body');
  if (!body) return;

  if (chatState.messages.length === 0) {
    body.innerHTML = `<div class="chat-empty">メッセージはありません</div>`;
    return;
  }

  body.innerHTML = chatState.messages.map(msg => {
    // sender_type カラムがあればそれで判定、なければ既存ロジックでフォールバック
    const senderType = msg.sender_type
      || (msg.customer_message === '（スタッフ返信）' ? 'staff'
        : msg.customer_message === '（引き継ぎ議事録）' ? 'system'
        : null);

    // --- システムメッセージ（引き継ぎ議事録等） ---
    if (senderType === 'system' || msg.customer_message === '（引き継ぎ議事録）') {
      return `
        <div class="msg-row system">
          <div>
            <div class="msg-bubble">${escapeHtml(msg.message || msg.ai_response)}</div>
            <div class="msg-time">${formatTime(msg.created_at)}</div>
          </div>
        </div>
      `;
    }

    let html = '';

    // --- お客様メッセージ ---
    if (senderType === 'customer') {
      // 新形式: sender_type='customer', message カラムにテキスト
      html += `
        <div class="msg-row customer">
          <div>
            <div class="msg-sender">お客様</div>
            <div class="msg-bubble">${escapeHtml(msg.message || msg.customer_message)}</div>
            <div class="msg-time">${formatTime(msg.created_at)}</div>
          </div>
        </div>
      `;
      return html;
    }

    // --- スタッフ返信 ---
    if (senderType === 'staff') {
      html += `
        <div class="msg-row staff">
          <div>
            <div class="msg-sender">スタッフ</div>
            <div class="msg-bubble">${escapeHtml(msg.message || msg.ai_response)}</div>
            <div class="msg-time">${formatTime(msg.created_at)}</div>
          </div>
        </div>
      `;
      return html;
    }

    // --- 既存データ互換（sender_type なし）: お客様 + AI のペア ---
    if (msg.customer_message && msg.customer_message !== '（スタッフ返信）') {
      html += `
        <div class="msg-row customer">
          <div>
            <div class="msg-sender">お客様</div>
            <div class="msg-bubble">${escapeHtml(msg.customer_message)}</div>
            <div class="msg-time">${formatTime(msg.created_at)}</div>
          </div>
        </div>
      `;
    }

    if (msg.ai_response && msg.ai_response !== '（引き継ぎ済み・オーナー対応中）') {
      html += `
        <div class="msg-row ai">
          <div>
            <div class="msg-sender">AI</div>
            <div class="msg-bubble">${escapeHtml(msg.ai_response)}</div>
          </div>
        </div>
      `;
    }

    return html;
  }).join('');

  body.scrollTop = body.scrollHeight;
}

function renderKarte() {
  const body = document.getElementById('karte-body');
  if (!body) return;

  const c = chatState.customer;
  if (!c) {
    body.innerHTML = `<div class="empty-state" style="padding:30px;"><div class="empty-state-text">顧客データなし</div></div>`;
    return;
  }

  const visits = chatState.visits || [];
  const lastVisit = visits[0];
  const daysSince = lastVisit
    ? Math.floor((Date.now() - new Date(lastVisit.visited_at)) / (1000*60*60*24))
    : null;

  body.innerHTML = `
    <div class="karte-section">
      <div class="karte-section-title">顧客情報</div>
      <div class="karte-field"><span class="karte-field-label">氏名</span><span class="karte-field-value">${escapeHtml(customerName(c) || '-')}</span></div>
      <div class="karte-field"><span class="karte-field-label">よみがな</span><span class="karte-field-value">${escapeHtml(c.yomigana || '-')}</span></div>
      <div class="karte-field"><span class="karte-field-label">電話番号</span><span class="karte-field-value">${escapeHtml(c.phone || '-')}</span></div>
      <div class="karte-field"><span class="karte-field-label">性別</span><span class="karte-field-value">${escapeHtml(c.gender || '-')}</span></div>
      <div class="karte-field"><span class="karte-field-label">セグメント</span><span class="karte-field-value"><span class="segment-tag ${c.segment || ''}">${segmentLabel(c.segment)}</span></span></div>
      <div class="karte-field"><span class="karte-field-label">来店回数</span><span class="karte-field-value">${visits.length}回</span></div>
      ${daysSince !== null ? `<div class="karte-field"><span class="karte-field-label">最終来店</span><span class="karte-field-value">${daysSince}日前</span></div>` : ''}
      ${c.memo ? `<div class="karte-field"><span class="karte-field-label">メモ</span><span class="karte-field-value">${escapeHtml(c.memo)}</span></div>` : ''}
    </div>
    <div class="karte-section">
      <div class="karte-section-title">来店履歴</div>
      ${visits.length === 0 ? '<div style="font-size:13px;color:var(--text-muted);">来店履歴なし</div>' :
        visits.slice(0, 8).map(v => `
          <div class="karte-visit-item">
            <div class="karte-visit-date">${v.visited_at?.split('T')[0] || '-'}</div>
            <div class="karte-visit-menu">${escapeHtml(v.menu || '-')}</div>
            <div class="karte-visit-staff">担当: ${escapeHtml(v.staff_name || '-')}</div>
          </div>
        `).join('')
      }
    </div>
  `;
}

async function sendReply() {
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send-btn');
  if (!input || !chatState.activeChat) return;

  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  btn.disabled = true;

  try {
    const chat = chatState.chats.find(c => c.lineUserId === chatState.activeChat);
    await sendChatReply(chatState.activeChat, message, chat?.tenantId || 'premier-models');

    chatState.messages.push({
      sender_type: 'staff',
      message: message,
      customer_message: '（スタッフ返信）',
      ai_response: message,
      created_at: new Date().toISOString(),
    });
    renderMessages();
  } catch (err) {
    alert('送信失敗: ' + err.message);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ============================================
// Customers Page
// ============================================
async function renderCustomersPage() {
  $content.innerHTML = `
    <div class="customers-page">
      <div class="customers-toolbar">
        <input type="text" class="customers-search" placeholder="名前・電話番号で検索..." id="customer-search">
        <div class="segment-pills" id="segment-pills">
          <button class="segment-pill active" data-segment="all">すべて</button>
          <button class="segment-pill" data-segment="vip">VIP</button>
          <button class="segment-pill" data-segment="regular">固定</button>
          <button class="segment-pill" data-segment="churn_risk">離反リスク</button>
          <button class="segment-pill" data-segment="retail_prospect">店販見込</button>
          <button class="segment-pill" data-segment="new">新規</button>
        </div>
      </div>
      <div class="customer-table-wrap">
        <table class="customer-table">
          <thead>
            <tr>
              <th data-sort="customer_name">名前</th>
              <th data-sort="phone">電話番号</th>
              <th data-sort="segment">セグメント</th>
              <th data-sort="last_visit_at">最終来店</th>
              <th data-sort="visit_count">来店回数</th>
            </tr>
          </thead>
          <tbody id="customer-tbody">
            <tr><td colspan="5"><div class="loading"><span class="spinner"></span>読み込み中...</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="modal-overlay hidden" id="customer-modal"></div>
  `;

  // Events: search
  let searchTimeout;
  document.getElementById('customer-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      customerState.search = e.target.value;
      loadCustomers();
    }, 300);
  });

  // Events: segment filter
  document.querySelectorAll('.segment-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.segment-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      customerState.segment = pill.dataset.segment;
      loadCustomers();
    });
  });

  // Events: sort
  document.querySelectorAll('.customer-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (customerState.sort === field) {
        customerState.order = customerState.order === 'desc' ? 'asc' : 'desc';
      } else {
        customerState.sort = field;
        customerState.order = 'desc';
      }
      loadCustomers();
    });
  });

  await loadCustomers();
}

async function loadCustomers() {
  const tbody = document.getElementById('customer-tbody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="5"><div class="loading"><span class="spinner"></span>読み込み中...</div></td></tr>`;

  try {
    const params = {};
    if (customerState.search) params.search = customerState.search;
    if (customerState.segment !== 'all') params.segment = customerState.segment;
    params.sort = customerState.sort;
    params.order = customerState.order;

    const data = await getCustomers(params);
    customerState.customers = data.customers || [];
    customerState.total = data.total || 0;

    if (customerState.customers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-state-text">該当する顧客はありません</div></div></td></tr>`;
      return;
    }

    tbody.innerHTML = customerState.customers.map(c => {
      const name = customerName(c) || '-';
      const initial = name.charAt(0);
      const lastVisit = c.last_visit_at ? c.last_visit_at.split('T')[0] : '-';
      return `
        <tr data-customer-id="${c.id}">
          <td>
            <div class="customer-name-cell">
              <div class="customer-avatar-sm">${initial}</div>
              <span>${escapeHtml(name)}</span>
            </div>
          </td>
          <td>${escapeHtml(c.phone || '-')}</td>
          <td><span class="segment-tag ${c.segment || ''}">${segmentLabel(c.segment)}</span></td>
          <td>${lastVisit}</td>
          <td>${c.visit_count || 0}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-customer-id]').forEach(row => {
      row.addEventListener('click', () => openCustomerDetail(row.dataset.customerId));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-state-text">顧客の読み込みに失敗しました</div></div></td></tr>`;
  }
}

async function openCustomerDetail(customerId) {
  const modal = document.getElementById('customer-modal');
  if (!modal) return;

  modal.classList.remove('hidden');
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>顧客詳細</h3>
        <button class="modal-close" id="modal-close-btn">&times;</button>
      </div>
      <div class="modal-body">
        <div class="loading"><span class="spinner"></span>読み込み中...</div>
      </div>
    </div>
  `;

  modal.querySelector('#modal-close-btn')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  try {
    const data = await getCustomerDetail(customerId);
    const c = data.customer;
    const visits = data.visits || [];

    modal.querySelector('.modal-body').innerHTML = `
      <div style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <div class="chat-item-avatar" style="width:48px;height:48px;font-size:20px;">${(customerName(c) || '?').charAt(0)}</div>
          <div>
            <div style="font-size:18px;font-weight:600;">${escapeHtml(customerName(c) || '-')}</div>
            <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(c.phone || '-')} ${c.yomigana ? '(' + escapeHtml(c.yomigana) + ')' : ''}</div>
          </div>
          <span class="segment-tag ${c.segment || ''}" style="margin-left:auto;">${segmentLabel(c.segment)}</span>
        </div>
        ${c.memo ? `<div style="padding:12px;background:var(--bg);border-radius:var(--radius-sm);font-size:13px;margin-bottom:16px;">${escapeHtml(c.memo)}</div>` : ''}
      </div>
      <div class="karte-section-title">来店履歴 (${visits.length}件)</div>
      ${visits.length === 0 ? '<p style="color:var(--text-muted);font-size:13px;">来店記録なし</p>' :
        `<table class="staff-table">
          <thead><tr><th>日付</th><th>メニュー</th><th>担当</th><th>金額</th></tr></thead>
          <tbody>
            ${visits.map(v => `
              <tr>
                <td>${v.visited_at?.split('T')[0] || '-'}</td>
                <td>${escapeHtml(v.menu || '-')}</td>
                <td>${escapeHtml(v.staff_name || '-')}</td>
                <td>${v.total_amount ? '¥' + v.total_amount.toLocaleString() : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`
      }
    `;
  } catch (err) {
    modal.querySelector('.modal-body').innerHTML = `<div class="empty-state"><div class="empty-state-text">顧客情報の読み込みに失敗しました</div></div>`;
  }
}

// ============================================
// Dashboard Page
// ============================================
async function renderDashboardPage() {
  $content.innerHTML = `
    <div class="dashboard-page">
      <div class="kpi-grid" id="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">本日来店</div><div class="kpi-value">-</div></div>
        <div class="kpi-card"><div class="kpi-label">本日売上</div><div class="kpi-value">-</div></div>
        <div class="kpi-card"><div class="kpi-label">月間売上</div><div class="kpi-value">-</div></div>
        <div class="kpi-card"><div class="kpi-label">顧客数</div><div class="kpi-value">-</div></div>
      </div>
      <div class="segment-bar-wrap" id="segment-bar-wrap">
        <div class="segment-bar-title">セグメント分布</div>
        <div class="segment-bar" id="segment-bar"></div>
        <div class="segment-legend" id="segment-legend"></div>
      </div>
      <div class="dashboard-grid">
        <div class="dashboard-panel">
          <div class="dashboard-panel-title">スタッフ実績（今月）</div>
          <div id="staff-table-wrap"><div class="loading"><span class="spinner"></span></div></div>
        </div>
        <div class="dashboard-panel">
          <div class="dashboard-panel-title">離反リスクアラート</div>
          <div id="alerts-wrap"><div class="loading"><span class="spinner"></span></div></div>
        </div>
      </div>
    </div>
  `;

  const [kpiRes, staffRes, alertsRes] = await Promise.allSettled([
    getDashboard(),
    getDashboardStaff(),
    getDashboardAlerts(),
  ]);

  // KPI
  if (kpiRes.status === 'fulfilled') {
    const kpi = kpiRes.value;
    const grid = document.getElementById('kpi-grid');
    if (grid) {
      grid.innerHTML = `
        <div class="kpi-card"><div class="kpi-label">本日来店</div><div class="kpi-value">${kpi.todayVisits}<span class="kpi-unit"> 人</span></div></div>
        <div class="kpi-card"><div class="kpi-label">本日売上</div><div class="kpi-value">&yen;${(kpi.todaySales || 0).toLocaleString()}</div></div>
        <div class="kpi-card"><div class="kpi-label">月間売上</div><div class="kpi-value">&yen;${(kpi.monthSales || 0).toLocaleString()}</div></div>
        <div class="kpi-card"><div class="kpi-label">顧客数</div><div class="kpi-value">${kpi.totalCustomers}<span class="kpi-unit"> 人</span></div></div>
      `;
    }
    renderSegmentBar(kpi.segments || {});
  }

  // Staff
  if (staffRes.status === 'fulfilled') {
    const staff = staffRes.value.staff || [];
    const wrap = document.getElementById('staff-table-wrap');
    if (wrap) {
      if (staff.length === 0) {
        wrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">今月のデータはありません</div>';
      } else {
        wrap.innerHTML = `
          <table class="staff-table">
            <thead><tr><th>スタッフ</th><th>来店数</th><th>売上</th></tr></thead>
            <tbody>
              ${staff.map(s => `
                <tr>
                  <td style="font-weight:500;">${escapeHtml(s.name)}</td>
                  <td>${s.visitCount}人</td>
                  <td>&yen;${s.sales.toLocaleString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    }
  }

  // Alerts
  if (alertsRes.status === 'fulfilled') {
    const alerts = alertsRes.value.alerts || [];
    const wrap = document.getElementById('alerts-wrap');
    if (wrap) {
      if (alerts.length === 0) {
        wrap.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">離反リスクのある顧客はいません</div>';
      } else {
        wrap.innerHTML = `
          <ul class="alert-list">
            ${alerts.map(a => {
              const name = a.customer_name || a.name || '-';
              const days = a.last_visit_at
                ? Math.floor((Date.now() - new Date(a.last_visit_at)) / (1000*60*60*24))
                : '?';
              return `
                <li class="alert-item">
                  <span class="alert-dot"></span>
                  <span class="alert-item-name">${escapeHtml(name)}</span>
                  <span class="alert-item-detail">最終来店から${days}日</span>
                </li>
              `;
            }).join('')}
          </ul>
        `;
      }
    }
  }
}

const SEGMENT_COLORS = {
  vip: '#e8a840',
  regular: '#4caf7d',
  churn_risk: '#d94f4f',
  retail_prospect: '#5b9bd5',
  new: '#9c27b0',
  unknown: '#ccc',
};

function renderSegmentBar(segments) {
  const bar = document.getElementById('segment-bar');
  const legend = document.getElementById('segment-legend');
  if (!bar || !legend) return;

  const total = Object.values(segments).reduce((s, v) => s + v, 0);
  if (total === 0) {
    bar.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-muted);">データなし</div>';
    return;
  }

  bar.innerHTML = Object.entries(segments).map(([seg, count]) => {
    const pct = ((count / total) * 100).toFixed(1);
    const color = SEGMENT_COLORS[seg] || SEGMENT_COLORS.unknown;
    return `<div class="segment-bar-item" style="flex:${count};background:${color};">${pct > 8 ? Math.round(pct) + '%' : ''}</div>`;
  }).join('');

  legend.innerHTML = Object.entries(segments).map(([seg, count]) => {
    const color = SEGMENT_COLORS[seg] || SEGMENT_COLORS.unknown;
    return `<div class="segment-legend-item"><span class="segment-legend-dot" style="background:${color}"></span>${segmentLabel(seg)} (${count})</div>`;
  }).join('');
}

// ============================================
// Settings Page
// ============================================
function renderSettingsPage() {
  $content.innerHTML = `
    <div class="settings-page">
      <div class="settings-section">
        <div class="settings-section-header">サロン情報</div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-label">サロン名</div>
            <div class="settings-value"><input class="settings-input" value="PREMIER MODELS" disabled></div>
          </div>
          <div class="settings-row">
            <div class="settings-label">営業時間</div>
            <div class="settings-value"><input class="settings-input" value="10:00 - 20:00" disabled></div>
          </div>
          <div class="settings-row">
            <div class="settings-label">定休日</div>
            <div class="settings-value"><input class="settings-input" value="火曜日" disabled></div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-header">LINE 接続状態</div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-label">ステータス</div>
            <div class="settings-value">
              <div class="connection-status">
                <span class="connection-dot connected"></span>
                接続済み
              </div>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-label">Channel ID</div>
            <div class="settings-value"><input class="settings-input" value="****" disabled></div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-header">AI 設定</div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-label">トーン</div>
            <div class="settings-value">
              <select class="settings-select" disabled>
                <option selected>丁寧・コンシェルジュ</option>
                <option>カジュアル・フレンドリー</option>
                <option>フォーマル・ビジネス</option>
              </select>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-label">引き継ぎまでの往復数</div>
            <div class="settings-value">
              <select class="settings-select" disabled>
                <option>1往復</option>
                <option selected>2往復</option>
                <option>3往復</option>
              </select>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-label">あいさつメッセージ</div>
            <div class="settings-value">
              <textarea class="settings-textarea" disabled>PREMIER MODELSへのお問い合わせありがとうございます。サロンコンシェルジュが担当させていただきます。</textarea>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-header">通知設定</div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-label">通知方法</div>
            <div class="settings-value">
              <select class="settings-select" disabled>
                <option selected>Slack</option>
                <option>メール</option>
                <option>LINE（オーナー）</option>
                <option>プッシュ通知</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-header">カルテデータ</div>
        <div class="settings-section-body">
          <div class="settings-row">
            <div class="settings-label">データソース</div>
            <div class="settings-value">
              <div class="connection-status">
                <span class="connection-dot connected"></span>
                Supabase（接続済み）
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-header">プラン情報</div>
        <div class="settings-section-body">
          <div class="plan-card">
            <div>
              <div class="plan-name">Professional</div>
              <div class="plan-detail">AIコンシェルジュ + LINE連携</div>
            </div>
            <button class="btn btn-outline btn-sm" disabled>管理</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// Utility Functions
// ============================================
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '今';
  if (diffMin < 60) return diffMin + '分前';
  if (diffHour < 24) return diffHour + '時間前';
  if (diffDay < 7) return diffDay + '日前';
  return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}

function statusLabel(status) {
  switch (status) {
    case 'pending': return '未対応';
    case 'ai_active': return 'AI対応中';
    case 'handoff': return '引き継ぎ済';
    case 'completed': return '完了';
    default: return status || '-';
  }
}

function segmentLabel(segment) {
  switch (segment) {
    case 'vip': return 'VIP';
    case 'regular': return '固定';
    case 'churn_risk': return '離反リスク';
    case 'retail_prospect': return '店販見込';
    case 'new': return '新規';
    default: return segment || '-';
  }
}

// ============================================
// Init
// ============================================
handleRoute();
