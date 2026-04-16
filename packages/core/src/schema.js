/**
 * QuotaSnapshot — the common shape every provider must return.
 *
 * utilization: 0–100 percentage of the current window consumed
 * resets_at:   ISO 8601 UTC string when the window resets, or null if unknown
 * runway_ms:   estimated milliseconds of runway at current burn rate, or null
 */

/**
 * @typedef {Object} WindowQuota
 * @property {number} utilization       - 0–100
 * @property {string|null} resets_at    - ISO 8601 UTC
 * @property {number|null} runway_ms    - estimated remaining time at current burn rate
 */

/**
 * @typedef {Object} QuotaSnapshot
 * @property {string} agent             - provider name: 'claude' | 'codex' | 'copilot' | 'gemini'
 * @property {string} ts_utc            - ISO 8601 UTC timestamp of this snapshot
 * @property {WindowQuota} [short]      - short window (e.g. Claude 5-hour, Codex daily)
 * @property {WindowQuota} [long]       - long window (e.g. Claude 7-day)
 * @property {Object} [raw]             - full raw response from the provider API
 */

/**
 * Build a QuotaSnapshot with defaults filled in.
 *
 * @param {string} agent
 * @param {Partial<QuotaSnapshot>} fields
 * @returns {QuotaSnapshot}
 */
function makeSnapshot(agent, fields = {}) {
  return {
    agent,
    ts_utc: new Date().toISOString(),
    short: null,
    long: null,
    raw: null,
    ...fields,
  };
}

module.exports = { makeSnapshot };
