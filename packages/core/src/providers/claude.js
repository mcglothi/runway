/**
 * Claude provider
 *
 * Fetches quota from claude.ai's usage API using a session cookie.
 *
 * Auth: sessionKey cookie (copy from browser devtools: Application > Cookies > claude.ai)
 *
 * Endpoints:
 *   GET https://claude.ai/api/organizations                        → resolve orgId
 *   GET https://claude.ai/api/organizations/{orgId}/usage          → quota data
 *
 * Note on Cloudflare: claude.ai blocks plain Node.js fetch. In the Electron app,
 * requests are made via a hidden BrowserWindow that rides the real browser session.
 * In the browser extension, the extension context has direct access to cookies and
 * can fetch without restriction.
 *
 * The fetchFn parameter abstracts this difference — callers provide the appropriate
 * fetch implementation for their surface.
 */

const { makeSnapshot } = require('../schema');

/**
 * @param {Object} opts
 * @param {string} opts.sessionKey  - claude.ai sessionKey cookie value
 * @param {string} [opts.orgId]     - organization ID (resolved automatically if omitted)
 * @param {Function} opts.fetchFn   - async (url) => parsed JSON — caller-provided fetch
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ sessionKey, orgId, fetchFn }) {
  if (!sessionKey) throw new Error('Claude: sessionKey is required');
  if (!fetchFn) throw new Error('Claude: fetchFn is required');

  // Resolve orgId if not cached.
  // The organizations endpoint returns a numeric `id` and a `uuid` field.
  // The usage endpoint requires the UUID form.
  if (!orgId) {
    const orgs = await fetchFn('https://claude.ai/api/organizations');
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error('Claude: no organizations found');
    }
    orgId = orgs[0].uuid ?? orgs[0].id;
  }

  const data = await fetchFn(`https://claude.ai/api/organizations/${orgId}/usage`);

  return makeSnapshot('claude', {
    short: data.five_hour ? {
      utilization: data.five_hour.utilization ?? 0,
      resets_at: data.five_hour.resets_at ?? null,
      runway_ms: estimateRunway(data.five_hour.utilization, data.five_hour.resets_at),
    } : null,
    long: data.seven_day ? {
      utilization: data.seven_day.utilization ?? 0,
      resets_at: data.seven_day.resets_at ?? null,
      runway_ms: estimateRunway(data.seven_day.utilization, data.seven_day.resets_at),
    } : null,
    raw: data,
    _orgId: orgId,
  });
}

/**
 * Estimate runway in milliseconds based on utilization and reset time.
 * Returns null if the reset time is unknown.
 *
 * @param {number} utilization  - 0–100
 * @param {string|null} resetsAt
 * @returns {number|null}
 */
function estimateRunway(utilization, resetsAt) {
  if (!resetsAt || utilization == null) return null;
  const resetMs = new Date(resetsAt).getTime();
  const nowMs = Date.now();
  const windowRemainingMs = resetMs - nowMs;
  if (windowRemainingMs <= 0) return 0;
  // If utilization is 0, full window remains
  if (utilization <= 0) return windowRemainingMs;
  // Estimate: if we've used X% of quota in (total - remaining) time,
  // how long until we hit 100% at current rate?
  const windowTotalMs = windowRemainingMs / (1 - utilization / 100);
  const elapsedMs = windowTotalMs - windowRemainingMs;
  if (elapsedMs <= 0) return windowRemainingMs;
  const burnRatePerMs = utilization / elapsedMs;
  const remainingUtilization = 100 - utilization;
  return Math.round(remainingUtilization / burnRatePerMs);
}

module.exports = { fetchQuota };
