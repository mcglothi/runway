/**
 * Gemini Telemetry provider
 *
 * Reads usage stats from the local Gemini CLI telemetry log (OTLP JSON).
 *
 * This allows Runway to track usage from local CLI calls, which are
 * not captured by the AI Studio browser session tracking.
 */

const { makeSnapshot } = require('../schema');

/**
 * @param {Object} opts
 * @param {string} [opts.logContent] - The content of the telemetry.json file
 * @param {number} [opts.limit]      - Daily limit (default 1500 for Pro tier)
 * @returns {Promise<import('../schema').QuotaSnapshot>}
 */
async function fetchQuota({ logContent, limit = 1500 }) {
  if (!logContent) {
    return makeSnapshot('gemini', { short: null });
  }

  const objects = parseConcatenatedJson(logContent);

  // Use local day boundary for daily quota
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todaySeconds = Math.floor(today.getTime() / 1000);

  let totalRequests = 0;

  for (const obj of objects) {
    for (const sm of obj.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        if (m.descriptor?.name === 'gemini_cli.api.request.count') {
          for (const dp of m.dataPoints || []) {
            // dp.startTime is [seconds, nanoseconds]
            const tsParts = dp.startTime;
            const ts = Array.isArray(tsParts) ? tsParts[0] : tsParts;

            if (ts && ts >= todaySeconds) {
              totalRequests += (dp.value || 0);
            }
          }
        }
      }
    }
  }

  const utilization = (totalRequests / limit) * 100;
  const resetsAt = new Date(today);
  resetsAt.setDate(resetsAt.getDate() + 1);

  return makeSnapshot('gemini', {
    short: {
      utilization,
      resets_at: resetsAt.toISOString(),
      runway_ms: estimateRunway(utilization, resetsAt.getTime()),
    },
    long: {
      utilization: null, // we only use this for the text label
      text: `${totalRequests}/${limit}`,
    },
    raw: { totalRequests, limit, todaySeconds },
  });
}

/**
 * Parses concatenated JSON objects (often found in OTLP file exports).
 * @param {string} content 
 */
function parseConcatenatedJson(content) {
  const objects = [];
  let pos = 0;
  while (pos < content.length) {
    const chunk = content.slice(pos).trim();
    if (!chunk) break;
    
    try {
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;

      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{') depth++;
          else if (char === '}') {
            depth--;
            if (depth === 0) {
              end = i + 1;
              break;
            }
          }
        }
      }

      if (end === -1) break;

      objects.push(JSON.parse(chunk.slice(0, end)));
      pos += chunk.slice(0, end).length + (content.slice(pos).length - chunk.length);
    } catch (e) {
      // If we fail to parse, try to skip to the next {
      const nextOpen = chunk.indexOf('{', 1);
      if (nextOpen === -1) break;
      pos += nextOpen;
    }
  }
  return objects;
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
  if (utilization <= 0) return msLeftInWindow;

  return Math.round((remaining / utilization) * (24 * 60 * 60 * 1000 - msLeftInWindow));
}

module.exports = { fetchQuota };
