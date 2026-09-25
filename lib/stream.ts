import { CheckRecord, CheckStage } from './types';

/**
 * Newline-delimited JSON events streamed from POST /api/check so the UI
 * shows REAL progress. If the platform kills the function mid-run, the
 * stream simply ends with no `result` event — the client treats that as a
 * timeout/failure, never as success.
 */
export type StreamEvent =
  | { type: 'stage'; stage: CheckStage }
  | { type: 'result'; record: CheckRecord; persisted: boolean }
  | { type: 'error' };

export const encodeEvent = (e: StreamEvent): string => JSON.stringify(e) + '\n';

/** Incremental NDJSON parser; tolerant of arbitrary chunk boundaries and of malformed lines. */
export function createNdjsonParser(onEvent: (e: StreamEvent) => void) {
  let buf = '';
  const emit = (line: string) => {
    const t = line.trim();
    if (!t) return;
    try {
      const e = JSON.parse(t);
      if (e && (e.type === 'stage' || e.type === 'result' || e.type === 'error')) onEvent(e as StreamEvent);
    } catch { /* ignore a malformed line */ }
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    end() { emit(buf); buf = ''; },
  };
}
