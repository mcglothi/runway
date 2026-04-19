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
    for (const sm of obj.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        for (const dp of m.dataPoints || []) {
          const ts = Array.isArray(dp.startTime) ? dp.startTime[0] : dp.startTime;
          if (ts > maxTs) maxTs = ts;
        }
      }
    }
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
    for (const sm of obj.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        if (m.descriptor?.name === 'gemini_cli.api.request.count') {
          for (const dp of m.dataPoints || []) {
            // dp.startTime is [seconds, nanoseconds]
            const tsParts = dp.startTime;
            const ts = Array.isArray(tsParts) ? tsParts[0] : tsParts;

            if (ts && ts >= windowStartSeconds) {
              const val = (dp.value || 0);
              totalRequests += val;
              
              // Attribute to model if possible (OTLP attributes object)
              let modelName = '';
              const attrs = dp.attributes || {};
              
              if (Array.isArray(attrs)) {
                 const modelAttr = attrs.find(a => a.key === 'model' || a.key === 'model_name' || a.key === 'gen_ai.request.model');
                 modelName = modelAttr?.value?.stringValue || '';
              } else {
                 modelName = attrs['model'] || attrs['model_name'] || attrs['gen_ai.request.model'] || '';
              }

              if (modelName.toLowerCase().includes('flash')) {
                flashRequests += val;
              } else if (modelName.toLowerCase().includes('pro')) {
                proRequests += val;
              } else {
                // Default to pro as the bottleneck if unknown
                proRequests += val;
              }
            }
          }
        }
      }
    }
  }

  // Calculate utilization based on the most restrictive bottleneck
  // (Usually Pro, but if they only use Flash, use that)
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
      utilization: null, // we only use this for the text label
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
  if (utilization == null) return 0;
  const msLeftInWindow = resetMs - Date.now();
  if (msLeftInWindow <= 0) return 0;
  if (utilization <= 0) return msLeftInWindow;
  if (utilization >= 100) return 0;

  const remaining = 100 - utilization;
  return Math.round((remaining / utilization) * (24 * 60 * 60 * 1000 - msLeftInWindow));
}

module.exports = { fetchQuota };
