# Gemini CLI Telemetry Tracking

Runway can track your Gemini usage in real-time by watching the local telemetry file
written by the [Gemini CLI](https://github.com/google-gemini/gemini-cli).

## How it works

The Gemini CLI can export OpenTelemetry (OTLP) metrics to a local JSON file after
each session. Runway reads this file to count `gemini_cli.api.request.count` data
points for the current calendar day and compares them against the daily free-tier
limit (1,500 requests/day for Gemini Pro accounts).

Runway uses `fs.watch` to detect file changes instantly — no polling delay.

## Setup

### 1. Enable telemetry in the Gemini CLI

Edit `~/.gemini/settings.json` and add (or merge) the following:

```json
{
  "telemetry": {
    "enabled": true,
    "target": "local",
    "outfile": "/Users/yourname/.gemini/telemetry.json"
  }
}
```

If you omit `"outfile"`, the Gemini CLI defaults to `~/.gemini/telemetry.json`.
Runway will auto-detect this path from your settings file.

### 2. Switch Runway to Telemetry mode

Open Runway → **Settings** → **Gemini** → select **Local Telemetry**.

Leave the **Telemetry Log Path** field blank to use auto-detection, or enter the
path explicitly if you set a custom `outfile`.

### 3. Verify

Run a prompt in the Gemini CLI. The Runway gauge should update within seconds of
the session ending, showing `N/1500` in the utilization column.

## Quota reset

Gemini's daily quota resets at **midnight local time**. Runway tracks this per
calendar day using your system clock.

## Notes

- Telemetry is written when a Gemini CLI session ends, not during it. Mid-session
  requests won't appear until the session closes.
- The `OTEL_METRIC_EXPORT_INTERVAL` environment variable controls how often the
  Gemini CLI flushes metrics during a long session. The default is end-of-session.
  You can set it lower (e.g. `export OTEL_METRIC_EXPORT_INTERVAL=30000` for 30s
  flushes) if you want more frequent in-session updates in Runway.
- Only `gemini_cli.api.request.count` is tracked. Token counts are not currently
  reported in the telemetry export.
