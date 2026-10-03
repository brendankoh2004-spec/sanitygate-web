/**
 * Streaming check service (lib/checkService.ts) + NDJSON helpers (lib/stream.ts): progress events use product
 * language, persistence failures never hide a result, an unexpected crash never silently succeeds.
 */
import { processCheck, CheckDeps } from '../lib/checkService';
import { createNdjsonParser, encodeEvent, StreamEvent } from '../lib/stream';
import { DEFAULT_ADDITIONAL } from '../lib/types';
import { check, done, Scripted, allOf, NO_PROVIDERS, PASS, issues, issue, candidatesFromPrompt, decision } from './helpers';

const adv = { ...DEFAULT_ADDITIONAL };
const collect = () => { const events: StreamEvent[] = []; return { events, send: (e: StreamEvent) => events.push(e) }; };
const noopPersist = async () => true;
const STAGES = ['reviewing', 'confirming', 'finalising'];

async function main() {
{
  const { events, send } = collect();
  await processCheck({ sessionId: 's1', request: '', output: 'Some plain output.', additional: adv }, { providers: NO_PROVIDERS, persist: noopPersist }, send);
  const stages = events.filter(e => e.type === 'stage').map((e: any) => e.stage);
  check('deterministic-only run: reviewing first, finalising last, only product-language stages', stages[0] === 'reviewing' && stages[stages.length - 1] === 'finalising' && stages.every(s => STAGES.includes(s)), JSON.stringify(stages));
  const result: any = events.find(e => e.type === 'result');
  check('exactly one result event, clean, client-safe shape (no diagnostics/semanticError)', events.filter(e => e.type === 'result').length === 1 && result.record.checkStatus === 'clean' && !('diagnostics' in result.record) && !('semanticError' in result.record));
  check('persisted flag reflects a successful persist', result.persisted === true);
}
{
  const { events, send } = collect();
  const p = new Scripted({ direct: PASS, coverage: PASS, reverse: PASS, adjudicator: () => { throw new Error('must not be called'); } });
  await processCheck({ sessionId: 's1', request: 'Do not mention competitors.', output: 'A clean answer.', additional: adv }, { providers: allOf(p), persist: noopPersist }, send);
  const stages = events.filter(e => e.type === 'stage').map((e: any) => e.stage);
  check('clean semantic run: reviewing then finalising; "confirming" is skipped because nothing needs adjudication', JSON.stringify(stages) === JSON.stringify(['reviewing', 'finalising']), JSON.stringify(stages));
}
{
  const { events, send } = collect();
  const p = new Scripted({
    direct: PASS, reverse: PASS, coverage: issues(issue('instruction_violation', { output_evidence: 'RivalCorp', request_evidence: 'Do not mention competitors.' })),
    adjudicator: (pr: string) => ({ decisions: candidatesFromPrompt(pr).map(c => decision(c.id, { category: c.type, output_quote: c.output_evidence, request_quote: c.request_evidence })) }),
  });
  await processCheck({ sessionId: 's1', request: 'Do not mention competitors.', output: 'We beat RivalCorp.', additional: adv }, { providers: allOf(p), persist: noopPersist }, send);
  const stages = events.filter(e => e.type === 'stage').map((e: any) => e.stage);
  check('run with candidate errors: reviewing, confirming, finalising — each exactly once, in order', JSON.stringify(stages) === JSON.stringify(['reviewing', 'confirming', 'finalising']), JSON.stringify(stages));
}
{
  const { events, send } = collect();
  await processCheck({ sessionId: 's1', request: '', output: 'Some output.', additional: adv }, { providers: NO_PROVIDERS, persist: async () => { throw new Error('db is down'); } }, send);
  const result: any = events.find(e => e.type === 'result');
  check('a persistence exception never hides the result from the user', !!result && result.persisted === false && result.record.checkStatus === 'clean');
}
{
  const { events, send } = collect();
  await processCheck({ sessionId: 's1', request: '', output: 'Some output.', additional: adv }, { providers: NO_PROVIDERS, persist: async () => false }, send);
  const result: any = events.find(e => e.type === 'result');
  check('no database configured -> result still delivered, persisted:false', !!result && result.persisted === false);
}
{
  const { events, send } = collect();
  const deps: CheckDeps = { providers: NO_PROVIDERS, persist: noopPersist, newId: () => { throw new Error('id generation exploded'); } };
  await processCheck({ sessionId: 's1', request: '', output: 'Some output.', additional: adv }, deps, send);
  check('unexpected crash -> exactly one error event and never a result', events.filter(e => e.type === 'error').length === 1 && !events.some(e => e.type === 'result'));
}
{
  const events: StreamEvent[] = [];
  const parser = createNdjsonParser(e => events.push(e));
  const full = encodeEvent({ type: 'stage', stage: 'reviewing' }) + encodeEvent({ type: 'stage', stage: 'confirming' }) + encodeEvent({ type: 'error' });
  parser.push(full.slice(0, 5)); parser.push(full.slice(5, 40)); parser.push(full.slice(40)); parser.end();
  check('NDJSON parser reconstructs every event across arbitrary chunk boundaries', events.length === 3 && (events[0] as any).stage === 'reviewing' && events[2].type === 'error', JSON.stringify(events));
}
{
  const events: StreamEvent[] = [];
  const parser = createNdjsonParser(e => events.push(e));
  parser.push('not json\n' + encodeEvent({ type: 'error' }) + '{"type":"unknown_type"}\n'); parser.end();
  check('NDJSON parser skips malformed/unrecognised lines', events.length === 1 && events[0].type === 'error');
}
{
  const events: StreamEvent[] = [];
  const parser = createNdjsonParser(e => events.push(e));
  parser.push(encodeEvent({ type: 'stage', stage: 'reviewing' })); parser.push('{"type":"result","record":{"incompl'); parser.end();
  check('a stream cut off mid-event yields no fabricated result', events.length === 1 && events[0].type === 'stage');
}
done();
}
main();
