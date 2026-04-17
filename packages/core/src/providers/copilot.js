/**
 * GitHub Copilot Enterprise provider
 *
 * Fetches daily Copilot usage metrics from GitHub's enterprise metrics API.
 * Requires an enterprise admin or billing manager token.
 *
 * Auth: Classic PAT with manage_billing:copilot or read:enterprise scope
 *
 * Endpoints:
 *   GET https://api.github.com/enterprises/{enterprise}/copilot/metrics/reports/enterprise-1-day
 *     → manifest with download_links for today's report
 *   Each download link → NDJSON or JSON report with daily totals
 *
 * Utilization: active_users_today / seatCount if seatCount is configured,
 *              otherwise null (raw counts still captured in raw field).
 */

const { makeSnapshot } = require('../schema');

const API_BASE    = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/**
 * @param {Object}   opts
 * @param {string}   opts.token       - GitHub PAT (manage_billing:copilot or read:enterprise)
 * @param {string}   opts.enterprise  - enterprise slug (e.g. "ll-bean")
 * @param {number}   [opts.seatCount] - total licensed seats; enables utilization %
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ token, enterprise, seatCount }) {
  if (!token)      throw new Error('Copilot: token is required');
  if (!enterprise) throw new Error('Copilot: enterprise slug is required');

  const headers = {
    'Accept':              'application/vnd.github+json',
    'Authorization':       `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  };

  // Fetch today's report manifest — returns { download_links: [...] }
  const manifestUrl = `${API_BASE}/enterprises/${enterprise}/copilot/metrics/reports/enterprise-1-day`;
  const manifest = await fetchJson(manifestUrl, headers);

  const links = Array.isArray(manifest.download_links) ? manifest.download_links : [];
  if (links.length === 0) {
    throw new Error('Copilot: no download links in today\'s report manifest');
  }

  // Download and merge all report chunks
  const chunks = await Promise.all(links.map(url => fetchReport(url)));
  const records = chunks.flat();
  if (records.length === 0) {
    throw new Error('Copilot: report download was empty');
  }

  // Prefer a record that has day_totals (enterprise aggregate)
  const record = records.find(r => Array.isArray(r.day_totals)) ?? records[0];
  const dayTotals = Array.isArray(record.day_totals) ? record.day_totals : [];
  const today = dayTotals[dayTotals.length - 1] ?? null;

  const activeUsers   = today?.daily_active_users ?? null;
  const acceptances   = today?.code_acceptance_activity_count ?? null;
  const suggestions   = today?.code_generation_activity_count ?? null;
  const interactions  = today?.user_initiated_interaction_count ?? null;

  // Utilization: active seats / total licensed seats (requires seatCount from settings)
  const seats = seatCount && seatCount > 0 ? seatCount : null;
  const utilization = seats != null && activeUsers != null
    ? Math.min(100, (activeUsers / seats) * 100)
    : null;

  // Acceptance rate as a secondary signal (completions accepted vs generated)
  const acceptanceRate = suggestions != null && suggestions > 0 && acceptances != null
    ? Math.min(100, (acceptances / suggestions) * 100)
    : null;

  return makeSnapshot('copilot', {
    short: {
      utilization,
      resets_at:           null, // seat licenses don't have a quota reset
      runway_ms:           null,
      active_users:        activeUsers,
      total_seats:         seats,
      acceptance_rate:     acceptanceRate,
      suggestions:         suggestions,
      acceptances:         acceptances,
      interactions:        interactions,
      report_day:          today?.day ?? record.report_end_day ?? null,
    },
    raw: { manifest, records },
  });
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Copilot: API ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

async function fetchReport(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Copilot: report download ${res.status}: ${body.substring(0, 200)}`);
  }
  const text = (await res.text()).trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  // NDJSON
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

module.exports = { fetchQuota };
