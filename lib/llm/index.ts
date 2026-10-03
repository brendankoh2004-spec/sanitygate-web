import { LLMProvider, LLMRole } from './provider';
import { OpenRouterProvider } from './openrouter';

/**
 * Model selection is intentionally minimal:
 *   OPENROUTER_MODEL  (optional) — passed through as an opaque string; defaults to the OpenRouter router.
 *   DIRECT_MODEL / COVERAGE_MODEL / REVERSE_MODEL / ADJUDICATOR_MODEL (optional) — per-role overrides.
 *     Pointing the three reviewers at different model families is the cheapest way to
 *     decorrelate their blind spots, but nothing requires it.
 * Nothing in the pipeline depends on a particular model behaving perfectly:
 * every response is validated, retried once where sensible, and any residual
 * failure surfaces as an "incomplete" review, never as "clean".
 */
export function getProvider(role: LLMRole): LLMProvider {
  const name = process.env.LLM_PROVIDER || 'openrouter';
  const override = process.env[`${role.toUpperCase()}_MODEL`] || undefined;
  switch (name) {
    case 'openrouter': return new OpenRouterProvider(override);
    default: throw new Error(`Unknown LLM_PROVIDER "${name}". Supported: openrouter.`);
  }
}

export * from './provider';
