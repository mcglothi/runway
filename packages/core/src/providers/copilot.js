/**
 * GitHub Copilot Enterprise provider
 *
 * Fetches enterprise Copilot usage metrics from GitHub's report API.
 *
 * Auth:
 *   Fine-grained GitHub App token, installation token, or PAT with
 *   enterprise Copilot metrics read access.
 *
 * Endpoints:
 *   GET https://api.github.com/enterprises/{enterprise}/copilot/metrics/reports/enterprise-28-day/latest
 *     → signed download links for the latest processed report
 *
 * Notes:
 *   - This is enterprise telemetry, not a personal remaining-quota API.
 *   - GitHub documents a data freshness lag of up to two full UTC days.
 *   - Download payloads may be JSON arrays or NDJSON exports depending on report shape.
 */

const { makeSnapshot } = require('../schema');

const API_VERSION = '2026-03-10';

/**
 * @param {Object} opts
 * @param {string} opts.token
 * @param {string} opts.enterprise
 * @param {Function} [opts.fetchFn]
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ token, enterprise, fetchFn = fetch }) {
  if (!token) throw new Error('Copilot: token is required');
  if (!enterprise) throw new Error('Copilot: enterprise slug is required');
  if (!fetchFn) throw new Error('Copilot: fetchFn is required');

  const manifestUrl = `https://api.github.com/enterprises/${enterprise}/copilot/metrics/reports/enterprise-28-day/latest`;
  const manifest = await fetchJson(fetchFn, manifestUrl, {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  });

  const links = Array.isArray(manifest.download_links) ? manifest.download_links : [];
  if (links.length === 0) {
    throw new Error('Copilot: metrics report did not include any download links');
  }

  const reportParts = await Promise.all(links.map((url) => fetchReportChunk(fetchFn, url)));
  const reportRecords = reportParts.flat();
  if (reportRecords.length === 0) {
    throw new Error('Copilot: metrics report download was empty');
  }

  const enterpriseRecord = reportRecords.find((record) => Array.isArray(record.day_totals)) || reportRecords[0];
  const dayTotals = Array.isArray(enterpriseRecord.day_totals) ? enterpriseRecord.day_totals : [];
  const latestDay = dayTotals[dayTotals.length - 1] || null;
  const cliTotals = latestDay?.totals_by_cli || {};
  const tokenUsage = cliTotals.token_usage || {};

  return makeSnapshot('copilot', {
    short: latestDay ? {
      utilization: null,
      resets_at: null,
      runway_ms: null,
      report_day: latestDay.day ?? enterpriseRecord.report_end_day ?? null,
      daily_active_users: latestDay.daily_active_users ?? null,
      daily_active_cli_users: latestDay.daily_active_cli_users ?? null,
      weekly_active_users: latestDay.weekly_active_users ?? null,
      monthly_active_users: latestDay.monthly_active_users ?? null,
      monthly_active_chat_users: latestDay.monthly_active_chat_users ?? null,
      monthly_active_agent_users: latestDay.monthly_active_agent_users ?? null,
      code_acceptance_activity_count: latestDay.code_acceptance_activity_count ?? null,
      code_generation_activity_count: latestDay.code_generation_activity_count ?? null,
      user_initiated_interaction_count: latestDay.user_initiated_interaction_count ?? null,
      cli_prompt_count: cliTotals.prompt_count ?? null,
      cli_request_count: cliTotals.request_count ?? null,
      cli_session_count: cliTotals.session_count ?? null,
      prompt_tokens: tokenUsage.prompt_tokens_sum ?? null,
      output_tokens: tokenUsage.output_tokens_sum ?? null,
      avg_tokens_per_request: tokenUsage.avg_tokens_per_request ?? null,
    } : null,
    long: {
      utilization: null,
      resets_at: null,
      runway_ms: null,
      report_start_day: enterpriseRecord.report_start_day ?? null,
      report_end_day: enterpriseRecord.report_end_day ?? null,
      daily_points: dayTotals.length,
      enterprise_id: enterpriseRecord.enterprise_id ?? null,
    },
    raw: {
      manifest,
      records: reportRecords,
    },
  });
}

async function fetchJson(fetchFn, url, headers) {
  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Copilot: API error ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

async function fetchReportChunk(fetchFn, url) {
  const res = await fetchFn(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Copilot: report download error ${res.status}: ${body.substring(0, 200)}`);
  }

  const text = await res.text();
  return parseReportText(text);
}

function parseReportText(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = { fetchQuota };
