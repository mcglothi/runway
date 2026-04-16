/**
 * AIKB Writer
 *
 * Appends quota snapshots to the AIKB _runtime/events/ NDJSON log.
 * Requires AIKB_EVENTS_PATH to be set in config.
 *
 * Output format matches the AIKB runtime event schema so snapshots
 * are searchable via `aikb_search` and readable by other agents.
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {import('./schema').QuotaSnapshot[]} snapshots
 * @param {string} eventsDir  - path to AIKB _runtime/events/ directory
 */
function writeSnapshots(snapshots, eventsDir) {
  if (!eventsDir) return;

  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(eventsDir, `${today}.ndjson`);

  const summaryParts = snapshots
    .filter(s => s.short?.utilization != null)
    .map(s => {
      const pct = Math.round(s.short.utilization);
      const runway = s.short.runway_ms != null
        ? formatRunway(s.short.runway_ms)
        : null;
      return runway
        ? `${capitalize(s.agent)} ${pct}% (${runway})`
        : `${capitalize(s.agent)} ${pct}%`;
    });

  const event = {
    ts_utc: new Date().toISOString(),
    agent: 'Runway',
    type: 'quota_snapshot',
    summary: summaryParts.length > 0
      ? summaryParts.join(', ')
      : 'quota snapshot — no utilization data',
    detail: Object.fromEntries(
      snapshots.map(s => [s.agent, {
        short: s.short,
        long: s.long,
      }])
    ),
  };

  fs.appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
}

function formatRunway(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}m` : `${m}m`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { writeSnapshots };
