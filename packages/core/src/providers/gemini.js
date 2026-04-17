/**
 * Gemini / Google AI Studio provider
 *
 * Verifies the API key is valid and returns a snapshot showing the provider
 * as configured. Utilization tracking is not available via the AI Studio API
 * (no public quota endpoint) — quota will show as — until Google adds one.
 *
 * Auth: API key from https://aistudio.google.com/app/apikey
 */

const { makeSnapshot } = require('../schema');

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * @param {Object} opts
 * @param {string} opts.apiKey  - Google AI Studio API key (AIza...)
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ apiKey }) {
  if (!apiKey) throw new Error('Gemini: apiKey is required');

  const url = `${MODELS_ENDPOINT}?key=${encodeURIComponent(apiKey)}&pageSize=1`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini: API error ${res.status}: ${body.substring(0, 200)}`);
  }

  // Key is valid — quota API not available via AI Studio, so utilization is null.
  // The snapshot still signals "configured and reachable" to the gauge.
  return makeSnapshot('gemini', {
    short: {
      utilization: null,
      resets_at: null,
      runway_ms: null,
    },
    raw: null,
  });
}

module.exports = { fetchQuota };
