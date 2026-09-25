import { LLMProvider, LLMRole } from './provider';
import { OpenRouterProvider } from './openrouter';

/**
 * Model selection is intentionally minimal:
 *   OPENROUTER_MODEL  (optional) — passed through as an opaque string; defaults to the OpenRouter router.
 *   EVALUATOR_MODEL / VERIFIER_MODEL / EXTRACTION_MODEL (optional) — per-stage overrides.
 *     Pointing VERIFIER_MODEL at a different model than EVALUATOR_MODEL is the
 *     cheapest way to reduce correlated errors, but nothing requires it.
 * Nothing in the pipeline depends on a particular model behaving perfectly:
 * every response is validated, retried once where sensible, and any residual
 * failure surfaces as an "incomplete" review, never as "clean".
 */
export function getProvider(role: LLMRole = 'evaluator'): LLMProvider {
  const name = process.env.LLM_PROVIDER || 'openrouter';
  const envVar = { extraction: 'EXTRACTION_MODEL', evaluator: 'EVALUATOR_MODEL', verifier: 'VERIFIER_MODEL' }[role];
  const override = process.env[envVar] || (role === 'extraction' ? process.env.EVALUATOR_MODEL : undefined);
  switch (name) {
    case 'openrouter': return new OpenRouterProvider(override);
    default: throw new Error(`Unknown LLM_PROVIDER "${name}". Supported: openrouter.`);
  }
}

export * from './provider';
