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

  // Find the latest timestamp in the file to establish "now"
  let maxTs = 0;
  for (const obj of objects) {
    const ts = Array.isArray(obj.startTime) ? obj.startTime[0] : obj.startTime;
    if (ts && ts > maxTs) maxTs = ts;
  }

  // If no timestamps found, fall back to system clock
  const nowSeconds = maxTs || Math.floor(Date.now() / 1000);
  // Boundary: 24 hours before the latest event
  const windowStartSeconds = nowSeconds - (24 * 60 * 60);

  // For the display reset time, use the day boundary of the latest event
  const latestDate = new Date(nowSeconds * 1000);
  const today = new Date(latestDate.getFullYear(), latestDate.getMonth(), latestDate.getDate());
  const resetsAt = new Date(today);
  resetsAt.setDate(resetsAt.getDate() + 1);

  let totalRequests = 0;
  let flashRequests = 0;
  let proRequests = 0;

  for (const obj of objects) {
    const tsParts = obj.startTime;
    const ts = Array.isArray(tsParts) ? tsParts[0] : tsParts;

    if (ts && ts >= windowStartSeconds) {
      const attrs = obj.attributes || {};
      const modelName = attrs['gen_ai.request.model'] || attrs['model'] || '';
      
      // We count every span that has a model attribute as a request
      if (modelName) {
        totalRequests++;
        if (modelName.toLowerCase().includes('flash')) {
          flashRequests++;
        } else {
          proRequests++;
        }
      }
    }
  }

  // Calculate utilization based on the most restrictive bottleneck
  let utilization = 0;
  let displayLimit = 1500;
  
  if (proRequests > 0 || (proRequests === 0 && flashRequests === 0)) {
    utilization = (proRequests / 1500) * 100;
    displayLimit = 1500;
  } else {
    utilization = (flashRequests / 1000000) * 100;
    displayLimit = 1000000;
  }

  return makeSnapshot('gemini', {
    short: {
      utilization,
      resets_at: resetsAt.toISOString(),
      runway_ms: estimateRunway(utilization, resetsAt.getTime()),
    },
    long: {
      utilization: null,
      text: `${totalRequests}/${displayLimit}`,
    },
    raw: { totalRequests, proRequests, flashRequests, limit: displayLimit, windowStartSeconds },
  });
}

/**
 * Parses concatenated JSON objects (often found in OTLP file exports).
 * @param {string} content 
 */
function parseConcatenatedJson(content) {
  const objects = [];
  let pos = 0;
  
  // Clean up common OTLP file artifacts
  const cleanContent = content.trim();
  if (!cleanContent) return [];

  while (pos < cleanContent.length) {
    // Find the start of the next JSON object
    const start = cleanContent.indexOf('{', pos);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < cleanContent.length; i++) {
      const char = cleanContent[i];
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

    if (end !== -1) {
      try {
        const jsonStr = cleanContent.slice(start, end);
        objects.push(JSON.parse(jsonStr));
        pos = end;
      } catch (e) {
        pos = start + 1; // Skip this '{' and try again
      }
    } else {
      break; // Unclosed object
    }
  }
  return objects;
}

/**
 * @param {number} utilization
 * @param {number} resetMs
 */
function estimateRunway(utilization, resetMs) {
  if (utilization == null) return 0;
  const msLeftInWindow = resetMs - Date.now();
  if (msLeftInWindow <= 0) return 0;
  if (utilization <= 0) return msLeftInWindow;
  if (utilization >= 100) return 0;

  const remaining = 100 - utilization;
  return Math.round((remaining / utilization) * (24 * 60 * 60 * 1000 - msLeftInWindow));
}

module.exports = { fetchQuota };
