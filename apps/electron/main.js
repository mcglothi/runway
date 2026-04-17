'use strict';

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
let claudeWin = null;   // hidden BrowserWindow — Claude Cloudflare bypass
let settingsWin = null;
let snapshots = {};     // latest QuotaSnapshot per agent
let pollTimer = null;
let claudeOrgId = null; // cached to avoid re-resolving every poll

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POPUP_WIDTH = 340;
const POPUP_ROW_HEIGHT = 32; // px per provider row
const POPUP_CHROME = 88;     // header + footer fixed height
const LOCAL_SERVER_PORT = 47821;

let localServer = null;

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

// ── Provider enable/disable ───────────────────────────────────────────────────
// A provider is enabled unless the config explicitly sets it to false.
// Claude defaults to enabled; others default to enabled only when credentials exist.
function isEnabled(config, provider) {
  const key = `${provider}Enabled`;
  if (key in config) return config[key] !== false && config[key] !== 'false';
  // If no explicit flag, enable if credentials are present (or always for claude)
  if (provider === 'claude') return true;
  if (provider === 'codex')   return !!config.codexApiKey;
  if (provider === 'copilot') return !!(config.copilotToken && config.copilotEnterprise);
  if (provider === 'gemini')  return !!config.geminiApiKey;
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
  pushToPopup();
  maybeWriteToAikb();
}

function resizePopup() {
  if (!popupWin || popupWin.isDestroyed()) return;
  const count = Math.max(1, Object.keys(snapshots).length);
  const h = POPUP_CHROME + count * POPUP_ROW_HEIGHT;
  popupWin.setSize(POPUP_WIDTH, h);
}

async function pollClaude(config) {
  const { claude } = require('@runway/core');

  // Read sessionKey from the BrowserWindow's persisted cookie store
  const session = ensureClaudeWindow().webContents.session;
  const cookies = await session.cookies.get({ url: 'https://claude.ai' });
  const sessionKey = cookies.find(c => c.name === 'sessionKey')?.value;
  if (!sessionKey) return null; // not logged in — skip silently

  const snapshot = await claude.fetchQuota({
    sessionKey,
    orgId: claudeOrgId,
    fetchFn: claudeFetch,
  });

  // Cache orgId to avoid redundant /organizations calls
  if (snapshot._orgId) claudeOrgId = snapshot._orgId;

  return snapshot;
}

async function pollCodex(config) {
  if (!config.codexApiKey) return null;
  const { codex } = require('@runway/core');
  const tokenLimit = config.codexTokenLimit ? Number(config.codexTokenLimit) : undefined;
  return codex.fetchQuota({ apiKey: config.codexApiKey, tokenLimit });
}

async function pollCopilot(config) {
  if (!config.copilotToken || !config.copilotEnterprise) return null;
  const { copilot } = require('@runway/core');
  return copilot.fetchQuota({
    token: config.copilotToken,
    enterprise: config.copilotEnterprise,
  });
}

async function pollGemini(config) {
  if (!config.geminiApiKey) return null;
  const { gemini } = require('@runway/core');
  return gemini.fetchQuota({ apiKey: config.geminiApiKey });
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
    height: 500,
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

  // Fallback text label if no icon (visible on macOS menu bar)
  if (icon.isEmpty()) tray.setTitle('RW');

  tray.setToolTip('Runway — AI quota tracker');

  // Left click → toggle popup
  tray.on('click', togglePopup);

  // Right click → context menu
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Refresh Now', click: () => pollAll() },
      { label: 'Settings…', click: openSettings },
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
          const { sessionKey } = JSON.parse(body);
          if (!sessionKey || typeof sessionKey !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sessionKey required' }));
            return;
          }

          // Inject the cookie into the Claude partition so the hidden
          // BrowserWindow picks it up on the next poll
          const claudeSession = session.fromPartition('persist:claude');
          await claudeSession.cookies.set({
            url: 'https://claude.ai',
            name: 'sessionKey',
            value: sessionKey,
            httpOnly: true,
            secure: true,
            expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
          });

          claudeOrgId = null; // clear cached org ID — may have changed
          pollAll();          // re-poll immediately with fresh session

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
