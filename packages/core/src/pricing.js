/**
 * API Equivalent Cost Estimator
 *
 * Estimates what a given utilization % would cost if the user had been
 * paying for API access instead of a Pro/Max subscription.
 *
 * IMPORTANT: All values here are estimates. Token capacity per window is
 * reverse-engineered from community usage observations, not official specs.
 * Prices are hardcoded from the providers' published pricing pages and should
 * be refreshed periodically (see PRICES_LAST_UPDATED).
 *
 * Gemini and Copilot are intentionally excluded:
 *   - Gemini: no usable endpoint for account-level usage on consumer plans
 *   - Copilot: seat-based pricing doesn't map to per-token API cost
 */

const PRICES_LAST_UPDATED = '2026-04-20';

/**
 * Per-agent plan tier definitions.
 *
 * capacity_tokens: estimated max tokens per short window (5 hr) at 100% utilization.
 *   Derived from community-observed message limits × average tokens/message.
 *   Claude Pro: ~45 msgs × 2K avg tokens = ~90K
 *   Claude Max 5x: 5× Pro = ~450K
 *   Claude Max 20x: 20× Pro = ~1.8M
 *   Codex Plus (GPT-4o): ~40 msgs/3hr window × 2K tokens = ~80K (mapped to utilization %)
 *   Codex Pro: 5× Plus estimate = ~400K
 *
 * blended_price_per_mtok: weighted average of input + output token price (USD per million tokens).
 *   Assumes a rough 50/50 input/output split on each message.
 *   Claude Sonnet 4.6: $3 input / $15 output → $9/MTok blended
 *   Claude Opus 4.6: $15 input / $75 output → $45/MTok blended
 *   Pro plan = mostly Sonnet usage → $9/MTok
 *   Max plan = heavier Opus usage → blended ~$18/MTok
 *   Codex (GPT-4o): $2.50 input / $10 output → $6.25/MTok blended
 *   Codex Pro (o3-heavy): $10 input / $40 output → $25/MTok blended
 */
const PLAN_TIERS = {
  claude: {
    pro: {
      label: 'Pro ($20/mo)',
      capacity_tokens: 90_000,
      blended_price_per_mtok: 9.0,
    },
    max5: {
      label: 'Max 5× ($100/mo)',
      capacity_tokens: 450_000,
      blended_price_per_mtok: 18.0,
    },
    max20: {
      label: 'Max 20× ($200/mo)',
      capacity_tokens: 1_800_000,
      blended_price_per_mtok: 18.0,
    },
  },
  codex: {
    plus: {
      label: 'Plus ($20/mo)',
      capacity_tokens: 80_000,
      blended_price_per_mtok: 6.25,
    },
    pro: {
      label: 'Pro ($200/mo)',
      capacity_tokens: 400_000,
      blended_price_per_mtok: 25.0,
    },
  },
};

const DEFAULT_TIERS = {
  claude: 'pro',
  codex: 'plus',
};

/**
 * Estimate API-equivalent cost for a given agent + utilization.
 *
 * @param {string} agent        - 'claude' | 'codex'
 * @param {number} utilization  - 0–100
 * @param {string} [tier]       - plan tier key (e.g. 'pro', 'max5'); defaults per agent
 * @returns {{ cost: number, label: string, tier: string } | null}
 *   cost:  USD estimate (e.g. 0.42)
 *   label: display string (e.g. '~$0.42 est.')
 *   tier:  resolved tier key
 */
function estimateCost(agent, utilization, tier) {
  const agentTiers = PLAN_TIERS[agent];
  if (!agentTiers) return null;
  if (utilization == null || isNaN(utilization)) return null;

  const resolvedTier = tier && agentTiers[tier] ? tier : DEFAULT_TIERS[agent];
  const plan = agentTiers[resolvedTier];
  if (!plan) return null;

  const tokensUsed = (utilization / 100) * plan.capacity_tokens;
  const cost = (tokensUsed / 1_000_000) * plan.blended_price_per_mtok;

  return {
    cost,
    label: cost < 0.01 ? '<$0.01 est.' : `~$${cost.toFixed(2)} est.`,
    tier: resolvedTier,
  };
}

/**
 * Return available tier options for a given agent.
 * Useful for populating settings dropdowns.
 *
 * @param {string} agent
 * @returns {{ key: string, label: string }[]}
 */
function tierOptions(agent) {
  const tiers = PLAN_TIERS[agent];
  if (!tiers) return [];
  return Object.entries(tiers).map(([key, { label }]) => ({ key, label }));
}

module.exports = { estimateCost, tierOptions, PLAN_TIERS, DEFAULT_TIERS, PRICES_LAST_UPDATED };
