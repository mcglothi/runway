'use strict';

process.on('uncaughtException',    (err) => console.error('[runway] uncaughtException:', err));
process.on('unhandledRejection',   (err) => console.error('[runway] unhandledRejection:', err));

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

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
let isPolling = false;  // Guard against overlapping polls
let claudeOrgId = null; // cached to avoid re-resolving every poll
let lastAikbWriteMs = 0; // rate-limit AIKB snapshot writes
let updateInfo = null;   // { version, releaseUrl, downloadUrl } or null if up-to-date

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // check for updates every 6 hours
const RELEASES_API = 'https://api.github.com/repos/mcglothi/runway/releases/latest';
const AIKB_MIN_WRITE_INTERVAL_MS = 5 * 60 * 1000; // write AIKB snapshot at most once per 5 min
const POPUP_WIDTH = 360;
const POPUP_ROW_HEIGHT = 30;  // px per window row
const POPUP_CHROME = 88;      // header + footer fixed height
const POPUP_HINT_HEIGHT   = 56; // connect-hint banner, approximate
const POPUP_UPDATE_HEIGHT = 36; // update-available banner, approximate
const LOCAL_SERVER_PORT = 47821;
const PROVIDER_ORDER = ['claude', 'codex', 'gemini', 'copilot'];
const CUSTOM_PROTOCOL = 'runway://';

// Abbreviated labels used in the verbose tray title
const TRAY_LABELS = { claude: 'C', codex: 'Cx', gemini: 'G', copilot: 'Cp' };

let localServer = null;
let trayIconEmpty = false; // true when we had to fall back to a generated icon
let shouldRevealOnReady = false;
let trayMenu = null;

// ── Debounce / throttle helpers ───────────────────────────────────────────────
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Throttle pushToPopup: max one IPC send per 2s regardless of call source
let lastPushTime = 0;
const PUSH_THROTTLE_MS = 2000;
function throttledPush() {
  const now = Date.now();
  if (now - lastPushTime < PUSH_THROTTLE_MS) return;
  lastPushTime = now;
  pushToPopup();
}

function svgToDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function createGeneratedTrayIcon(isTemplate = false) {
  const size = process.platform === 'win32' ? 32 : 18;
  const strokeColor = isTemplate ? '#000000' : 'url(#icon-grad)';
  
  // For template images, we MUST NOT have any background rect or fill.
  // Just the paths that will be tinted by macOS.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 18 18" fill="none">
      <defs>
        <linearGradient id="icon-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#00C2FF" />
          <stop offset="100%" stop-color="#6E40C9" />
        </linearGradient>
      </defs>
      ${!isTemplate ? `<rect x="1" y="1" width="16" height="16" rx="4.5" fill="#0F172A" />` : ''}
      <path d="M4.5 13.5l3-9 3 9" stroke="${strokeColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 9.5h2" stroke="${strokeColor}" stroke-width="1.8" stroke-linecap="round"/>
      ${!isTemplate ? `
      <circle cx="13.5" cy="4.5" r="1.2" fill="#00C2FF">
        <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
      </circle>` : ''}
    </svg>
  `;
  let icon = nativeImage.createFromDataURL(svgToDataUrl(svg));
  if (process.platform === 'darwin') {
    icon = icon.resize({ width: 16, height: 16 });
    if (isTemplate) icon.setTemplateImage(true);
  }
  return icon;
}

function loadTrayIcon() {
  const config = loadConfig();
  
  // In verbose mode, the user wants NO icon, just the text
  if (config.trayMode === 'verbose') {
    return nativeImage.createEmpty();
  }

  // Always use the generated template icon for macOS menubar to ensure
  // it looks "modern" and matches the brand mark without being a white box.
  if (process.platform === 'darwin') {
    return createGeneratedTrayIcon(true);
  }

  const candidates = [
    path.join(__dirname, 'build-assets', 'icon.png'),
    path.join(__dirname, 'icon.png'),
  ];
  for (const iconPath of candidates) {
    if (!fs.existsSync(iconPath)) continue;
    let icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) return icon;
  }
  
  return createGeneratedTrayIcon(false);
}

function hasCustomProtocolArg(argv = []) {
  return argv.some((arg) => typeof arg === 'string' && arg.startsWith(CUSTOM_PROTOCOL));
}

function supportsOpenAtLogin() {
  if (process.platform === 'linux') return app.isPackaged;
  return process.platform === 'darwin' || process.platform === 'win32';
}

function getLinuxAutostartFile() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', 'runway.desktop');
}

function getLinuxDesktopEntry() {
  const execPath = process.execPath.replace(/(["\\$`])/g, '\\$1');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Runway',
    'Comment=AI quota tracker tray app',
    `Exec="${execPath}"`,
    'Terminal=false',
    'Categories=Development;',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function getOpenAtLogin() {
  if (process.platform === 'linux') {
    return fs.existsSync(getLinuxAutostartFile());
  }
  if (!supportsOpenAtLogin()) return false;
  try {
    return app.getLoginItemSettings().openAtLogin === true;
  } catch {
    return false;
  }
}

function applyOpenAtLogin(enabled) {
  const openAtLogin = enabled === true;
  if (process.platform === 'linux') {
    const autostartFile = getLinuxAutostartFile();
    if (!app.isPackaged) {
      if (!openAtLogin && fs.existsSync(autostartFile)) fs.rmSync(autostartFile, { force: true });
      return;
    }
    if (openAtLogin) {
      fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
      fs.writeFileSync(autostartFile, getLinuxDesktopEntry(), 'utf8');
    } else if (fs.existsSync(autostartFile)) {
      fs.rmSync(autostartFile, { force: true });
    }
    return;
  }
  if (!supportsOpenAtLogin()) return;
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin, openAsHidden: true });
    return;
  }
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin });
  }
}

function getRuntimeInfo() {
  return {
    platform: process.platform,
    platformLabel:
      process.platform === 'darwin' ? 'macOS' :
      process.platform === 'win32' ? 'Windows' :
      process.platform === 'linux' ? 'Linux' :
      process.platform,
    supportsOpenAtLogin: supportsOpenAtLogin(),
    openAtLogin: getOpenAtLogin(),
  };
}

function revealRunway() {
  if (!tray) {
    shouldRevealOnReady = true;
    return;
  }
  shouldRevealOnReady = false;
  if (!popupWin || popupWin.isDestroyed()) createPopupWindow();
  positionPopupNearTray();
  popupWin.show();
  popupWin.focus();
  pushToPopup();
}

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
      backgroundThrottling: true,
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
      backgroundThrottling: true,
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
    title: 'Login to Google AI Studio',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:gemini',
      backgroundThrottling: true,
      // Google often blocks windows that look like automation
      devTools: true, 
    },
  });

  // Modern Chrome User-Agent on macOS - crucial for Google login trust
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
  geminiWin.webContents.setUserAgent(userAgent);

  geminiWin.loadURL('https://aistudio.google.com/app/usage');
  geminiWin.on('closed', () => { geminiWin = null; });

  // Monitor network traffic using Debugger to capture response bodies
  const view = geminiWin.webContents;
  
  // Attach debugger only when window is hidden (polling mode) or established.
  // Sometimes active debuggers trigger the "not secure" block.
  function attachDebugger() {
    try {
      if (!view.debugger.isAttached()) {
        view.debugger.attach('1.3');
      }
      
      view.debugger.on('message', async (event, method, params) => {
        if (method === 'Network.responseReceived') {
          const url = params.response.url;
          if (url.includes('/api/') && (url.includes('usage') || url.includes('quota') || url.includes('models'))) {
            setTimeout(async () => {
              try {
                if (geminiWin && !geminiWin.isDestroyed()) {
                  const { body } = await view.debugger.sendCommand('Network.getResponseBody', { 
                    requestId: params.requestId 
                  });
                  if (body) {
                    try {
                      const data = JSON.parse(body);
                      global.latestGeminiUsage = data;
                      const { gemini } = require('@runway/core');
                      const snap = await gemini.fetchQuota({ apiKey: null, fetchFn: async () => data, mode: 'pro' });
                      if (snap) {
                        snapshots['gemini'] = snap;
                        updateTrayTitle();
                        throttledPush();
                      }
                    } catch (e) {}
                  }
                }
              } catch (e) {}
            }, 500);
          }
        }
      });
      view.debugger.sendCommand('Network.enable');
    } catch (err) {
      console.error('[runway:gemini] Debugger attach failed:', err.message);
    }
  }

  // If the window is showing (interactive login), we might want to delay debugger
  // to avoid Google sensing automation.
  if (geminiWin.isVisible()) {
     geminiWin.webContents.once('did-finish-load', () => setTimeout(attachDebugger, 2000));
  } else {
     attachDebugger();
  }

  return geminiWin;
}

async function geminiFetch(url) {
  const win = ensureGeminiWindow();
  
  // If we already captured data from background traffic, use it!
  if (global.latestGeminiUsage) {
    return global.latestGeminiUsage;
  }

  // Non-blocking loading check: if it's still loading, just return null for now
  if (win.webContents.isLoading()) {
    console.log(`[runway:gemini] Window still loading (${win.getURL()}), skipping active fetch`);
    return null;
  }

  const currentUrl = win.getURL();
  if (!currentUrl.includes('aistudio.google.com/app/')) {
    console.warn(`[runway:gemini] geminiFetch not on app page (${currentUrl}), redirecting...`);
    win.loadURL('https://aistudio.google.com/app/usage');
    return null;
  }

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const r = await fetch('/api/usage', { credentials: 'include' });
        const contentType = r.headers.get('content-type') || '';
        if (!r.ok || !contentType.includes('application/json')) return { error: 'Not JSON or error' };
        const data = await r.json();
        return { data };
      } catch (err) {
        return { error: err.message };
      }
    })()
  `).catch(() => ({ error: 'executeJavaScript failed' }));

  return result.data || null;
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
  if (isPolling) return;
  isPolling = true;

  try {
    const config = loadConfig();
    
    // Pre-initialize snapshots for all enabled providers
    const { makeSnapshot } = require('@runway/core');
    for (const name of PROVIDER_ORDER) {
      if (isEnabled(config, name)) {
        if (!snapshots[name]) {
          snapshots[name] = makeSnapshot(name);
        }
      } else {
        delete snapshots[name];
      }
    }
    throttledPush();
    updateTrayTitle();

    const tag = (name, p) => p.catch(e => { e.provider = name; throw e; });
    const results = await Promise.allSettled([
      tag('claude',  isEnabled(config, 'claude')  ? pollClaude(config)  : Promise.resolve(null)),
      tag('codex',   isEnabled(config, 'codex')   ? pollCodex(config)   : Promise.resolve(null)),
      tag('copilot', isEnabled(config, 'copilot') ? pollCopilot(config) : Promise.resolve(null)),
      tag('gemini',  isEnabled(config, 'gemini')  ? pollGemini(config)  : Promise.resolve(null)),
    ]);

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const snap = r.value;
        if (snap) {
          snapshots[snap.agent] = snap;
        }
      } else if (r.status === 'rejected') {
        const idx = results.indexOf(r);
        const name = PROVIDER_ORDER[idx] || 'unknown';
        console.error(`[runway:${name}] poll error:`, r.reason?.message ?? r.reason);
      }
    }

    resizePopup();
    updateTrayTitle();
    throttledPush();
    maybeWriteToAikb();
  } finally {
    isPolling = false;
  }
}

function resizePopup() {
  if (!popupWin || popupWin.isDestroyed()) return;
  const config = loadConfig();

  // If the user has manually resized the window, don't overwrite it with 'smart' sizing
  if (config.popupWidth && config.popupHeight) {
    return;
  }

  const orientation = config.orientation || 'vertical';
  
  if (orientation === 'horizontal') {
    const activeCount = Object.keys(snapshots).length;
    const width = Math.max(POPUP_WIDTH, activeCount * 120 + 40);
    popupWin.setSize(width, 140);
    return;
  }

  let rows = 0;
  let anyNoData = false;
  for (const [, snap] of Object.entries(snapshots)) {
    // Copilot and Claude can render two rows (seats+accept or short+long)
    rows += (snap.short && snap.long) ? 2 : 1;
    if (snap.short?.utilization == null && !snap.short?.text) anyNoData = true;
  }
  rows = Math.max(1, rows);
  const hintExtra   = anyNoData ? POPUP_HINT_HEIGHT : 0;
  const updateExtra = updateInfo ? POPUP_UPDATE_HEIGHT : 0;
  popupWin.setSize(POPUP_WIDTH, POPUP_CHROME + rows * POPUP_ROW_HEIGHT + hintExtra + updateExtra);
}

// ── Tray title (verbose mode) ─────────────────────────────────────────────────
function buildTrayTitle() {
  const config = loadConfig();
  if (config.trayMode !== 'verbose') {
    // In compact mode, we have an icon. 
    // If the icon is empty for some reason, show 'RW' so the tray remains clickable.
    const icon = loadTrayIcon();
    return icon.isEmpty() ? 'RW' : '';
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
  const { gemini, geminiTelemetry } = require('@runway/core');
  const mode = config.geminiMode || 'pro';

  if (mode === 'telemetry') {
    // Resolve path: explicit config → auto-detect from ~/.gemini/settings.json → default
    let filePath = config.geminiTelemetryPath;
    if (!filePath) {
      filePath = autoDetectGeminiTelemetryPath() || '~/.gemini/telemetry.json';
    }
    if (filePath.startsWith('~')) {
      const os = require('os');
      filePath = path.join(os.homedir(), filePath.slice(1));
    }
    ensureGeminiTelemetryWatcher(filePath);
    console.log(`[runway:gemini] Telemetry mode active. Path: ${filePath}`);
    try {
      if (fs.existsSync(filePath)) {
        // Read only the last 512 KB of the telemetry file — the 24-hour window
        // only needs recent entries, and large files (GB+) crash Node when fully loaded.
        const TAIL_BYTES = 512 * 1024;
        const stat = fs.statSync(filePath);
        let logContent;
        if (stat.size > TAIL_BYTES) {
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(TAIL_BYTES);
          fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
          fs.closeSync(fd);
          logContent = buf.toString('utf8');
        } else {
          logContent = fs.readFileSync(filePath, 'utf8');
        }
        const snap = await geminiTelemetry.fetchQuota({ logContent });
        console.log(`[runway:gemini] Telemetry snapshot: utilization=${snap.short?.utilization}% requests=${snap.raw?.totalRequests}`);
        maybeTrimTelemetryFile(filePath);
        return snap;
      } else {
        console.warn(`[runway:gemini] Telemetry file NOT FOUND: ${filePath}`);
        const { makeSnapshot } = require('@runway/core');
        return makeSnapshot('gemini', { 
          short: { utilization: null, resets_at: null, runway_ms: null },
          long: { utilization: null, text: 'File missing' }
        });
      }
    } catch (e) {
      console.error('[runway:gemini] Telemetry read failed:', e.message);
      const { makeSnapshot } = require('@runway/core');
      return makeSnapshot('gemini', { 
        short: { utilization: null, resets_at: null, runway_ms: null },
        long: { utilization: null, text: 'Read error' }
      });
    }
  }

  return gemini.fetchQuota({
    apiKey: config.geminiApiKey,
    fetchFn: mode === 'pro' ? geminiFetch : null,
    mode,
  }).then(snap => {
    // If Pro mode returned null (not logged in), provide a placeholder snapshot
    if (!snap && mode === 'pro') {
      const { makeSnapshot } = require('@runway/core');
      return makeSnapshot('gemini', {
        short: { utilization: null, resets_at: null, runway_ms: null },
        long: { utilization: null, text: 'Not logged in' }
      });
    }
    return snap;
  });
}

// ── Gemini telemetry file trimmer ─────────────────────────────────────────────
const TELEMETRY_TRIM_THRESHOLD = 50  * 1024 * 1024; // trim when > 50 MB
const TELEMETRY_KEEP_BYTES     =  2  * 1024 * 1024; // keep last 2 MB

/**
 * If the telemetry file has grown past TRIM_THRESHOLD, atomically rewrite it
 * with only the last KEEP_BYTES. Called after each successful read so the file
 * never accumulates more than ~50 MB between polls.
 */
function maybeTrimTelemetryFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= TELEMETRY_TRIM_THRESHOLD) return;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(TELEMETRY_KEEP_BYTES);
    fs.readSync(fd, buf, 0, TELEMETRY_KEEP_BYTES, stat.size - TELEMETRY_KEEP_BYTES);
    fs.closeSync(fd);
    const tmp = filePath + '.runway_trim_tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
    console.log(`[runway:gemini] Trimmed telemetry file: ${(stat.size / 1024 / 1024).toFixed(1)} MB → ${(TELEMETRY_KEEP_BYTES / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.warn('[runway:gemini] Trim failed (non-fatal):', e.message);
  }
}

// ── Gemini telemetry auto-detection + file watcher ───────────────────────────
let geminiTelemetryWatcher = null;
let geminiTelemetryWatchedPath = null;

/**
 * Read ~/.gemini/settings.json and extract the telemetry outfile path.
 * Falls back to the default location when telemetry is enabled but outfile
 * isn't explicitly set.
 */
function autoDetectGeminiTelemetryPath() {
  try {
    const os = require('os');
    const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
    if (!fs.existsSync(settingsPath)) return null;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const tel = settings?.telemetry;
    if (!tel?.enabled) return null;
    if (tel.outfile) {
      return tel.outfile.startsWith('~')
        ? path.join(os.homedir(), tel.outfile.slice(1))
        : tel.outfile;
    }
    // enabled + target=local but no explicit outfile → default location
    if (tel.target === 'local') {
      return path.join(os.homedir(), '.gemini', 'telemetry.json');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Watch the telemetry file for changes and trigger an immediate poll.
 * Only attaches one watcher — recreates it if the path changes.
 */
function ensureGeminiTelemetryWatcher(filePath) {
  if (geminiTelemetryWatcher && geminiTelemetryWatchedPath === filePath) return;

  // Tear down old watcher if path changed
  if (geminiTelemetryWatcher) {
    try { geminiTelemetryWatcher.close(); } catch (_) {}
    geminiTelemetryWatcher = null;
  }

  if (!filePath || !fs.existsSync(filePath)) return;

  try {
    // Debounce fs.watch events — macOS FSEvents fires multiple times per write.
    // 1s debounce prevents rapid-fire pollAll() calls from a single file change.
    const onTelemetryChange = debounce(() => {
      console.log('[runway:gemini] Telemetry file changed — polling');
      pollAll();
    }, 1000);

    geminiTelemetryWatcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        onTelemetryChange();
      }
    });
    geminiTelemetryWatcher.on('error', (err) => {
      console.warn('[runway:gemini] Telemetry watcher error:', err.message);
      geminiTelemetryWatcher = null;
      geminiTelemetryWatchedPath = null;
    });
    geminiTelemetryWatchedPath = filePath;
    console.log(`[runway:gemini] Watching telemetry: ${filePath}`);
  } catch (e) {
    console.warn('[runway:gemini] fs.watch failed:', e.message);
  }
}

// ── Update checker ────────────────────────────────────────────────────────────
/**
 * Compares two semver strings. Returns true if `remote` is strictly newer than `local`.
 * Handles "v"-prefixed strings (e.g. "v0.1.2").
 */
function isNewerVersion(local, remote) {
  const parse = (v) => (v || '').replace(/^v/, '').split('.').map(Number);
  const [la, lb, lc] = parse(local);
  const [ra, rb, rc] = parse(remote);
  if (ra !== la) return ra > la;
  if (rb !== lb) return rb > lb;
  return rc > lc;
}

async function checkForUpdates() {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { 'User-Agent': 'Runway-App', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const data = await res.json();

    const remoteVersion = (data.tag_name || '').replace(/^v/, '');
    const localVersion = app.getVersion();

    if (!isNewerVersion(localVersion, remoteVersion)) {
      updateInfo = null;
      pushToPopup();
      return;
    }

    // Find the right platform asset: prefer arm64 DMG on mac, x64 DMG on intel, zip fallback
    const assets = data.assets || [];
    const platform = process.platform;
    const arch = process.arch;
    let downloadUrl = data.html_url; // fallback to releases page

    if (platform === 'darwin') {
      const archSuffix = arch === 'arm64' ? 'arm64' : 'x64';
      const dmg = assets.find(a => a.name.endsWith(`-${archSuffix}.dmg`));
      if (dmg) downloadUrl = dmg.browser_download_url;
    } else if (platform === 'win32') {
      const exe = assets.find(a => a.name.endsWith('.exe'));
      if (exe) downloadUrl = exe.browser_download_url;
    } else {
      const appimage = assets.find(a => a.name.endsWith('.AppImage'));
      if (appimage) downloadUrl = appimage.browser_download_url;
    }

    updateInfo = { version: remoteVersion, releaseUrl: data.html_url, downloadUrl };
    console.log(`[runway:updater] Update available: ${localVersion} → ${remoteVersion}`);
    pushToPopup();
  } catch (e) {
    console.warn('[runway:updater] Update check failed:', e.message);
  }
}

function scheduleUpdateChecks() {
  checkForUpdates(); // check immediately on startup
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
}

// ── Poll scheduling ───────────────────────────────────────────────────────────
function schedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  const config = loadConfig();
  const interval = typeof config.refreshInterval === 'number'
    ? config.refreshInterval
    : DEFAULT_POLL_INTERVAL_MS;
  if (interval > 0) {
    pollTimer = setInterval(pollAll, interval);
  }
}

function maybeWriteToAikb() {
  const now = Date.now();
  if (now - lastAikbWriteMs < AIKB_MIN_WRITE_INTERVAL_MS) return;
  lastAikbWriteMs = now;

  const config = loadConfig();
  let eventsDir = config.aikbEventsDir;

  // Prefer root dir if set, appending the standard runtime path
  if (config.aikbRootDir) {
    eventsDir = path.join(config.aikbRootDir, '_runtime', 'events');
  }

  if (!eventsDir) return;
  const { writeSnapshots } = require('@runway/core');
  writeSnapshots(Object.values(snapshots), eventsDir);
}

// ── Popup window ──────────────────────────────────────────────────────────────
function createPopupWindow() {
  const config = loadConfig();
  popupWin = new BrowserWindow({
    width: config.popupWidth || POPUP_WIDTH,
    height: config.popupHeight || (POPUP_CHROME + POPUP_ROW_HEIGHT),
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: config.pinned !== false,
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

  // Hide when focus is lost (click away), UNLESS it's pinned
  popupWin.on('blur', () => {
    const config = loadConfig();
    if (config.pinned === true) return; // Keep visible if pinned

    if (popupWin && !popupWin.isDestroyed() && !settingsWin?.isFocused()) {
      popupWin.hide();
    }
  });

  popupWin.on('resized', () => {
    const [w, h] = popupWin.getSize();
    saveConfig({ popupWidth: w, popupHeight: h });
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

  // Start below the tray/menu area, then flip above if we would overflow.
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
  popupWin.webContents.send('snapshots', snapshotsWithCosts());
  popupWin.webContents.send('update-info', updateInfo);
}

/**
 * Attach API-equivalent cost estimates to snapshot windows before sending
 * to the renderer. Only Claude and Codex are annotated; Gemini and Copilot
 * are excluded (no reliable per-token mapping for consumer plans).
 */
function snapshotsWithCosts() {
  const { pricing } = require('@runway/core');
  const config = loadConfig();
  const out = {};
  for (const [agent, snap] of Object.entries(snapshots)) {
    if (!snap || (agent !== 'claude' && agent !== 'codex')) {
      out[agent] = snap;
      continue;
    }
    const tierKey = config[`${agent}Plan`] || undefined;
    const annotate = (win) => {
      if (!win) return win;
      const est = pricing.estimateCost(agent, win.utilization, tierKey);
      return est ? { ...win, cost_est: est } : win;
    };
    out[agent] = { ...snap, short: annotate(snap.short), long: annotate(snap.long) };
  }
  return out;
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
  const icon = loadTrayIcon();

  tray = new Tray(icon);
  trayIconEmpty = icon.isEmpty();

  // Text fallback is only meaningful on macOS and some Linux shells.
  if (trayIconEmpty) tray.setTitle('RW');

  tray.setToolTip('Runway — AI quota tracker');
  trayMenu = Menu.buildFromTemplate([
    { label: 'Refresh Now', click: () => pollAll() },
    { label: 'Hard Refresh…', click: () => {
      // Force recreation of all hidden windows
      if (claudeWin)  { claudeWin.destroy();  claudeWin = null; }
      if (chatgptWin) { chatgptWin.destroy(); chatgptWin = null; }
      if (geminiWin)  { geminiWin.destroy();  geminiWin = null; }
      pollAll();
    } },
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
    { label: 'Quit Runway', click: () => app.exit(0) },
  ]);
  // tray.setContextMenu(trayMenu); // REMOVED to avoid double-overlap on click

  // Left click → toggle popup
  tray.on('click', togglePopup);

  // Right click → context menu
  tray.on('right-click', () => {
    tray.popUpContextMenu(trayMenu);
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-snapshots', () => snapshotsWithCosts());
ipcMain.handle('get-update-info', () => updateInfo);
ipcMain.handle('get-tier-options', (_e, agent) => {
  const { pricing } = require('@runway/core');
  return pricing.tierOptions(agent);
});
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('get-runtime-info', () => getRuntimeInfo());
ipcMain.handle('save-config', (_e, data) => {
  saveConfig(data);
  if (tray) tray.setImage(loadTrayIcon());
  if ('openAtLogin' in data) applyOpenAtLogin(data.openAtLogin);
  // Clear snapshots so disabled providers disappear immediately from the gauge
  snapshots = {};
  schedulePoll(); // re-read interval in case it changed
  pollAll();
  return { ok: true };
});
ipcMain.handle('open-settings', openSettings);
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select AIKB Root Directory',
    buttonLabel: 'Select Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
ipcMain.handle('toggle-pin', () => {
  const config = loadConfig();
  const pinned = !(config.pinned !== false);
  saveConfig({ pinned });
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.setAlwaysOnTop(pinned);
  }
  return { pinned };
});
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
  win.loadURL('https://aistudio.google.com/app/usage');
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
              geminiWin.loadURL('https://aistudio.google.com/app/usage');
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
  if (process.platform === 'win32') app.setAppUserModelId('com.mcglothi.runway');
  applyOpenAtLogin(loadConfig().openAtLogin);

  // Single instance — bring popup to front if a second instance is launched
  // (also handles runway:// protocol opens when app is already running)
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, commandLine) => {
    if (hasCustomProtocolArg(commandLine)) {
      revealRunway();
      return;
    }
    if (tray) togglePopup();
  });

  // Register runway:// protocol so the browser extension can wake the app
  app.setAsDefaultProtocolClient('runway');
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (url?.startsWith(CUSTOM_PROTOCOL)) revealRunway();
  });
  shouldRevealOnReady = hasCustomProtocolArg(process.argv);

  createTray();

  // Removed eager window pre-warming — each ensure*Window() is called lazily
  // from its poll function on first use. Eagerly loading URLs for all three
  // providers simultaneously at startup triggers a c-ares DNS crash on macOS
  // Tahoe (26.x). Lazy creation avoids this and has no functional impact.

  startLocalServer();

  if (shouldRevealOnReady) revealRunway();

  // Initial poll then schedule
  pollAll();
  schedulePoll();
  scheduleUpdateChecks();
});

app.on('activate', () => {
  if (tray) revealRunway();
});

app.on('window-all-closed', (e) => {
  // Keep running as a tray app — don't quit when all windows close
  e.preventDefault();
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (localServer) localServer.close();
  if (geminiTelemetryWatcher) { try { geminiTelemetryWatcher.close(); } catch (_) {} }
});
