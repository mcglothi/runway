'use strict';

process.on('uncaughtException',    (err) => console.error('[runway] uncaughtException:', err));
process.on('unhandledRejection',   (err) => console.error('[runway] unhandledRejection:', err));

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function saveConfig(data) {
  const current = loadConfig();
  const merged = { ...current, ...data };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
}

// ── State ─────────────────────────────────────────────────────────────────────
let tray = null;
let popupWin = null;
let claudeWin = null;    // hidden BrowserWindow — Claude Cloudflare bypass
let chatgptWin = null;   // hidden BrowserWindow — ChatGPT/Codex session
let geminiWin = null;    // hidden BrowserWindow — Google AI Studio session
let settingsWin = null;
let snapshots = {};     // latest QuotaSnapshot per agent
let pollTimer = null;
let claudeOrgId = null; // cached to avoid re-resolving every poll

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POPUP_WIDTH = 340;
const POPUP_ROW_HEIGHT = 30; // px per window row
const POPUP_CHROME = 88;     // header + footer fixed height
const LOCAL_SERVER_PORT = 47821;

// Abbreviated labels used in the verbose tray title
const TRAY_LABELS = { claude: 'C', codex: 'Cx', gemini: 'G', copilot: 'Cp' };

let localServer = null;
let trayIconEmpty = false; // true when no icon.png found — we use text fallback

// ── Claude hidden window ──────────────────────────────────────────────────────
function ensureClaudeWindow() {
  if (claudeWin && !claudeWin.isDestroyed()) return claudeWin;

  claudeWin = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:claude', // dedicated session so cookies persist
    },
  });

  // Load claude.ai once so the session/cookies are established
  claudeWin.loadURL('https://claude.ai');
  claudeWin.on('closed', () => { claudeWin = null; });
  return claudeWin;
}

// Execute a fetch from within the Claude BrowserWindow (bypasses Cloudflare)
async function claudeFetch(url) {
  const win = ensureClaudeWindow();
  // Wait until the window has finished loading at least once
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }
  return win.webContents.executeJavaScript(`
    fetch(${JSON.stringify(url)}, { credentials: 'include' })
      .then(async r => {
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error('HTTP ' + r.status + ' ' + ${JSON.stringify(url)} + ': ' + body.substring(0, 300));
        }
        return r.json();
      })
  `);
}

// ── ChatGPT hidden window ─────────────────────────────────────────────────────
function ensureChatGptWindow() {
  if (chatgptWin && !chatgptWin.isDestroyed()) return chatgptWin;

  chatgptWin = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:chatgpt', // separate session so cookies persist
    },
  });

  chatgptWin.loadURL('https://chatgpt.com');
  chatgptWin.on('closed', () => { chatgptWin = null; });
  return chatgptWin;
}

// Execute a credentialed fetch from within the ChatGPT BrowserWindow.
// First retrieves the Bearer JWT from NextAuth (/api/auth/session),
// then calls the target URL with it.
async function chatgptFetch(url) {
  const win = ensureChatGptWindow();
  if (win.webContents.isLoading()) {
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  }
  return win.webContents.executeJavaScript(`
    (async () => {
      // Retrieve the Bearer access token from the NextAuth session endpoint
      let token = null;
      try {
        const sess = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
        token = sess?.accessToken;
      } catch (_) {}

      const headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error('HTTP ' + r.status + ' ' + ${JSON.stringify(url)} + ': ' + body.substring(0, 200));
      }
      return r.json();
    })()
  `);
}

// ── Gemini hidden window ──────────────────────────────────────────────────────
function ensureGeminiWindow() {
  if (geminiWin && !geminiWin.isDestroyed()) return geminiWin;

  geminiWin = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:gemini',
    },
  });

  // Use a standard Chrome User-Agent to avoid "Insecure Browser" blocks
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  geminiWin.webContents.setUserAgent(userAgent);

  geminiWin.loadURL('https://aistudio.google.com/app/apikey');
  geminiWin.on('closed', () => { geminiWin = null; });

  // Monitor network traffic to find the real usage endpoint
  const geminiSession = geminiWin.webContents.session;
  geminiSession.webRequest.onBeforeRequest({ urls: ['https://aistudio.google.com/api/*'] }, (details, callback) => {
    if (details.url.includes('usage') || details.url.includes('quota') || details.url.includes('metrics') || details.url.includes('billing')) {
      console.log(`[runway:gemini:discovery] Intercepted internal API call: ${details.url}`);
    }
    callback({});
  });

  return geminiWin;
}
async function geminiFetch(url) {
  const win = ensureGeminiWindow();
  if (win.webContents.isLoading()) {
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  }

  // Debug: Log cookies in this partition
  const cookies = await win.webContents.session.cookies.get({});
  console.log(`[runway:gemini] Partition has ${cookies.length} cookies:`, cookies.map(c => c.name).join(', '));

  const currentUrl = win.getURL();
  if (!currentUrl.includes('aistudio.google.com')) {
    win.loadURL('https://aistudio.google.com/app/apikey');
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  }

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const p = '/api/usage';
        const r = await fetch(p, { credentials: 'include' });
        const body = await r.text();
        const contentType = r.headers.get('content-type') || '';
        
        return { 
          ok: r.ok, 
          status: r.status, 
          contentType, 
          body: body.substring(0, 500),
          isJson: contentType.includes('application/json')
        };
      } catch (err) {
        return { error: err.message };
      }
    })()
  `);

  if (result.error) {
    console.error(`[runway:gemini] Fetch failed:`, result.error);
    throw new Error(result.error);
  }

  console.log(`[runway:gemini] Response (${result.status}):`, result.contentType);
  
  if (result.isJson) {
    try {
      const data = JSON.parse(result.body);
      console.log(`[runway:gemini] usage data parsed successfully`);
      return data;
    } catch (e) {
      console.error('[runway:gemini] JSON parse error:', e.message);
    }
  }

  if (result.body.includes('Google Account') || result.body.includes('signin')) {
    console.warn('[runway:gemini] usage API redirected to login page');
    throw new Error('NOT_LOGGED_IN');
  }

  console.log(`[runway:gemini] unexpected response body:`, result.body.substring(0, 150));
  throw new Error('No valid usage JSON found');
}

// ── Provider enable/disable ───────────────────────────────────────────────────
// A provider is enabled unless the config explicitly sets it to false.
// Claude defaults to enabled; others default to enabled only when credentials exist.
function isEnabled(config, provider) {
  const key = `${provider}Enabled`;
  if (key in config) return config[key] !== false && config[key] !== 'false';
  // If no explicit flag, enable if credentials are present (or always for session-based providers)
  if (provider === 'claude') return true;
  if (provider === 'codex')  return true;
  if (provider === 'gemini') return true;
  if (provider === 'copilot') return !!(config.copilotToken && config.copilotEnterprise);
  return false;
}

// ── Poll all providers ────────────────────────────────────────────────────────
async function pollAll() {
  const config = loadConfig();
  const tag = (name, p) => p.catch(e => { e.provider = name; throw e; });
  const results = await Promise.allSettled([
    tag('claude',  isEnabled(config, 'claude')  ? pollClaude(config)  : Promise.resolve(null)),
    tag('codex',   isEnabled(config, 'codex')   ? pollCodex(config)   : Promise.resolve(null)),
    tag('copilot', isEnabled(config, 'copilot') ? pollCopilot(config) : Promise.resolve(null)),
    tag('gemini',  isEnabled(config, 'gemini')  ? pollGemini(config)  : Promise.resolve(null)),
  ]);

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      snapshots[r.value.agent] = r.value;
    } else if (r.status === 'rejected') {
      const who = r.reason?.provider ?? 'unknown';
      console.error(`[runway:${who}] poll error:`, r.reason?.message ?? r.reason);
    }
  }

  resizePopup();
  updateTrayTitle();
  pushToPopup();
  maybeWriteToAikb();
}

function resizePopup() {
  if (!popupWin || popupWin.isDestroyed()) return;
  let rows = 0;
  for (const snap of Object.values(snapshots)) {
    // Providers with both short + long windows (Claude) render two rows
    rows += (snap.short && snap.long) ? 2 : 1;
  }
  rows = Math.max(1, rows);
  popupWin.setSize(POPUP_WIDTH, POPUP_CHROME + rows * POPUP_ROW_HEIGHT);
}

// ── Tray title (verbose mode) ─────────────────────────────────────────────────
function buildTrayTitle() {
  const config = loadConfig();
  if (config.trayMode !== 'verbose') {
    // In compact mode with no icon, keep the text fallback so the tray stays visible
    return trayIconEmpty ? 'RW' : '';
  }

  const parts = [];
  for (const agent of ['claude', 'codex', 'gemini', 'copilot']) {
    const snap = snapshots[agent];
    if (!snap) continue;
    const label = TRAY_LABELS[agent] ?? agent;

    if (snap.short && snap.long) {
      // Dual-window: show both (e.g. C:48%/12%)
      const s = snap.short.utilization != null ? `${Math.round(snap.short.utilization)}%` : '–';
      const l = snap.long.utilization  != null ? `${Math.round(snap.long.utilization)}%`  : '–';
      parts.push(`${label}:${s}/${l}`);
    } else {
      const w = snap.short ?? snap.long;
      const pct = w?.utilization != null ? `${Math.round(w.utilization)}%` : '–';
      parts.push(`${label}:${pct}`);
    }
  }

  return parts.join('  ');
}

function updateTrayTitle() {
  if (!tray) return;
  try {
    tray.setTitle(buildTrayTitle());
  } catch (e) {
    console.error('[runway] tray.setTitle error:', e.message);
  }
}

async function pollClaude(config) {
  const { claude } = require('@runway/core');
  const mode = config.claudeMode || 'pro';

  if (mode === 'api') {
    return claude.fetchQuota({
      apiKey: config.claudeApiKey,
      mode: 'api',
    });
  }

  // Read sessionKey from the BrowserWindow's persisted cookie store
  const session = ensureClaudeWindow().webContents.session;
  const cookies = await session.cookies.get({ url: 'https://claude.ai' });
  const sessionKey = cookies.find(c => c.name === 'sessionKey')?.value;
  if (!sessionKey) return null; // not logged in — skip silently

  const snapshot = await claude.fetchQuota({
    sessionKey,
    orgId: claudeOrgId,
    fetchFn: claudeFetch,
    mode: 'pro',
  });

  // Cache orgId to avoid redundant /organizations calls
  if (snapshot._orgId) claudeOrgId = snapshot._orgId;

  return snapshot;
}

async function pollCodex(config) {
  const { codex } = require('@runway/core');
  const mode = config.codexMode || 'pro';

  if (mode === 'api') {
    return codex.fetchQuota({
      apiKey: config.codexApiKey,
      mode: 'api',
    });
  }

  return codex.fetchQuota({
    fetchFn: chatgptFetch,
    mode: 'pro',
  });
}

async function pollCopilot(config) {
  if (!config.copilotToken || !config.copilotEnterprise) return null;
  const { copilot } = require('@runway/core');
  const seatCount = config.copilotSeatCount ? Number(config.copilotSeatCount) : undefined;
  return copilot.fetchQuota({
    token:      config.copilotToken,
    enterprise: config.copilotEnterprise,
    seatCount,
    mode:       config.copilotMode || 'api',
  });
}

async function pollGemini(config) {
  const { gemini } = require('@runway/core');
  const mode = config.geminiMode || 'pro';

  return gemini.fetchQuota({
    apiKey: config.geminiApiKey,
    fetchFn: mode === 'pro' ? geminiFetch : null,
    mode,
  });
}

function maybeWriteToAikb() {
  const config = loadConfig();
  if (!config.aikbEventsDir) return;
  const { writeSnapshots } = require('@runway/core');
  writeSnapshots(Object.values(snapshots), config.aikbEventsDir);
}

// ── Popup window ──────────────────────────────────────────────────────────────
function createPopupWindow() {
  popupWin = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_CHROME + POPUP_ROW_HEIGHT, // initial: 1 row, resized after first poll
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popupWin.loadFile(path.join(__dirname, 'renderer.html'));

  // Push current snapshots once the renderer is ready so there's no race
  // between the window loading and the initial getSnapshots() call
  popupWin.webContents.once('did-finish-load', () => pushToPopup());

  // Hide when focus is lost (click away)
  popupWin.on('blur', () => {
    if (popupWin && !popupWin.isDestroyed() && !settingsWin?.isFocused()) {
      popupWin.hide();
    }
  });

  popupWin.on('closed', () => { popupWin = null; });
}

function togglePopup() {
  if (!popupWin || popupWin.isDestroyed()) createPopupWindow();

  if (popupWin.isVisible()) {
    popupWin.hide();
    return;
  }

  positionPopupNearTray();
  popupWin.show();
  popupWin.focus();
  pushToPopup();
}

function positionPopupNearTray() {
  const bounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const workArea = display.workArea;

  // Default: above the tray on macOS (menu bar at top)
  let x = Math.round(bounds.x + bounds.width / 2 - POPUP_WIDTH / 2);
  let y = Math.round(bounds.y + bounds.height + 4);

  // Keep within screen bounds
  const popupH = popupWin.getBounds().height;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - POPUP_WIDTH));
  if (y + popupH > workArea.y + workArea.height) {
    y = bounds.y - popupH - 4; // flip above if too low
  }

  popupWin.setPosition(Math.round(x), Math.round(y));
}

function pushToPopup() {
  if (!popupWin || !popupWin.isVisible() || popupWin.isDestroyed()) return;
  popupWin.webContents.send('snapshots', snapshots);
}

// ── Settings window ───────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 480,
    height: 580,
    title: 'Runway — Settings',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  // Load icon, fall back gracefully
  let icon;
  const iconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') icon = icon.resize({ width: 16, height: 16 });
  } else {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  trayIconEmpty = icon.isEmpty();

  // Fallback text label if no icon (visible on macOS menu bar)
  if (trayIconEmpty) tray.setTitle('RW');

  tray.setToolTip('Runway — AI quota tracker');

  // Left click → toggle popup
  tray.on('click', togglePopup);

  // Right click → context menu
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Refresh Now', click: () => pollAll() },
      { label: 'Settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Login to Claude…', click: () => shell.openExternal('https://claude.ai') },
      { label: 'Login to ChatGPT…', click: () => {
        const win = ensureChatGptWindow();
        win.show();
        win.focus();
      } },
      { label: 'Login to AI Studio…', click: () => {
        const win = ensureGeminiWindow();
        win.show();
        win.focus();
        win.once('closed', () => pollAll());
      } },
      { type: 'separator' },
      { label: 'Quit Runway', click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-snapshots', () => snapshots);
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_e, data) => {
  saveConfig(data);
  // Clear snapshots so disabled providers disappear immediately from the gauge
  snapshots = {};
  pollAll();
  return { ok: true };
});
ipcMain.handle('open-settings', openSettings);
ipcMain.handle('open-claude',    () => shell.openExternal('https://claude.ai'));
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('refresh', () => pollAll());
ipcMain.handle('open-chatgpt-login', () => {
  const win = ensureChatGptWindow();
  win.show();
  win.focus();
  // Re-poll once the user closes the login window
  win.once('closed', () => pollAll());
});
ipcMain.handle('open-gemini-login', () => {
  const win = ensureGeminiWindow();
  win.show();
  win.focus();
  // Ensure it's not hidden when we want to log in
  win.setMenuBarVisibility(true);
});

// ── Local HTTP server (extension bridge) ──────────────────────────────────────
//
// Listens on 127.0.0.1:47821. Only reachable from localhost.
// The browser extension uses this to:
//   GET  /status  → confirm the desktop app is running
//   POST /session → push a Claude sessionKey into the persisted cookie store
//
function startLocalServer() {
  localServer = http.createServer(async (req, res) => {
    // Reject anything not from loopback
    const addr = req.socket.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      res.writeHead(403).end();
      return;
    }

    // CORS — Chrome extensions need these headers even for localhost
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: true, version: app.getVersion() }));
      return;
    }

    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { sessionKey, geminiCookies } = JSON.parse(body);

          // 1. Claude sync
          if (sessionKey && typeof sessionKey === 'string') {
            const claudeSession = session.fromPartition('persist:claude');
            await claudeSession.cookies.set({
              url: 'https://claude.ai',
              name: 'sessionKey',
              value: sessionKey,
              httpOnly: true,
              secure: true,
              expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
            });
            claudeOrgId = null;
          }

          // 2. Gemini sync
          if (geminiCookies && Array.isArray(geminiCookies)) {
            console.log(`[runway] syncing ${geminiCookies.length} Gemini cookies`);
            const geminiSession = session.fromPartition('persist:gemini');
            for (const c of geminiCookies) {
              // Construct a valid URL for the cookie based on its domain
              let domain = c.domain;
              if (domain.startsWith('.')) domain = domain.substring(1);
              const url = `https://${domain}${c.path}`;

              const cookieObj = {
                url: url,
                name: c.name,
                value: c.value,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                expirationDate: c.expirationDate,
              };

              // Security rules for prefixed cookies:
              // __Host- must NOT have a domain, must be secure, and path must be /
              if (c.name.startsWith('__Host-')) {
                cookieObj.url = `https://${domain}/`;
                cookieObj.path = '/';
                cookieObj.secure = true;
                delete cookieObj.domain;
              } else {
                cookieObj.domain = c.domain;
              }

              // __Secure- must be secure
              if (c.name.startsWith('__Secure-')) {
                cookieObj.secure = true;
              }

              try {
                await geminiSession.cookies.set(cookieObj);
              } catch (err) {
                console.error(`[runway] failed to set cookie ${c.name}:`, err.message);
              }
            }
            // Force the window to reload or navigate to ensure cookies take effect
            if (geminiWin && !geminiWin.isDestroyed()) {
              geminiWin.loadURL('https://aistudio.google.com/app/apikey');
            }
          }

          pollAll(); // re-poll immediately with fresh session

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  localServer.listen(LOCAL_SERVER_PORT, '127.0.0.1', () => {
    console.log(`[runway] bridge server listening on 127.0.0.1:${LOCAL_SERVER_PORT}`);
  });

  localServer.on('error', err => {
    console.error('[runway] bridge server error:', err.message);
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // macOS: don't show in dock
  if (process.platform === 'darwin') app.dock?.hide();

  // Single instance — bring popup to front if a second instance is launched
  // (also handles runway:// protocol opens when app is already running)
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => tray && togglePopup());

  // Register runway:// protocol so the browser extension can wake the app
  app.setAsDefaultProtocolClient('runway');
  app.on('open-url', (event, _url) => {
    event.preventDefault();
    if (tray) togglePopup();
  });

  createTray();
  ensureClaudeWindow();
  ensureChatGptWindow();
  ensureGeminiWindow();
  startLocalServer();

  // Initial poll then schedule
  pollAll();
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
});

app.on('window-all-closed', (e) => {
  // Keep running as a tray app — don't quit when all windows close
  e.preventDefault();
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (localServer) localServer.close();
});
