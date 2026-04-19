// ============================================
// js/api.js
// mycon API クライアント
// ============================================

const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('mycon_token');
}

function setToken(token) {
  localStorage.setItem('mycon_token', token);
}

function clearToken() {
  localStorage.removeItem('mycon_token');
  localStorage.removeItem('mycon_user');
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('mycon_user'));
  } catch {
    return null;
  }
}

function setUser(user) {
  localStorage.setItem('mycon_user', JSON.stringify(user));
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    clearToken();
    window.location.hash = '#/login';
    throw new Error('Unauthorized');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API Error');
  return data;
}

// --- Auth ---
async function login(email, password) {
  const data = await apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(data.session.access_token);
  setUser(data.user);
  return data;
}

async function logout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch {}
  clearToken();
}

// --- Chats ---
async function getChats() {
  return apiFetch('/chats');
}

async function getChatMessages(lineUserId) {
  return apiFetch(`/chats/${encodeURIComponent(lineUserId)}`);
}

async function sendChatReply(lineUserId, message, tenantId) {
  return apiFetch(`/chats/${encodeURIComponent(lineUserId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message, tenantId }),
  });
}

async function setChatAiEnabled(lineUserId, enabled, tenantId) {
  return apiFetch(`/chats/${encodeURIComponent(lineUserId)}/ai-enabled`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled, tenantId }),
  });
}

// --- Customers ---
async function getCustomers(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(`/customers${qs ? '?' + qs : ''}`);
}

async function getCustomerDetail(id) {
  return apiFetch(`/customers/${id}`);
}

// --- Dashboard ---
async function getDashboard() {
  return apiFetch('/dashboard');
}

async function getDashboardStaff() {
  return apiFetch('/dashboard/staff');
}

async function getDashboardAlerts() {
  return apiFetch('/dashboard/alerts');
}

async function getDashboardUnanswered() {
  return apiFetch('/dashboard/unanswered');
}

async function getDashboardAiSuggestions() {
  return apiFetch('/dashboard/ai-suggestions');
}

async function getDashboardProactiveSuggestions() {
  return apiFetch('/dashboard/proactive-suggestions');
}

export {
  getToken, setToken, clearToken, getUser, setUser,
  login, logout,
  getChats, getChatMessages, sendChatReply, setChatAiEnabled,
  getCustomers, getCustomerDetail,
  getDashboard, getDashboardStaff, getDashboardAlerts, getDashboardUnanswered,
  getDashboardAiSuggestions,
  getDashboardProactiveSuggestions,
};
