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
      return ({
        verdicts: [
          { verdict: 'confirmed', confidence: 0.9, reason: 'ok', suggestionOk: false },
          { verdict: 'confirmed', confidence: 0.9, reason: 'ok', suggestionOk: false },
        ],
        additional_findings: [],
      } as unknown) as T;
    }
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
  check('checkStatus reflects real findings, not incomplete', result.checkStatus === 'findings', result.checkStatus);
  check('Extraction, evaluator, and verifier all attempted', provider.calls[0] === 'extraction' && provider.calls.includes('evaluator') && provider.calls.includes('verifier'), provider.calls.join(','));
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
  check('checkStatus is check_incomplete, never clean, on evaluator failure', result.checkStatus === 'check_incomplete', result.checkStatus);
}

// --- Part 3/7: the verifier's independent-scan role. Evaluator returns
// ZERO candidates (a full miss); the verifier's own re-inspection is what
// must catch it. This is the exact architectural gap identified in the
// live Q3 false-clean-result failure. ---
class EvaluatorMissesVerifierCatches implements LLMProvider {
  name = 'fake'; model = 'x';
  verifierWasCalled = false;
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    if (stage === 'evaluator') return ({ issues: [] } as unknown) as T; // the miss
    if (stage === 'verifier') {
      this.verifierWasCalled = true;
      return ({
        verdicts: [], // nothing to verify, evaluator found nothing
        additional_findings: [
          { type: 'contradiction', severity: 'critical', confidence: 0.85, generated_text: 'plans to open additional stores during Q4', source_evidence: 'No store expansion has been formally approved for Q4', requirement: '', explanation: 'Direct contradiction found on independent re-check.', suggested_change: '' },
        ],
      } as unknown) as T;
    }
    throw new Error('unexpected stage ' + stage);
  }
}

async function testVerifierCatchesEvaluatorMiss() {
  const provider = new EvaluatorMissesVerifierCatches();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Verifier is called even when evaluator finds zero issues', provider.verifierWasCalled, String(provider.verifierWasCalled));
  check('Verifier-discovered finding surfaces in the final result', result.findings.some(f => f.type === 'contradiction'), JSON.stringify(result.findings));
  const found = result.findings.find(f => f.type === 'contradiction');
  check('Verifier-only finding is marked needsReview (single-sourced, honest about confidence)', !!found && found.needsReview === true, JSON.stringify(found));
  check('This is exactly the scenario that produced the live false-clean result — now produces a finding instead', result.findings.length > 0);
}

// --- Verifier rejects an evaluator false positive ---
class VerifierRejectsFalsePositive implements LLMProvider {
  name = 'fake'; model = 'x';
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    if (stage === 'evaluator') return ({
      issues: [
        { type: 'contradiction', severity: 'critical', confidence: 0.7, generated_text: 'plans to open additional stores during Q4', source_evidence: 'No store expansion has been formally approved for Q4', requirement: '', explanation: 'evaluator thinks this contradicts the source', suggested_change: '' },
      ],
    } as unknown) as T;
    if (stage === 'verifier') return ({
      verdicts: [{ verdict: 'rejected', confidence: 0.1, reason: 'On closer inspection this is not actually a contradiction.', suggestionOk: false }],
      additional_findings: [],
    } as unknown) as T;
    throw new Error('unexpected stage ' + stage);
  }
}

async function testVerifierRejectsFalsePositive() {
  const provider = new VerifierRejectsFalsePositive();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Verifier-rejected (low confidence) finding is suppressed entirely', result.findings.filter(f => f.source === 'semantic').length === 0, JSON.stringify(result.findings));
}

function testJsonSalvage() {
  const truncated = `{"issues": [{"type":"contradiction","severity":"critical","confidence":0.9,"generated_text":"plans to open additional stores","source_evidence":"No store expansion has been formally approved","requirement":"","explanation":"contradiction","suggested_change":""},{"type":"unsupported_claim","severity":"critical","confidence":0.8,"generated_text":"contributed significan`;
  const result = extractJson(truncated);
  check('Salvage recovers the complete object before truncation', !!result && result.salvaged === true, JSON.stringify(result));
  if (result) {
    const issues = (result.value as any).issues;
    check('Salvage keeps exactly the one complete issue, discards the truncated one', Array.isArray(issues) && issues.length === 1 && issues[0].type === 'contradiction', JSON.stringify(issues));
  }

  const cleanVerifierShape = '{"verdicts":[{"verdict":"confirmed","confidence":0.9,"reason":"ok","suggestionOk":false}],"additional_findings":[]}';
  const r2 = extractJson(cleanVerifierShape);
  check('Clean verifier-shape object still parses normally (not salvaged)', !!r2 && r2.salvaged === false && Array.isArray((r2.value as any).verdicts));

  const fencedWithProse = 'Sure, here is the analysis:\n```json\n{"issues":[]}\n```\nLet me know if you need more.';
  const r3 = extractJson(fencedWithProse);
  check('Fenced + prose-wrapped clean JSON still parses', !!r3 && (r3.value as any).issues.length === 0);

  const garbage = 'I cannot help with that request.';
  const r4 = extractJson(garbage);
  check('Genuine garbage still correctly returns null (not a false salvage)', r4 === null);
}

// --- Verifier call itself throws (network/timeout) — evaluator
// candidates must be kept as unverified, not dropped. ---
class VerifierCallThrows implements LLMProvider {
  name = 'fake'; model = 'x';
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    if (stage === 'evaluator') return ({
      issues: [
        { type: 'contradiction', severity: 'critical', confidence: 0.8, generated_text: 'plans to open additional stores during Q4', source_evidence: 'No store expansion has been formally approved for Q4', requirement: '', explanation: 'contradiction', suggested_change: '' },
      ],
    } as unknown) as T;
    if (stage === 'verifier') throw new LLMError('timeout', 'simulated verifier timeout');
    throw new Error('unexpected stage ' + stage);
  }
}

async function testVerifierCallFailureKeepsCandidatesUnverified() {
  const provider = new VerifierCallThrows();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Verifier call failure does NOT set semanticError (evaluator itself succeeded)', result.semanticError === null, String(result.semanticError));
  check('Evaluator candidate survives as an unverified/needs-review finding, not dropped', result.findings.some(f => f.type === 'contradiction'), JSON.stringify(result.findings));
  const found = result.findings.find(f => f.type === 'contradiction');
  check('Unverified finding is marked needsReview (verifier never confirmed it)', !!found && found.needsReview === true);
}

// --- Evidence mismatch: the evaluator claims a quote that does not
// actually exist in the request/output. Must be suppressed or
// downgraded by lib/evidence.ts, never shown as fabricated fact. ---
class FabricatedEvidenceProvider implements LLMProvider {
  name = 'fake'; model = 'x';
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    if (stage === 'evaluator') return ({
      issues: [
        {
          type: 'contradiction', severity: 'critical', confidence: 0.9,
          generated_text: 'this exact sentence does not appear anywhere in the output text',
          source_evidence: 'nor does this quote exist anywhere in the request text',
          requirement: '', explanation: 'fabricated finding', suggested_change: '',
        },
      ],
    } as unknown) as T;
    if (stage === 'verifier') return ({ verdicts: [{ verdict: 'confirmed', confidence: 0.95, reason: 'looks right to me', suggestionOk: false }], additional_findings: [] } as unknown) as T;
    throw new Error('unexpected stage ' + stage);
  }
}

async function testFabricatedEvidenceSuppressed() {
  const provider = new FabricatedEvidenceProvider();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  // generated_text doesn't exist in OUTPUT at all -> validateEvidence.suppress -> dropped entirely,
  // even though the verifier (also fooled) "confirmed" it with high confidence.
  check('Finding with fabricated generated_text is suppressed regardless of verifier confirmation', result.findings.filter(f => f.source === 'semantic').length === 0, JSON.stringify(result.findings));
}

// --- THE production-regression scenario: evaluator fails outright
// (invalid_response, e.g. a bad model draw from openrouter/free's
// randomized router burning its token budget on hidden reasoning and
// returning empty content), but the verifier's independent re-scan
// (Job 2) is a SEPARATE model call that succeeds and catches something
// anyway. Before this fix, evaluator failure short-circuited the whole
// runSemanticLayer function and the verifier never even got a chance to
// run — this is the gap this test targets directly. ---
class EvaluatorFailsButVerifierIndependentlyCatches implements LLMProvider {
  name = 'fake'; model = 'x';
  calls: string[] = [];
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    this.calls.push(stage);
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    if (stage === 'evaluator') throw new LLMError('invalid_response', 'simulated empty response, finish_reason=length');
    if (stage === 'verifier') {
      return ({
        verdicts: [],
        additional_findings: [
          { type: 'contradiction', severity: 'critical', confidence: 0.85, generated_text: 'plans to open additional stores during Q4', source_evidence: 'No store expansion has been formally approved for Q4', requirement: '', explanation: 'Direct contradiction found on independent re-check.', suggested_change: '' },
        ],
      } as unknown) as T;
    }
    throw new Error('unexpected stage ' + stage);
  }
}

async function testVerifierIndependentScanRunsWhenEvaluatorFails() {
  const provider = new EvaluatorFailsButVerifierIndependentlyCatches();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Verifier stage is still attempted after evaluator fails outright (not just on zero issues)', provider.calls.includes('verifier'), provider.calls.join(','));
  check('semanticError still reflects the evaluator failure (never silently clean)', result.semanticError === 'invalid_response', String(result.semanticError));
  check('checkStatus is still check_incomplete (evaluator failure never becomes clean, regardless of what the verifier found)', result.checkStatus === 'check_incomplete', result.checkStatus);
  check('But the verifier\'s independent catch still surfaces as a finding instead of being silently lost', result.findings.some(f => f.type === 'contradiction'), JSON.stringify(result.findings));
  const found = result.findings.find(f => f.type === 'contradiction');
  check('Verifier-only finding is marked needsReview', !!found && found.needsReview === true);
}

// --- One bounded retry, only for invalid_response: first evaluator call
// hits the bad-model-draw signature, second call (typically routed to a
// different free model) succeeds normally. ---
class EvaluatorFailsOnceThenSucceeds implements LLMProvider {
  name = 'fake'; model = 'x';
  evaluatorAttempts = 0;
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    if (stage === 'evaluator') {
      this.evaluatorAttempts++;
      if (this.evaluatorAttempts === 1) throw new LLMError('invalid_response', 'simulated empty response on first draw');
      return ({
        issues: [
          { type: 'contradiction', severity: 'critical', confidence: 0.88, generated_text: 'plans to open additional stores during Q4', source_evidence: 'No store expansion has been formally approved for Q4', requirement: '', explanation: 'Direct contradiction with the source.', suggested_change: '' },
        ],
      } as unknown) as T;
    }
    if (stage === 'verifier') return ({ verdicts: [{ verdict: 'confirmed', confidence: 0.9, reason: 'ok', suggestionOk: false }], additional_findings: [] } as unknown) as T;
    throw new Error('unexpected stage ' + stage);
  }
}

async function testEvaluatorRetryRecoversFromSingleBadDraw() {
  const provider = new EvaluatorFailsOnceThenSucceeds();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Evaluator was retried exactly once after invalid_response', provider.evaluatorAttempts === 2, String(provider.evaluatorAttempts));
  check('Retry succeeding means no semanticError at all', result.semanticError === null, String(result.semanticError));
  check('Retry succeeding means the real finding surfaces normally', result.findings.some(f => f.type === 'contradiction'), JSON.stringify(result.findings));
  check('checkStatus reflects the recovered findings, not check_incomplete', result.checkStatus === 'findings', result.checkStatus);
}

// --- Retry must NOT fire for timeout/rate_limited — those are not the
// "bad model draw emitted garbage" signature, and retrying them just
// burns more of an already-tight time budget for low odds of success. ---
class EvaluatorTimesOutOnce implements LLMProvider {
  name = 'fake'; model = 'x';
  evaluatorAttempts = 0;
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    const stage = opts?.stage;
    if (stage === 'extraction') return ({ requirements: [] } as unknown) as T;
    if (stage === 'evaluator') { this.evaluatorAttempts++; throw new LLMError('timeout', 'simulated timeout'); }
    if (stage === 'verifier') return ({ verdicts: [], additional_findings: [] } as unknown) as T;
    throw new Error('unexpected stage ' + stage);
  }
}

async function testEvaluatorTimeoutIsNotRetried() {
  const provider = new EvaluatorTimesOutOnce();
  const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
  const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
  check('Evaluator timeout is attempted exactly once, not retried', provider.evaluatorAttempts === 1, String(provider.evaluatorAttempts));
  check('semanticError reflects the timeout', result.semanticError === 'timeout', String(result.semanticError));
}

// --- Pipeline time budget: when almost no budget remains, a stage must
// be SKIPPED gracefully (never attempted) rather than fired off with a
// near-zero timeout, and this must degrade the same honest way any other
// stage failure does (check_incomplete), never a silent clean result and
// never an unhandled hang. ---
class ShouldNeverBeCalledProvider implements LLMProvider {
  name = 'fake'; model = 'x';
  calls: string[] = [];
  async completeJSON<T>(prompt: string, opts?: any): Promise<T> {
    this.calls.push(opts?.stage);
    throw new Error('this provider should never actually be called when the budget is exhausted');
  }
}

async function testPipelineBudgetExhaustionSkipsGracefully() {
  const prevBudget = process.env.PIPELINE_BUDGET_MS;
  process.env.PIPELINE_BUDGET_MS = '0'; // no budget at all remains from t0
  try {
    const provider = new ShouldNeverBeCalledProvider();
    const providers: Providers = { extraction: provider, evaluator: provider, verifier: provider };
    const result = await runPipeline(providers, REQUEST, OUTPUT, { ...DEFAULT_ADDITIONAL });
    check('No provider call is actually attempted once the budget is exhausted', provider.calls.length === 0, provider.calls.join(','));
    check('Budget exhaustion degrades to check_incomplete, not a hang or a crash', result.checkStatus === 'check_incomplete', result.checkStatus);
    check('Budget exhaustion is reported as a timeout-class semanticError', result.semanticError === 'timeout', String(result.semanticError));
    check('No findings are fabricated when nothing actually ran', result.findings.filter(f => f.source === 'semantic').length === 0);
  } finally {
    if (prevBudget === undefined) delete process.env.PIPELINE_BUDGET_MS;
    else process.env.PIPELINE_BUDGET_MS = prevBudget;
  }
}

async function main() {
  await testExtractionNonFatal();
  await testEvaluatorFailureNeverClean();
  await testVerifierCatchesEvaluatorMiss();
  await testVerifierRejectsFalsePositive();
  await testVerifierCallFailureKeepsCandidatesUnverified();
  await testFabricatedEvidenceSuppressed();
  await testVerifierIndependentScanRunsWhenEvaluatorFails();
  await testEvaluatorRetryRecoversFromSingleBadDraw();
  await testEvaluatorTimeoutIsNotRetried();
  await testPipelineBudgetExhaustionSkipsGracefully();
  testJsonSalvage();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
