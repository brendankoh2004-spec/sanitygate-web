/**
 * Tests for the streaming check service (lib/checkService.ts) and the
 * NDJSON stream helpers (lib/stream.ts) used by app/api/check/route.ts.
 * Covers spec section 9 (progress events use product language, not
 * pipeline stage names) and section 6 (persistence failures never hide a
 * result from the user, and an unexpected crash never silently succeeds).
 */
import { processCheck, CheckDeps } from '../lib/checkService';
import { createNdjsonParser, encodeEvent, StreamEvent } from '../lib/stream';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import { Providers } from '../lib/pipeline';
import { check, done, Scripted, allOf } from './helpers';

const adv = { ...DEFAULT_ADDITIONAL };
const collect = () => { const events: StreamEvent[] = []; return { events, send: (e: StreamEvent) => events.push(e) }; };
const noopPersist = async () => true;

async function main() {

// ---- happy path: no request/CTA -> semantic layer is skipped, but progress events still make sense ----
{
  const { events, send } = collect();
  const providers: Providers = { extraction: null, evaluator: null, verifier: null };
  await processCheck({ sessionId: 's1', request: '', output: 'Some plain output.', additional: adv }, { providers, persist: noopPersist }, send);
  const stages = events.filter(e => e.type === 'stage').map((e: any) => e.stage);
  check('deterministic-only run: analysing is sent first, finalising last, no internal stage names leak', stages[0] === 'analysing' && stages[stages.length - 1] === 'finalising' && stages.every(s => ['analysing', 'reviewing', 'verifying', 'finalising'].includes(s)));
  check('exactly one result event, with a clean record', events.filter(e => e.type === 'result').length === 1);
  const result: any = events.find(e => e.type === 'result');
  check('result carries the client-safe record shape (no diagnostics/semanticError leaked)', result.record.checkStatus === 'clean' && !('diagnostics' in result.record) && !('semanticError' in result.record));
  check('persisted flag reflects a successful persist', result.persisted === true);
}

// ---- full semantic path: all four product-facing stages appear, in order, exactly once each ----
{
  const { events, send } = collect();
  const p = new Scripted({
    extraction: { items: [{ kind: 'instruction', category: 'prohibition', text: 'no competitors', quote: 'Do not mention competitors.' }] },
    evaluator: (prompt: string) => {
      const ids = [...prompt.matchAll(/"id":"(R\d+)"/g)].map(m => m[1]);
      return { judgments: ids.map(id => ({ id, verdict: 'satisfied' })), unrequested: [] };
    },
    scan: { findings: [] },
  });
  const providers: Providers = allOf(p);
  await processCheck({ sessionId: 's1', request: 'Do not mention competitors.', output: 'A clean answer.', additional: adv }, { providers, persist: noopPersist }, send);
  const stages = events.filter(e => e.type === 'stage').map((e: any) => e.stage);
  check('all four product-facing stages appear in order, each exactly once', JSON.stringify(stages) === JSON.stringify(['analysing', 'reviewing', 'verifying', 'finalising']), JSON.stringify(stages));
}

// ---- persistence throws -> result is still delivered in full, just flagged as not persisted ----
{
  const { events, send } = collect();
  const providers: Providers = { extraction: null, evaluator: null, verifier: null };
  const persist = async () => { throw new Error('db is down'); };
  await processCheck({ sessionId: 's1', request: '', output: 'Some output.', additional: adv }, { providers, persist }, send);
  const result: any = events.find(e => e.type === 'result');
  check('a persistence exception never hides the result from the user', !!result && result.persisted === false && result.record.checkStatus === 'clean');
}

// ---- persistence returns false (e.g. no database configured) -> same guarantee ----
{
  const { events, send } = collect();
  const providers: Providers = { extraction: null, evaluator: null, verifier: null };
  await processCheck({ sessionId: 's1', request: '', output: 'Some output.', additional: adv }, { providers, persist: async () => false }, send);
  const result: any = events.find(e => e.type === 'result');
  check('no database configured -> result still delivered, persisted:false (never a 500)', !!result && result.persisted === false);
}

// ---- a genuinely unexpected crash produces exactly one error event and NO result event ----
{
  const { events, send } = collect();
  const providers: Providers = { extraction: null, evaluator: null, verifier: null };
  const deps: CheckDeps = { providers, persist: noopPersist, newId: () => { throw new Error('id generation exploded'); } };
  await processCheck({ sessionId: 's1', request: '', output: 'Some output.', additional: adv }, deps, send);
  check('unexpected crash -> exactly one error event', events.length === 1 && events[0].type === 'error');
  check('unexpected crash -> never a result event (never silently "succeeds")', !events.some(e => e.type === 'result'));
}

// ---- NDJSON parser: arbitrary chunk boundaries, including mid-line splits ----
{
  const events: StreamEvent[] = [];
  const parser = createNdjsonParser(e => events.push(e));
  const full = encodeEvent({ type: 'stage', stage: 'analysing' }) + encodeEvent({ type: 'stage', stage: 'reviewing' }) + encodeEvent({ type: 'error' });
  // split at three arbitrary byte offsets, including mid-line
  parser.push(full.slice(0, 5));
  parser.push(full.slice(5, 40));
  parser.push(full.slice(40));
  parser.end();
  check('NDJSON parser reconstructs every event across arbitrary chunk boundaries', events.length === 3 && events[0].type === 'stage' && (events[0] as any).stage === 'analysing' && events[2].type === 'error', JSON.stringify(events));
}
{
  const events: StreamEvent[] = [];
  const parser = createNdjsonParser(e => events.push(e));
  parser.push('not json\n' + encodeEvent({ type: 'error' }) + '{"type":"unknown_type"}\n');
  parser.end();
  check('NDJSON parser skips malformed/unrecognised lines without crashing or misfiring', events.length === 1 && events[0].type === 'error');
}
{
  // a stream that ends without a final newline (e.g. connection cut mid-event) must not fabricate a result
  const events: StreamEvent[] = [];
  const parser = createNdjsonParser(e => events.push(e));
  parser.push(encodeEvent({ type: 'stage', stage: 'analysing' }));
  parser.push('{"type":"result","record":{"incompl');   // stream cut off mid-object, no trailing newline
  parser.end();
  check('a stream cut off mid-event yields no fabricated result event', events.length === 1 && events[0].type === 'stage');
}

done();
}
main();
