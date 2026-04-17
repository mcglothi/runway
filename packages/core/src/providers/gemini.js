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
        if (data && data.limits && data.usage) {
          // Find the most relevant model (e.g. Gemini 1.5 Pro)
          const proUsage = data.usage.find(u => u.model.includes('pro')) || data.usage[0];
          const rpdLimit = data.limits.requestsPerDay || 1500; // Default for Pro plan

          const used = proUsage ? proUsage.requestCount : 0;
          const utilization = (used / rpdLimit) * 100;

          const now = new Date();
          const resetsAt = new Date(now);
          resetsAt.setUTCHours(24, 0, 0, 0);

          return makeSnapshot('gemini', {
            short: {
              utilization,
              resets_at: resetsAt.toISOString(),
              runway_ms: estimateRunway(utilization, resetsAt.getTime()),
            },
            raw: data,
          });
        } else {
          console.warn('Gemini: Session API returned incomplete data', JSON.stringify(data)?.substring(0, 100));
        }
      } catch (e) {
        console.warn(`Gemini: Failed to fetch session-based usage: ${e.message}`);
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
  const remaining = 100 - utilization;
  const msLeftInWindow = resetMs - Date.now();
  if (msLeftInWindow <= 0) return 0;

  // Simple linear projection
  // If we used X% in Y time, we have (100-X)% left.
  // This is a rough estimate for daily quotas.
  return Math.round((remaining / utilization) * (24 * 60 * 60 * 1000 - msLeftInWindow));
}

module.exports = { fetchQuota };
