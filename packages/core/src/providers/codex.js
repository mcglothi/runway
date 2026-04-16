/**
 * Codex / OpenAI provider
 *
 * Fetches usage from OpenAI's organization usage API.
 * Requires an admin API key with org:read scope.
 *
 * Endpoints:
 *   GET https://api.openai.com/v1/organization/usage/completions
 *     ?start_time=<unix>&end_time=<unix>&bucket_width=1d
 *
 * This is the paid API path. The Codex CLI free-tier consumer quota
 * has no public API endpoint — free-tier tracking requires local shim.
 */

const { makeSnapshot } = require('../schema');

const USAGE_ENDPOINT = 'https://api.openai.com/v1/organization/usage/completions';

/**
 * @param {Object} opts
 * @param {string} opts.apiKey   - OpenAI admin API key (sk-...)
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ apiKey }) {
  if (!apiKey) throw new Error('Codex: apiKey is required');

  const now = Math.floor(Date.now() / 1000);
  const startOfDay = now - (now % 86400); // start of current UTC day

  const url = new URL(USAGE_ENDPOINT);
  url.searchParams.set('start_time', startOfDay);
  url.searchParams.set('end_time', now);
  url.searchParams.set('bucket_width', '1d');

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Codex: API error ${res.status}: ${body.substring(0, 200)}`);
  }

  const data = await res.json();

  // Sum today's token usage across all buckets
  const buckets = data.data ?? [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const bucket of buckets) {
    for (const result of bucket.results ?? []) {
      inputTokens += result.input_tokens ?? 0;
      outputTokens += result.output_tokens ?? 0;
    }
  }

  // OpenAI doesn't expose a quota limit via this API — only consumption.
  // We store raw counts and surface them as absolute numbers, not a percentage.
  // utilization is set to null until the user configures a known limit.
  return makeSnapshot('codex', {
    short: {
      utilization: null,
      resets_at: new Date((startOfDay + 86400) * 1000).toISOString(),
      runway_ms: null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    raw: data,
  });
}

module.exports = { fetchQuota };
