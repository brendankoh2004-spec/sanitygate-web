import { runPipeline, Providers } from '../lib/pipeline';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import { LLMProvider, LLMError } from '../lib/llm/provider';
import { extractJson } from '../lib/llm/openrouter';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`OK   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

const REQUEST = 'Write a Q3 summary. The source states: Management has not established a causal relationship between the campaign and the division\'s revenue growth. No store expansion has been formally approved for Q4.';
const OUTPUT = 'Based on the campaign\'s strong performance, the campaign appears to have contributed significantly to Q3 sales growth. The division has plans to open additional stores during Q4.';

class ExtractionFailsButEvaluatorWorks implements LLMProvider {
  name = 'fake'; model = 'x';
  calls: string[] = [];
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage || 'unknown';
    this.calls.push(stage);
    if (stage === 'extraction') throw new LLMError('invalid_response', 'simulated truncated extraction response');
    if (stage === 'verifier') {
      return ([
        { verdict: 'confirmed', confidence: 0.9, reason: 'ok', suggestionOk: false },
        { verdict: 'confirmed', confidence: 0.9, reason: 'ok', suggestionOk: false },
      ] as unknown) as T;
    }
    // evaluator
    return ({
      issues: [
        { type: 'unsupported_claim', severity: 'critical', confidence: 0.85, generated_text: 'the campaign appears to have contributed significantly to Q3 sales growth', source_evidence: 'Management has not established a causal relationship between the campaign and the division\'s revenue growth', requirement: '', explanation: 'Source explicitly says no causal link has been established.', suggested_change: '' },
        { type: 'contradiction', severity: 'critical', confidence: 0.88, generated_text: 'plans to open additional stores during Q4', source_evidence: 'No store expansion has been formally approved for Q4', requirement: '', explanation: 'Direct contradiction with the source.', suggested_change: '' },
      ],
    } as unknown) as T;
  }
}

async function testExtractionNonFatal() {
  const provider = new ExtractionFailsButEvaluatorWorks();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Extraction failure does not set semanticError', result.semanticError === null, String(result.semanticError));
  check('Extraction failure -> extractedRequirements is empty but pipeline continues', result.extractedRequirements.length === 0);
  check('Evaluator still ran and found the causal-claim issue', result.findings.some(f => f.type === 'unsupported_claim'), JSON.stringify(result.findings.map(f => f.type)));
  check('Evaluator still ran and found the store-expansion contradiction', result.findings.some(f => f.type === 'contradiction'), JSON.stringify(result.findings.map(f => f.type)));
  check('Both calls attempted in the right order', provider.calls[0] === 'extraction' && provider.calls.includes('evaluator') && provider.calls.includes('verifier'), provider.calls.join(','));
}

class EvaluatorFailsProvider implements LLMProvider {
  name = 'fake'; model = 'x';
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    throw new LLMError('rate_limited', 'simulated rate limit on evaluator');
  }
}

async function testEvaluatorFailureNeverClean() {
  const provider = new EvaluatorFailsProvider();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Evaluator failure sets semanticError (never silently clean)', result.semanticError === 'rate_limited', String(result.semanticError));
  check('Evaluator failure -> zero semantic findings (deterministic-only, honestly)', result.findings.every(f => f.source === 'deterministic'));
}

function testJsonSalvage() {
  // Simulates a response truncated mid-way through the second issue
  // object (max_tokens cutoff) — the exact failure mode reported live.
  const truncated = `{"issues": [{"type":"contradiction","severity":"critical","confidence":0.9,"generated_text":"plans to open additional stores","source_evidence":"No store expansion has been formally approved","requirement":"","explanation":"contradiction","suggested_change":""},{"type":"unsupported_claim","severity":"critical","confidence":0.8,"generated_text":"contributed significan`;
  const result = extractJson(truncated);
  check('Salvage recovers the complete object before truncation', !!result && result.salvaged === true, JSON.stringify(result));
  if (result) {
    const issues = (result.value as any).issues;
    check('Salvage keeps exactly the one complete issue, discards the truncated one', Array.isArray(issues) && issues.length === 1 && issues[0].type === 'contradiction', JSON.stringify(issues));
  }

  const cleanArray = '[{"verdict":"confirmed","confidence":0.9,"reason":"ok","suggestionOk":false}]';
  const r2 = extractJson(cleanArray);
  check('Clean bare array still parses normally (not salvaged)', !!r2 && r2.salvaged === false && Array.isArray(r2.value));

  const fencedWithProse = 'Sure, here is the analysis:\n```json\n{"issues":[]}\n```\nLet me know if you need more.';
  const r3 = extractJson(fencedWithProse);
  check('Fenced + prose-wrapped clean JSON still parses', !!r3 && (r3.value as any).issues.length === 0);

  const garbage = 'I cannot help with that request.';
  const r4 = extractJson(garbage);
  check('Genuine garbage still correctly returns null (not a false salvage)', r4 === null);
}

async function main() {
  await testExtractionNonFatal();
  await testEvaluatorFailureNeverClean();
  testJsonSalvage();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
