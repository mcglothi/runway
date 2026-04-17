/**
 * Gemini / Google AI Studio provider
 *
 * Fetches usage stats from the internal AI Studio usage API.
 * Like Claude and Codex, this requires a browser session if using the
 * internal endpoint, or can fall back to a simple "connected" check
 * with just an API key.
 *
 * Auth:
 *  1. API Key: Basic connectivity check only.
 *  2. Session: (Internal API) Full quota tracking (requests per day).
 */

const { makeSnapshot } = require('../schema');

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const USAGE_ENDPOINT  = 'https://aistudio.google.com/api/usage';

/**
 * @param {Object} opts
 * @param {string} [opts.apiKey]   - Google AI Studio API key
 * @param {Function} [opts.fetchFn] - Internal fetcher (for session-based usage)
 * @param {string} [opts.mode]      - 'pro' (default) or 'api'
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ apiKey, fetchFn, mode = 'pro' }) {
  // If we have a session fetcher and mode is 'pro', try to get detailed stats
  if (mode === 'pro') {
    if (!fetchFn) {
      console.warn('Gemini: Pro mode active but no fetchFn provided');
    } else {
      try {
        const data = await fetchFn(USAGE_ENDPOINT);
        if (data) {
          // 2026: Try multiple known data paths in the JSON
          // Path 1: data.limits.requestsPerDay + data.usage[].requestCount
          // Path 2: data.quotas[].limit + data.quotas[].usage
          
          let used = 0;
          let limit = 1500; // default Pro plan

          if (data.limits && data.usage) {
            const proUsage = data.usage.find(u => u.model?.includes('pro')) || data.usage[0];
            used = proUsage ? (proUsage.requestCount ?? 0) : 0;
            limit = data.limits.requestsPerDay || 1500;
          } else if (data.quotas && Array.isArray(data.quotas)) {
            // Find requests-per-day metric
            const rpdQuota = data.quotas.find(q => q.metric?.includes('requests_per_day')) || 
                             data.quotas.find(q => q.metric?.includes('generate_content'));
            if (rpdQuota) {
              used = rpdQuota.usage ?? 0;
              limit = rpdQuota.limit ?? 1500;
            }
          } else {
            console.warn('Gemini: Unrecognized usage data shape', JSON.stringify(data).substring(0, 100));
            // If we got valid JSON but don't know the shape, we still return a snapshot
            // so the UI knows we are connected.
            return makeSnapshot('gemini', { short: { utilization: null, resets_at: null, runway_ms: null }, raw: data });
          }

          const utilization = (used / limit) * 100;
          const now = new Date();
          const resetsAt = new Date(now);
          resetsAt.setUTCHours(24, 0, 0, 0);

          return makeSnapshot('gemini', {
            short: {
              utilization,
              resets_at: resetsAt.toISOString(),
              runway_ms: estimateRunway(utilization, resetsAt.getTime()),
            },
            long: {
              utilization: null,
              text: `${used}/${limit}`,
            },
            raw: data,
          });
        }
      } catch (e) {
        if (e.message === 'NOT_LOGGED_IN') {
          console.warn('Gemini: Session expired, please login via tray menu');
        } else {
          console.warn(`Gemini: Failed to fetch session-based usage: ${e.message}`);
        }
      }
    }
  }

  // Fallback: API Key connectivity check
  if (!apiKey) return null;
  const url = `${MODELS_ENDPOINT}?key=${encodeURIComponent(apiKey)}&pageSize=1`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini: API error ${res.status}: ${body.substring(0, 200)}`);
  }

  return makeSnapshot('gemini', {
    short: { utilization: null, resets_at: null, runway_ms: null },
    raw: null,
  });
}

/**
 * @param {number} utilization
 * @param {number} resetMs
 */
function estimateRunway(utilization, resetMs) {
  if (utilization == null || utilization >= 100) return 0;
  const msLeftInWindow = resetMs - Date.now();
  if (msLeftInWindow <= 0) return 0;
  if (utilization <= 0) return msLeftInWindow;

  const remaining = 100 - utilization;
  // Linear projection: if we burned X% in (24h - msLeft), rate = X% / elapsed
  return Math.round((remaining / utilization) * (24 * 60 * 60 * 1000 - msLeftInWindow));
}

module.exports = { fetchQuota };
