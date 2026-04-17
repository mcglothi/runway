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
 * @param {string} opts.apiKey        - OpenAI admin API key (sk-...)
 * @param {number} [opts.tokenLimit]  - user-configured daily token limit (input + output combined)
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ apiKey, tokenLimit }) {
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

  const totalTokens = inputTokens + outputTokens;
  const resetsAt = new Date((startOfDay + 86400) * 1000).toISOString();

  let utilization = null;
  let runway_ms = null;

  if (tokenLimit && tokenLimit > 0) {
    utilization = Math.min(100, (totalTokens / tokenLimit) * 100);

    // Estimate burn rate from tokens used so far today vs. elapsed time.
    // If no tokens used yet, full window remains.
    const elapsedMs = (now - startOfDay) * 1000;
    if (totalTokens > 0 && elapsedMs > 0) {
      const burnRatePerMs = totalTokens / elapsedMs;
      const remainingTokens = tokenLimit - totalTokens;
      runway_ms = remainingTokens > 0
        ? Math.round(remainingTokens / burnRatePerMs)
        : 0;
    } else {
      runway_ms = (startOfDay + 86400 - now) * 1000; // full day remaining
    }
  }

  return makeSnapshot('codex', {
    short: {
      utilization,
      resets_at: resetsAt,
      runway_ms,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    raw: data,
  });
}

module.exports = { fetchQuota };
