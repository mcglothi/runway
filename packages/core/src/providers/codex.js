/**
 * Codex / ChatGPT provider
 *
 * Fetches Codex usage quota from chatgpt.com's internal usage API.
 * Uses a browser session (same approach as Claude) to bypass Cloudflare.
 *
 * Endpoints:
 *   GET https://chatgpt.com/backend-api/wham/usage
 *     → rate_limit.primary_window  (5-hour window)
 *     → rate_limit.secondary_window (7-day window)
 *
 * Auth: chatgpt.com session cookies + Bearer JWT from /api/auth/session
 * Both are obtained automatically via the hidden BrowserWindow session.
 */

const { makeSnapshot } = require('../schema');

const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';

/**
 * @param {Object} opts
 * @param {Function} [opts.fetchFn] - async (url) => parsed JSON, provided by Electron main
 * @param {string} [opts.apiKey]    - OpenAI API key
 * @param {string} [opts.mode]      - 'pro' (default) or 'api'
 * @returns {Promise<import('../schema').QuotaSnapshot | null>}
 */
async function fetchQuota({ fetchFn, apiKey, mode = 'pro' }) {
  if (mode === 'api') {
    if (!apiKey) throw new Error('Codex: apiKey is required for API mode');
    // Basic check for API key validity
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (res.status === 401) throw new Error('Codex: Invalid API Key');
    // OpenAI API doesn't have a simple usage endpoint for rate limits yet
    return makeSnapshot('codex', { short: null, raw: { status: res.status } });
  }

  if (!fetchFn) throw new Error('Codex: fetchFn is required');

  const data = await fetchFn(USAGE_ENDPOINT);
  if (!data?.rate_limit) return null; // not logged in or no quota data

  const primary   = data.rate_limit.primary_window;
  const secondary = data.rate_limit.secondary_window;

  return makeSnapshot('codex', {
    short: primary ? {
      utilization: primary.used_percent ?? null,
      resets_at:   primary.reset_at
        ? new Date(primary.reset_at * 1000).toISOString()
        : null,
      runway_ms: estimateRunway(
        primary.used_percent,
        primary.limit_window_seconds,
        primary.reset_after_seconds,
      ),
    } : null,
    long: secondary ? {
      utilization: secondary.used_percent ?? null,
      resets_at:   secondary.reset_at
        ? new Date(secondary.reset_at * 1000).toISOString()
        : null,
      runway_ms: estimateRunway(
        secondary.used_percent,
        secondary.limit_window_seconds,
        secondary.reset_after_seconds,
      ),
    } : null,
    raw: data,
  });
}

/**
 * Compute runway from the exact window metrics returned by the wham API.
 * More accurate than estimation from reset time alone because we know
 * both the total window duration and the time elapsed within it.
 *
 * @param {number} usedPercent       - 0–100
 * @param {number} windowSeconds     - total window duration in seconds
 * @param {number} resetAfterSeconds - seconds remaining until window resets
 * @returns {number|null}            - estimated ms until quota exhausted
 */
function estimateRunway(usedPercent, windowSeconds, resetAfterSeconds) {
  if (usedPercent == null || windowSeconds == null || resetAfterSeconds == null) return null;
  if (usedPercent >= 100) return 0;
  if (usedPercent <= 0)   return resetAfterSeconds * 1000; // nothing burned yet

  const elapsedSeconds = windowSeconds - resetAfterSeconds;
  if (elapsedSeconds <= 0) return null;

  // burn rate: percent consumed per second
  const burnRatePerSecond = usedPercent / elapsedSeconds;
  const remainingPercent  = 100 - usedPercent;
  return Math.round((remainingPercent / burnRatePerSecond) * 1000);
}

module.exports = { fetchQuota };
