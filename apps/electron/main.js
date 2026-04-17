'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

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
const POPUP_HEIGHT = 200; // grows with more providers

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
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  `);
}

// ── Poll all providers ────────────────────────────────────────────────────────
async function pollAll() {
  const config = loadConfig();
  const results = await Promise.allSettled([
    pollClaude(config),
    pollCodex(config),
    pollCopilot(config),
  ]);

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      snapshots[r.value.agent] = r.value;
    } else if (r.status === 'rejected') {
      console.error('[runway] poll error:', r.reason?.message ?? r.reason);
    }
  }

  pushToPopup();
  maybeWriteToAikb();
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
    height: POPUP_HEIGHT,
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
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - POPUP_WIDTH));
  if (y + POPUP_HEIGHT > workArea.y + workArea.height) {
    y = bounds.y - POPUP_HEIGHT - 4; // flip above if too low
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
  // Re-poll immediately with new credentials
  pollAll();
  return { ok: true };
});
ipcMain.handle('open-settings', openSettings);
ipcMain.handle('open-claude', () => shell.openExternal('https://claude.ai'));
ipcMain.handle('refresh', () => pollAll());

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // macOS: don't show in dock
  if (process.platform === 'darwin') app.dock?.hide();

  // Single instance
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => tray && togglePopup());

  createTray();
  ensureClaudeWindow();

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
});
