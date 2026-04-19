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
| :--- | :--- | :--- | :--- |
| **Claude** | Session / API Key | Internal usage API / Anthropic API | ✅ Built |
| **Codex** | Session / API Key | ChatGPT internal API / OpenAI API | ✅ Built |
| **Gemini** | Session / API Key | AI Studio usage API / Google API | ✅ Built (Requests/Day) |
| **Copilot** | GitHub PAT | GitHub Enterprise Metrics API | ✅ Built |

## Latest Features (v0.1.1)
- **Unified Mode Selection:** Every provider now supports a "Pro Plan" vs "API Key" toggle.
  - **Pro Plan:** Rides your browser session (Claude.ai, ChatGPT, AI Studio) to track your subscription-based quotas.
  - **API Key:** Uses standard developer keys for users paying by the token.
- **Native Gemini Tracking:** First-of-its-kind "Requests Per Day" meter for Google AI Studio users.
- **In-App Login:** Secure authentication windows for Claude and Gemini built directly into the tray app to ensure long-lived sessions.
- **AIKB Integration:** Quota snapshots can be automatically pushed to your AI Knowledge Base event log for cross-agent awareness.

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
| Launch on login | 🔨 Prototype | macOS, Windows, and packaged Linux desktop autostart |
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

**Install status**

- Available now: clone the repo and build locally for macOS, Windows, or Linux
- Planned: GitHub Releases with downloadable installers
- Planned: Homebrew cask for macOS after release artifacts are live

Release and Homebrew details live in [docs/distribution.md](docs/distribution.md).

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

**4. Build desktop installers**

```bash
# Current platform package
npm run build:electron

# Or target a specific desktop OS
npm run build:mac
npm run build:linux
npm run build:win
```

If you update the desktop icon artwork, regenerate the packaged assets with:

```bash
bash scripts/build-electron-icons.sh
```

After release DMGs exist, generate the Homebrew cask with:

```bash
npm run dist:homebrew-cask -- \
  --arm64 dist/Runway-x.y.z-arm64.dmg \
  --x64 dist/Runway-x.y.z-x64.dmg
```

**5. Install the browser extension (Chrome)**

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `apps/extension/dist/`

The extension auto-detects your `claude.ai` session — no manual key needed.

GitHub Copilot enterprise support currently uses GitHub's metrics report API. GitHub documents up to a two-day UTC lag on those reports, so this path is telemetry-oriented rather than a real-time personal quota meter.

---

## AIKB Integration: Agent Self-Awareness

Runway is designed to feed the [AI Knowledge Base](https://github.com/mcglothi/AIKB) (AIKB). By writing quota snapshots to `_runtime/events/`, Runway gives agents the **self-awareness** they need to pace themselves.

### Context Offloading & Model Routing
When an agent (like Claude Code or Gemini CLI) is connected to an AIKB-synced Runway instance, it can query its own headroom before starting a complex task. This enables:

1.  **Intelligent Summarization:** If Runway reports only 10% headroom left in the 5-hour window, the agent can proactively trigger a `/compress` or context offload to save tokens.
2.  **Model Routing:** An orchestrator can see that Gemini has 90% "Daily" runway while Claude is at 5% and automatically route the next large implementation task to Gemini.
3.  **Local LLM Offloading (AI Hub):** Agents can determine if a task is too "expensive" for the remaining window and automatically offload the work to a local model (via **Ollama** or **AI Hub**) to preserve premium quota for tasks that require frontier-model reasoning.
4.  **Cost Guardrails:** Stop agents from starting "runaway" loops that would exhaust your weekly or daily caps.

### Configuration
Enable the AIKB event stream in Settings or `.env`:

```bash
# Enable in .env
AIKB_EVENTS_PATH=/path/to/AIKB/_runtime/events/
```

Once enabled, agents can query their status via AIKB search:
> "How much runway do I have left on Claude?"

---

## Roadmap

- [x] Gemini Pro session tracking (AI Studio)
- [x] Gemini CLI telemetry tracking (OTLP)
- [x] Global "Pro Plan" vs "API Key" selection
- [ ] Agent self-awareness API — let agents query their own headroom over MCP
- [ ] Cross-agent handoff protocol — route new tasks to the agent with most runway
- [ ] Historical usage graphs (local-only)
- [ ] Local LLM support (Ollama)
- [ ] Homebrew distribution formula
- [ ] Configurable auto-refresh intervals (15s–1hr)
- [x] Cross-platform desktop packaging (macOS, Linux, Windows)

- [ ] Per-device breakdown — see which machine is consuming your quota

---

## Contributing

Runway is part of the [mcglothi](https://github.com/mcglothi) public tooling ecosystem. PRs welcome.

If you're adding a new agent provider, the pattern is in `packages/core/src/providers/`. Each provider exports a single async `fetchQuota()` function that returns a `QuotaSnapshot` (see `schema.js`).

For GitHub Copilot specifically, prefer the usage metrics APIs for enterprise and organization integrations. GitHub's current official APIs expose telemetry and report exports there; personal remaining premium-request balance is still a separate problem.

---

## License

MIT © [mcglothi](https://github.com/mcglothi)
