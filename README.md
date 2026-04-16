<p align="center">
  <img src="hero_graphic.png" alt="Runway" width="1000" />
</p>

# Runway

**Know how far your agents can go — before they run out of it.**

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" />
  <img src="https://img.shields.io/badge/Status-Alpha-indigo.svg" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" />
  <img src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux-blue.svg" />
</p>

---

> Your AI agents have limits. Most of the time, you don't find out until you've already hit them.

<p align="center">
  <a href="#why-runway"><strong>Why Runway</strong></a> •
  <a href="#agents-supported"><strong>Agents</strong></a> •
  <a href="#quick-start"><strong>Quick Start</strong></a> •
  <a href="#architecture"><strong>Architecture</strong></a> •
  <a href="#aikb-integration"><strong>AIKB</strong></a>
</p>

---

## Why Runway

Every AI coding agent you run — Claude, Codex, Copilot, Gemini — has limits. A five-hour rolling window. A weekly cap. A daily limit that changes without notice. And none of them tell each other how much is left.

You find out when a session goes cold mid-task. When you burn through your weekly cap on a Tuesday. When your limit was 75% of what it was yesterday and you have no idea why.

Runway fixes that. It's a system tray widget and browser extension that tracks quota across all your agents in real time, stores the history so you can see when limits shift, and gives agents the signal they need to know when to summarize, hand off, or stand down.

```
┌──────────────────────────────────────┐
│ Claude  ████████░░░░  68%   1h22m    │
│ Codex   ███░░░░░░░░░  24%   3h41m    │
│ Copilot enterprise   telemetry only  │
│ Gemini  ─────────────   --   n/a     │
└──────────────────────────────────────┘
         time remaining in window
```

---

## Agents Supported

| Agent | Auth | Quota Source | Status |
|-------|------|-------------|--------|
| Claude (Pro / Max) | Session cookie | `claude.ai/api` usage endpoint | ✅ Built |
| Codex (Paid API) | API key | `api.openai.com/v1/organization/usage` | ✅ Built |
| GitHub Copilot Enterprise | GitHub token | GitHub Copilot usage metrics report API | 🔨 Prototype |
| Gemini (Free / OAuth) | OAuth personal | Local shim (no public API) | 🔨 Prototype |

---

## Features

| Feature | Status | Notes |
|---------|--------|-------|
| System tray widget — live quota gauges | ✅ Built | macOS, Windows, Linux |
| Browser extension | ✅ Built | Chrome (Firefox planned) |
| 5-hour and 7-day window tracking | ✅ Built | Claude |
| Runway display (time remaining at current burn rate) | ✅ Built | Claude, Codex |
| Enterprise telemetry ingest | 🔨 Prototype | GitHub Copilot 28-day metrics reports |
| Dynamic limit tracking | 🔨 Prototype | Detect when your limit changes day-to-day |
| AIKB event log integration | 🔨 Prototype | Snapshots to `_runtime/events/` NDJSON |
| Agent self-awareness API | 🔬 Research | Agents query their own headroom |
| Cross-agent handoff protocol | 🔬 Research | Route tasks to the agent with most runway |
| Gemini quota shim | 🔬 Research | Intercept local CLI calls |

---

## Architecture

Runway is a monorepo. The quota-fetching logic lives in a shared core package consumed by both the Electron app and browser extension.

```
runway/
├── packages/
│   └── core/               # shared quota provider logic
│       └── src/
│           ├── providers/
│           │   ├── claude.js     # claude.ai session API
│           │   ├── copilot.js    # GitHub enterprise usage metrics API
│           │   └── codex.js      # OpenAI organization usage API
│           ├── aikb-writer.js    # write snapshots to AIKB _runtime/events/
│           └── schema.js         # common QuotaSnapshot schema
├── apps/
│   ├── electron/           # system tray widget
│   └── extension/          # browser extension (Chrome)
└── package.json            # npm workspaces root
```

**Why two surfaces?**

The Electron app solves one problem the browser extension cannot: it runs whether or not your browser is open. The extension solves one problem Electron cannot: it rides your existing browser session, so Claude auth requires no manual session key setup.

Both consume `@runway/core`. Write the provider once, deploy to both.

---

## Quick Start

**Prerequisites:** Node.js 20+, npm 10+

**1. Clone and install**

```bash
git clone https://github.com/mcglothi/runway.git
cd runway
npm install
```

**2. Configure credentials**

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Claude — copy sessionKey from browser devtools (Application > Cookies > claude.ai)
CLAUDE_SESSION_KEY=sk-ant-...
CLAUDE_ORG_ID=...

# Codex — OpenAI admin API key with org:read scope
OPENAI_API_KEY=sk-...

# GitHub Copilot Enterprise — token with enterprise Copilot metrics read access
GITHUB_TOKEN=github_pat_...
GITHUB_ENTERPRISE_SLUG=your-enterprise
```

**3. Run the desktop widget**

```bash
npm run dev:electron
```

**4. Install the browser extension (Chrome)**

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `apps/extension/dist/`

The extension auto-detects your `claude.ai` session — no manual key needed.

GitHub Copilot enterprise support currently uses GitHub's metrics report API. GitHub documents up to a two-day UTC lag on those reports, so this path is telemetry-oriented rather than a real-time personal quota meter.

---

## AIKB Integration

If you run the [AI Knowledge Base](https://github.com/mcglothi/ai-knowledge-base), Runway can write quota snapshots directly to your `_runtime/events/` log. This makes your usage history searchable by both humans and agents.

```bash
# Enable in .env
AIKB_EVENTS_PATH=/path/to/AIKB/_runtime/events/
AIKB_SNAPSHOT_INTERVAL=300   # seconds, default 5 min
```

Once enabled, you can query usage history with:

```bash
python3 /path/to/AIKB/_tools/memory-pipeline/runtime_cli.py wake-up
# or via MCP:
aikb_search "how much Claude quota did I use this week"
```

Snapshot schema written to `_runtime/events/YYYY-MM-DD.ndjson`:

```json
{
  "ts_utc": "2026-04-16T18:00:00Z",
  "agent": "Runway",
  "type": "quota_snapshot",
  "summary": "Claude 68% (1h22m), Codex 24% (3h41m)",
  "detail": {
    "claude":  { "five_hour": 68.4, "seven_day": 31.2, "resets_at": "..." },
    "codex":   { "daily": 24.1, "resets_at": "..." },
    "copilot": { "report_day": "2026-04-14", "daily_active_users": 42, "cli_request_count": 318 }
  }
}
```

---

## Roadmap

- [ ] Gemini quota shim (local CLI interceptor)
- [ ] Copilot personal premium-request tracking
- [ ] Firefox extension
- [ ] Agent self-awareness API — let agents query their own headroom over MCP
- [ ] Cross-agent handoff protocol — route new tasks to the agent with most runway
- [ ] Local LLM support (Ollama)
- [ ] Per-device breakdown — see which machine is consuming your quota

---

## Contributing

Runway is part of the [mcglothi](https://github.com/mcglothi) public tooling ecosystem. PRs welcome.

If you're adding a new agent provider, the pattern is in `packages/core/src/providers/`. Each provider exports a single async `fetchQuota()` function that returns a `QuotaSnapshot` (see `schema.js`).

For GitHub Copilot specifically, prefer the usage metrics APIs for enterprise and organization integrations. GitHub's current official APIs expose telemetry and report exports there; personal remaining premium-request balance is still a separate problem.

---

## License

MIT © [mcglothi](https://github.com/mcglothi)
