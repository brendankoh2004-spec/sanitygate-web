import { OpenRouterProvider, extractJson, DEFAULT_MODEL } from '../lib/llm/openrouter';
import { LLMError } from '../lib/llm/provider';
import { getProvider } from '../lib/llm';
import { check, done } from './helpers';

process.env.OPENROUTER_API_KEY = 'test-key';
delete process.env.OPENROUTER_MODEL; delete process.env.EVALUATOR_MODEL; delete process.env.VERIFIER_MODEL; delete process.env.EXTRACTION_MODEL;

const realFetch = globalThis.fetch;
type Handler = (url: string, init: any) => Promise<any>;
function mockFetch(h: Handler) { (globalThis as any).fetch = h; }
const chat = (content: unknown, finish = 'stop') => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }) });
const raw = (status: number, body = '') => ({ status, text: async () => body });

async function expectErr(p: Promise<unknown>): Promise<LLMError | null> {
  try { await p; return null; } catch (e) { return e instanceof LLMError ? e : new LLMError('upstream_error', String(e)); }
}

async function main() {
  // ---- model selection: minimal + opaque ----
  check('model default is the OpenRouter router; no model env is required', new OpenRouterProvider().model === DEFAULT_MODEL && DEFAULT_MODEL === 'openrouter/free');
  process.env.OPENROUTER_MODEL = 'some/any-model:whatever';
  check('OPENROUTER_MODEL is passed through verbatim (opaque)', new OpenRouterProvider().model === 'some/any-model:whatever');
  process.env.VERIFIER_MODEL = 'other/verifier';
  check('per-stage override is optional and independent', getProvider('verifier').model === 'other/verifier' && getProvider('evaluator').model === 'some/any-model:whatever' && getProvider('extraction').model === 'some/any-model:whatever');
  process.env.EVALUATOR_MODEL = 'eval/model';
  check('extraction follows evaluator override unless set', getProvider('extraction').model === 'eval/model');
  delete process.env.OPENROUTER_API_KEY;
  let threw = false; try { new OpenRouterProvider(); } catch { threw = true; }
  check('missing API key throws at construction (route degrades to an incomplete review)', threw);
  process.env.OPENROUTER_API_KEY = 'test-key'; delete process.env.EVALUATOR_MODEL; delete process.env.VERIFIER_MODEL;
  const p = new OpenRouterProvider();

  // ---- success ----
  mockFetch(async () => chat('{"ok":true}'));
  let r = await p.completeJSON<any>('x', { timeoutMs: 1000 });
  check('success: parsed JSON, not partial', r.value.ok === true && r.partial === false);
  mockFetch(async () => chat('Sure!\n```json\n{"ok":1}\n```'));
  r = await p.completeJSON<any>('x');
  check('success: fenced + prose-wrapped JSON parses, not partial', r.value.ok === 1 && r.partial === false);

  // ---- empty / malformed ----
  mockFetch(async () => chat('', 'length'));
  check('empty content (finish_reason=length) -> invalid_response', (await expectErr(p.completeJSON('x')))?.code === 'invalid_response');
  mockFetch(async () => ({ status: 200, text: async () => JSON.stringify({ choices: [] }) }));
  check('no choices -> invalid_response', (await expectErr(p.completeJSON('x')))?.code === 'invalid_response');
  mockFetch(async () => raw(200, 'not json at all'));
  check('non-JSON HTTP body -> invalid_response', (await expectErr(p.completeJSON('x')))?.code === 'invalid_response');
  mockFetch(async () => chat('I cannot help with that.'));
  check('malformed (prose) model output -> invalid_response', (await expectErr(p.completeJSON('x')))?.code === 'invalid_response');
  mockFetch(async () => chat('{"judgments":[{"id":"R1","verdict":"satisfied"},{"id":"R2","verd'));
  check('truncated output: a repaired prefix is returned but flagged partial', await p.completeJSON<any>('x').then(v => v.partial === true && v.value.judgments.length === 1 && v.value.judgments[0].id === 'R1'));
  mockFetch(async () => chat('{"a":1', 'length'));
  check('truncated with nothing complete to keep -> invalid_response', (await expectErr(p.completeJSON('x')))?.code === 'invalid_response');

  // ---- HTTP failures ----
  mockFetch(async () => raw(429, '{}'));
  check('HTTP 429 -> rate_limited', (await expectErr(p.completeJSON('x')))?.code === 'rate_limited');
  mockFetch(async () => raw(502, 'bad gateway'));
  check('HTTP 5xx -> upstream_error', (await expectErr(p.completeJSON('x')))?.code === 'upstream_error');
  mockFetch(async () => raw(401, '{"error":"no auth"}'));
  check('HTTP 401 -> upstream_error', (await expectErr(p.completeJSON('x')))?.code === 'upstream_error');
  mockFetch(async () => raw(200, JSON.stringify({ error: { code: 429, message: 'slow down' } })));
  check('HTTP 200 carrying a provider 429 error body -> rate_limited', (await expectErr(p.completeJSON('x')))?.code === 'rate_limited');
  mockFetch(async () => raw(200, JSON.stringify({ error: { code: 502, message: 'provider down' } })));
  check('HTTP 200 carrying a provider error body -> upstream_error (not "empty")', (await expectErr(p.completeJSON('x')))?.code === 'upstream_error');
  mockFetch(async () => { throw new TypeError('fetch failed'); });
  check('network failure -> upstream_error', (await expectErr(p.completeJSON('x')))?.code === 'upstream_error');

  // ---- reasoning fallback ----
  const bodies: any[] = [];
  mockFetch(async (_u, init) => { const b = JSON.parse(init.body); bodies.push(b); return 'reasoning' in b ? raw(400, 'unknown parameter reasoning') : chat('{"ok":2}'); });
  r = await p.completeJSON<any>('x');
  check('HTTP 400 with the optional reasoning field -> retried once without it, then succeeds', r.value.ok === 2 && bodies.length === 2 && 'reasoning' in bodies[0] && !('reasoning' in bodies[1]));
  check('request never sends model-specific response_format', !('response_format' in bodies[0]));

  // ---- timeouts (headers AND body) ----
  const abortable = (ms: number, result: () => any): Handler => (_u, init) => new Promise((res, rej) => {
    const t = setTimeout(() => res(result()), ms);
    init.signal.addEventListener('abort', () => { clearTimeout(t); const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });
  mockFetch(abortable(2000, () => chat('{"ok":1}')));
  let t0 = Date.now();
  check('slow response headers -> timeout at timeoutMs', (await expectErr(p.completeJSON('x', { timeoutMs: 150 })))?.code === 'timeout' && Date.now() - t0 < 1000);
  mockFetch(async (_u, init) => ({ status: 200, text: () => new Promise((_res, rej) => init.signal.addEventListener('abort', () => { const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e); })) }));
  t0 = Date.now();
  check('stalled response BODY -> timeout (old code cleared its timer before reading the body)', (await expectErr(p.completeJSON('x', { timeoutMs: 150 })))?.code === 'timeout' && Date.now() - t0 < 1000);

  // ---- extractJson unit checks over every response shape used by the app ----
  const shapes: [string, string, (v: any) => boolean][] = [
    ['requirements', '{"items":[{"kind":"fact","quote":"a"},{"kind":"instruction","quote":"b"},{"kind":"fa', v => v.items.length === 2],
    ['judgments+unrequested', '{"judgments":[{"id":"R1","verdict":"satisfied"}],"unrequested":[{"output_quote":"q","reason":"r"},{"output_qu', v => v.judgments.length === 1 && v.unrequested.length === 1],
    ['verifications', '{"verifications":[{"cid":"C1","verdict":"confirmed","reason":"has } brace and \\"quote\\""},{"cid":"C2","ver', v => v.verifications.length === 1 && /brace/.test(v.verifications[0].reason)],
    ['scan', '{"findings":[{"category":"omission","fix":{"original":"a","replacement":"b"}},{"category":"x","fix":{"orig', v => v.findings.length === 1 && v.findings[0].fix.replacement === 'b'],
  ];
  for (const [name, text, ok] of shapes) {
    const x = extractJson(text);
    check(`extractJson salvage keeps complete items only (${name})`, !!x && x.salvaged && ok(x.value), JSON.stringify(x));
  }
  check('extractJson: garbage -> null', extractJson('nope') === null && extractJson('') === null);
  check('extractJson: strict parse is not marked salvaged', extractJson('{"a":1}')?.salvaged === false);

  (globalThis as any).fetch = realFetch;
  done();
}
main();
