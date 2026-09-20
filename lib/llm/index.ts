import { LLMProvider, LLMRole } from './provider';
import { OpenRouterProvider } from './openrouter';

const cache = new Map<string, LLMProvider>();

/**
 * Returns the configured LLMProvider for a given pipeline stage.
 * EVALUATOR_MODEL and VERIFIER_MODEL can be set independently (spec
 * section 24), so we can later test whether e.g. a stronger verifier
 * model reduces false positives without changing the evaluator. Both
 * fall back to OPENROUTER_MODEL if unset. Extraction shares the
 * evaluator's model unless EXTRACTION_MODEL is set explicitly.
 *
 * To add a new provider (Gemini, Anthropic, OpenAI...), implement
 * LLMProvider in lib/llm/<name>.ts and extend the switch below —
 * nothing in lib/pipeline.ts needs to change.
 */
export function getProvider(role: LLMRole = 'evaluator'): LLMProvider {
  const key = `${role}:${process.env.LLM_PROVIDER || 'openrouter'}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const providerName = process.env.LLM_PROVIDER || 'openrouter';
  const modelEnvVar = { extraction: 'EXTRACTION_MODEL', evaluator: 'EVALUATOR_MODEL', verifier: 'VERIFIER_MODEL' }[role];
  const modelOverride = process.env[modelEnvVar] || (role === 'extraction' ? process.env.EVALUATOR_MODEL : undefined);

  let provider: LLMProvider;
  switch (providerName) {
    case 'openrouter':
      provider = new OpenRouterProvider(modelOverride);
      break;
    default:
      throw new Error(`Unknown LLM_PROVIDER "${providerName}". Supported: openrouter.`);
  }
  cache.set(key, provider);
  return provider;
}

export * from './provider';
