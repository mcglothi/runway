'use strict';

const DESKTOP_URL = 'http://localhost:47821';

// ── State ─────────────────────────────────────────────────────────────────────
let claudeSessionKey = null;

// ── UI helpers ────────────────────────────────────────────────────────────────
function showState(id) {
  document.querySelectorAll('.state').forEach(el => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setDot(state) { // 'loading' | 'online' | 'offline'
  const dot = document.getElementById('status-dot');
  dot.className = state === 'loading' ? '' : state;
}

function setFeedback(msg, isError = false) {
  const el = document.getElementById('feedback');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
}

// ── Check if Desktop is running ───────────────────────────────────────────────
async function checkDesktop() {
  try {
    const res = await fetch(`${DESKTOP_URL}/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.running === true;
  } catch {
    return false;
  }
}

// ── Read Claude session cookie from browser ───────────────────────────────────
async function readClaudeCookie() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'sessionKey' });
    return cookie?.value ?? null;
  } catch {
    return null;
  }
}

// ── Sync session to Desktop ───────────────────────────────────────────────────
async function syncSession() {
  if (!claudeSessionKey) return;

  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  setFeedback('');

  try {
    const res = await fetch(`${DESKTOP_URL}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: claudeSessionKey }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    setFeedback('Synced — quota refreshing');
    btn.textContent = 'Sync Session';
    // Re-enable after a short delay so the user can sync again if needed
    setTimeout(() => { btn.disabled = false; }, 3000);
  } catch (err) {
    setFeedback(err.message, true);
    btn.textContent = 'Sync Session';
    btn.disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setDot('loading');
  showState('state-loading');

  const [isRunning, sessionKey] = await Promise.all([
    checkDesktop(),
    readClaudeCookie(),
  ]);

  claudeSessionKey = sessionKey;

  if (!isRunning) {
    setDot('offline');
    showState('state-offline');
    startPollingForDesktop();
    return;
  }

  setDot('online');

  // Update cookie status display
  const cookieEl = document.getElementById('claude-cookie-status');
  const hintEl = document.getElementById('online-hint');
  const syncBtn = document.getElementById('btn-sync');

  if (sessionKey) {
    cookieEl.textContent = 'session ready';
    cookieEl.className = 'cookie-status found';
    hintEl.textContent = 'Click Sync to push your session to Runway Desktop and refresh quota.';
    syncBtn.disabled = false;
  } else {
    cookieEl.textContent = 'not signed in';
    cookieEl.className = 'cookie-status missing';
    hintEl.textContent = 'Sign in to claude.ai in this browser first, then re-open this popup.';
    syncBtn.disabled = true;
  }

  showState('state-online');
}

// ── Poll for desktop coming online (used while offline state is showing) ──────
let offlinePollTimer = null;

function startPollingForDesktop() {
  if (offlinePollTimer) return;
  offlinePollTimer = setInterval(async () => {
    const running = await checkDesktop();
    if (running) {
      clearInterval(offlinePollTimer);
      offlinePollTimer = null;
      init(); // re-run full init now that desktop is up
    }
  }, 2000);
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.getElementById('btn-launch').addEventListener('click', () => {
  // This only works when the app is packaged and installed (runway:// is registered).
  // In development, start the app from your terminal: cd apps/electron && npm start
  window.open('runway://wake', '_self');
});

document.getElementById('btn-check').addEventListener('click', init);

document.getElementById('btn-sync').addEventListener('click', syncSession);

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
