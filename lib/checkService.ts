import { runPipeline, Providers } from './pipeline';
import { AdditionalChecks } from './types';
import { toClientRecord, toDbRow, DbCheckRow } from './records';
import { StreamEvent } from './stream';

export interface CheckInput { sessionId: string; request: string; output: string; additional: AdditionalChecks }
export interface CheckDeps {
  providers: Providers;
  /** Resolves true if the row was stored. Must not throw (a throw is treated as "not stored"). */
  persist: (row: DbCheckRow) => Promise<boolean>;
  newId?: () => string;
  now?: () => Date;
}

/**
 * Whole check: pipeline (streaming stage events) -> persistence -> result.
 * Persistence failure never hides the result from the user; it is logged and
 * reported as persisted=false. Nothing internal (diagnostics, error codes)
 * is included in the events.
 */
export async function processCheck(input: CheckInput, deps: CheckDeps, send: (e: StreamEvent) => void): Promise<void> {
  try {
    send({ type: 'stage', stage: 'analysing' });
    const result = await runPipeline(deps.providers, input.request, input.output, input.additional, {
      onStage: s => { if (s !== 'analysing') send({ type: 'stage', stage: s }); },
    });
    const rec = toClientRecord({
      id: (deps.newId || (() => crypto.randomUUID()))(), sessionId: input.sessionId,
      createdAt: (deps.now || (() => new Date()))().toISOString(),
      request: input.request, output: input.output, additional: input.additional,
    }, result);

    let persisted = false;
    try { persisted = await deps.persist(toDbRow(rec, result)); }
    catch (e) { console.error(`[sanitygate:persist] threw: ${e instanceof Error ? e.message : String(e)}`); }
    send({ type: 'result', record: rec, persisted });
  } catch (e) {
    console.error(`[sanitygate:check] unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
    send({ type: 'error' });
  }
}
