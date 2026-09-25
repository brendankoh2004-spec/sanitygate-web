'use client';

import { useEffect, useState, useCallback } from 'react';
import { Finding, AdditionalChecks, DEFAULT_ADDITIONAL, CheckRecord, CheckStage, IncompleteReason } from '@/lib/types';
import { buildSegments, MarkInput } from '@/lib/edits';
import { createNdjsonParser, StreamEvent } from '@/lib/stream';

type View = 'landing' | 'check' | 'result' | 'history';

function useSessionId(): string {
  const [id, setId] = useState('');
  useEffect(() => {
    let existing = typeof window !== 'undefined' ? localStorage.getItem('sg_session_id') : null;
    if (!existing) {
      existing = crypto.randomUUID();
      localStorage.setItem('sg_session_id', existing);
    }
    setId(existing);
  }, []);
  return id;
}

const EXAMPLE_REQUEST = `Write a launch announcement email for our Business plan. Explain what's included, mention the price, and include a clear call to action.

PRODUCT: Atlas Project Management
Key features: Task management, Project timelines, Team collaboration, Basic reporting.
Business plan: $24/user/month. Includes advanced reporting.
Free trial: 14 days, no credit card required.
Do not claim that Atlas guarantees productivity improvements. Do not claim that Atlas integrates with Slack.`;

const EXAMPLE_OUTPUT = `Subject: Take your team's productivity to the next level with Atlas

Hi Sarah,

We're excited to introduce Atlas, the AI-powered project management platform built to help teams work smarter.

With Atlas, your team gets task management, project timelines, team collaboration, advanced reporting, and seamless Slack integration.

The Business plan is available for just $19/user/month.

Our platform guarantees significant productivity improvements from day one.

You can start your free trial today with no commitment. A credit card is required to activate your trial.

Best,
The Atlas Team`;

// ---------------------------------------------------------------------
// Four product-facing stages (spec section 9). No internal pipeline
// terminology ("Call 1", "deterministic validator", ...) ever appears here.
// ---------------------------------------------------------------------
const STAGES: { key: CheckStage; label: string }[] = [
  { key: 'analysing', label: 'Analysing' },
  { key: 'reviewing', label: 'Reviewing' },
  { key: 'verifying', label: 'Verifying' },
  { key: 'finalising', label: 'Finalising' },
];

function StageProgress({ current }: { current: CheckStage | null }) {
  const idx = current ? STAGES.findIndex(s => s.key === current) : -1;
  return (
    <div className="stage-progress">
      {STAGES.map((s, i) => (
        <div key={s.key} className={`stage-step ${i < idx ? 'done' : i === idx ? 'active' : 'pending'}`}>
          <span className="stage-dot" />{s.label}
        </div>
      ))}
    </div>
  );
}

export default function Page() {
  const sessionId = useSessionId();
  const [view, setView] = useState<View>('landing');
  const [request, setRequest] = useState('');
  const [output, setOutput] = useState('');
  const [checksOpen, setChecksOpen] = useState(false);
  const [additional, setAdditional] = useState<AdditionalChecks>({ ...DEFAULT_ADDITIONAL });

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<CheckStage | null>(null);
  const [result, setResult] = useState<CheckRecord | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [feedback, setFeedback] = useState<{ useful?: boolean; caughtReal?: string; comment?: string }>({});
  const [history, setHistory] = useState<CheckRecord[] | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  function resetDraft(prefill?: { request: string; output: string }) {
    setRequest(prefill?.request || '');
    setOutput(prefill?.output || '');
    setChecksOpen(false);
    setAdditional({ ...DEFAULT_ADDITIONAL });
    setErrorMsg('');
  }

  async function runCheck() {
    if (!output.trim()) { setErrorMsg('Paste the AI output to check first.'); return; }
    setErrorMsg('');
    setRunning(true);
    setStage('analysing');
    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, request, output, additional }),
      });
      if (res.status === 429) {
        const j = await res.json().catch(() => ({} as any));
        setErrorMsg(j.message || 'SanityGate has reached its capacity for now. Please try again later.');
        setRunning(false); setStage(null);
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setErrorMsg(j.message || 'Something went wrong running the check. Please try again.');
        setRunning(false); setStage(null);
        return;
      }
      if (!res.body) { setErrorMsg('Something went wrong running the check. Please try again.'); setRunning(false); setStage(null); return; }

      let finalRecord: CheckRecord | null = null;
      let finalPersisted = true;
      let sawError = false;
      const parser = createNdjsonParser((e: StreamEvent) => {
        if (e.type === 'stage') setStage(e.stage);
        else if (e.type === 'result') { finalRecord = e.record; finalPersisted = e.persisted; }
        else if (e.type === 'error') sawError = true;
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) { parser.end(); break; }
        parser.push(decoder.decode(value, { stream: true }));
      }
      if (sawError || !finalRecord) {
        setErrorMsg('Something went wrong running the check. Please try again.');
        setRunning(false); setStage(null);
        return;
      }
      setResult(finalRecord);
      setPersisted(finalPersisted);
      setFeedback({});
      setView('result');
      setHistory(null);
    } catch (e) {
      setErrorMsg('Network error running the check. Please try again.');
    }
    setRunning(false); setStage(null);
  }

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`);
    const j = await res.json();
    setHistory(j.checks || []);
  }, [sessionId]);

  useEffect(() => { if (view === 'history' && history === null) loadHistory(); }, [view, history, loadHistory]);

  function sendFindingFeedback(checkId: string, findingId: string, decision: 'accepted' | 'ignored' | 'undone') {
    fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkId, kind: 'finding', findingId, decision }),
    }).catch(() => {});
  }

  function sendReviewFeedback(patch: typeof feedback) {
    const next = { ...feedback, ...patch };
    setFeedback(next);
    if (!result) return;
    fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkId: result.id, kind: 'review', ...next }),
    }).catch(() => {});
  }

  return (
    <>
      <Nav view={view} setView={(v) => { if (v === 'check') resetDraft(); setView(v); }} />
      {view === 'landing' && <Landing onTry={() => { resetDraft(); setView('check'); }} onExample={() => { resetDraft({ request: EXAMPLE_REQUEST, output: EXAMPLE_OUTPUT }); setView('check'); }} />}
      {view === 'check' && (
        <CheckScreen
          request={request} setRequest={setRequest} output={output} setOutput={setOutput}
          checksOpen={checksOpen} setChecksOpen={setChecksOpen}
          additional={additional} setAdditional={setAdditional}
          running={running} stage={stage} errorMsg={errorMsg}
          onRun={runCheck}
        />
      )}
      {view === 'result' && result && (
        <ResultScreen
          key={result.id}
          result={result} persisted={persisted}
          onFindingDecision={sendFindingFeedback}
          feedback={feedback} onFeedback={sendReviewFeedback}
          onNewCheck={() => { resetDraft(); setView('check'); }}
        />
      )}
      {view === 'history' && <HistoryScreen history={history} onOpen={(rec) => { setResult(rec); setPersisted(true); setFeedback({}); setView('result'); }} onRunFirst={() => { resetDraft(); setView('check'); }} />}
    </>
  );
}

function Logo() {
  return (
    <span className="brand-mark">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none">
        <path d="M12 2L20 6V11C20 16 16.5 19.7 12 21C7.5 19.7 4 16 4 11V6L12 2Z" fill="#FBF8F0" fillOpacity=".95" />
        <path d="M9 11.8L11.2 14L15.4 9" stroke="#3F5D4E" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Nav({ view, setView }: { view: View; setView: (v: View) => void }) {
  return (
    <div className="topnav"><div className="topnav-inner">
      <button className="brand" onClick={() => setView('landing')} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><Logo /> SanityGate</button>
      <div className="navtabs">
        <button className="navlink" onClick={() => setView('check')}>Check</button>
        <button className="navlink" onClick={() => setView('history')}>History</button>
      </div>
      <span className="pill">Pilot</span>
    </div></div>
  );
}

function Landing({ onTry, onExample }: { onTry: () => void; onExample: () => void }) {
  return (
    <div className="wrap">
      <section className="hero"><div className="hero-grid">
        <div>
          <div className="eyebrow">DID THE AI ACTUALLY DO WHAT YOU ASKED? · FREE PILOT</div>
          <h1>Check what your AI actually wrote.</h1>
          <p className="lead">SanityGate checks AI-generated output against what you originally asked for — instructions, reference facts, and constraints — highlights what doesn&apos;t align, and shows you what to change.</p>
          <div className="hero-cta">
            <button className="btn btn-primary" onClick={onTry}>Try SanityGate</button>
            <button className="btn btn-ghost" onClick={onExample}>See an example</button>
          </div>
        </div>
        <div className="demo-card">
          <div className="label">Generated</div>
          <div>&quot;The Business plan is available for just <mark className="mk-critical">$19/user/month</mark> and includes seamless <mark className="mk-warning">Slack integration</mark>.&quot;</div>
          <div style={{ marginTop: 12, borderTop: '1px dashed var(--border)', paddingTop: 10, fontSize: 13 }}>
            <div className="label" style={{ marginBottom: 6 }}>Suggested</div>
            &quot;The Business plan is available for just $24/user/month.&quot;
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <span className="fb-opt sel" style={{ cursor: 'default' }}>Accept</span>
              <span className="fb-opt" style={{ cursor: 'default' }}>Ignore</span>
            </div>
          </div>
        </div>
      </div></section>
      <div className="footer-note">
        SanityGate is a free public pilot. It never rewrites your text automatically — you decide which suggestions to accept. Semantic checks run on shared AI capacity, so during busy periods a check may take longer or come back incomplete. Don&apos;t paste anything you wouldn&apos;t want processed by a third-party AI model.
      </div>
    </div>
  );
}

function CheckScreen(props: any) {
  const { request, setRequest, output, setOutput, checksOpen, setChecksOpen, additional, setAdditional, running, stage, errorMsg, onRun } = props;

  return (
    <div className="wrap-narrow">
      <div className="check-head"><h1>New check</h1><p>Paste everything you gave the AI, paste what it generated, and check.</p></div>
      <div className="check-stack">
        <div className="panel">
          <div className="panel-title">What did you ask the AI to do?</div>
          <div className="panel-sub">Paste the prompt, instructions, source material, objectives, references or anything else you gave the AI.</div>
          <textarea style={{ minHeight: 160 }} value={request} onChange={(e: any) => setRequest(e.target.value)} placeholder="Paste everything you gave the AI here…" />
        </div>

        <div className="panel">
          <div className="panel-title">What did the AI generate?</div>
          <div className="panel-sub">Paste the AI&apos;s response here.</div>
          <textarea style={{ minHeight: 180 }} value={output} onChange={(e: any) => setOutput(e.target.value)} placeholder="Paste the output you want SanityGate to check…" />
        </div>

        <div className="panel">
          <button className="adv-toggle" style={{ marginTop: 0 }} onClick={() => setChecksOpen(!checksOpen)}>{checksOpen ? '▾' : '▸'} Additional checks</button>
          <div className="panel-sub" style={{ marginTop: 4 }}>Optional. SanityGate already checks instruction-following and reference facts automatically — these are simple, objective extras.</div>
          {checksOpen && (
            <div className="adv-body" style={{ borderTop: 'none', paddingTop: 4 }}>
              <div>
                <div className="check-row"><input type="checkbox" checked={additional.cta} onChange={(e: any) => setAdditional({ ...additional, cta: e.target.checked })} /><label>Must include a CTA</label></div>
                <div className="check-row"><input type="checkbox" checked={additional.bulletFormat} onChange={(e: any) => setAdditional({ ...additional, bulletFormat: e.target.checked })} /><label>Must use bullet points</label></div>
                <div className="check-row"><input type="checkbox" checked={additional.numberedFormat} onChange={(e: any) => setAdditional({ ...additional, numberedFormat: e.target.checked })} /><label>Must use a numbered list</label></div>
                <div className="check-row"><input type="checkbox" checked={additional.maxWords} onChange={(e: any) => setAdditional({ ...additional, maxWords: e.target.checked })} />
                  <label>Maximum word count<input type="number" className="inline-num" value={additional.maxWordsVal} onChange={(e: any) => setAdditional({ ...additional, maxWordsVal: Number(e.target.value) })} /></label></div>
                <div className="check-row"><input type="checkbox" checked={additional.minWords} onChange={(e: any) => setAdditional({ ...additional, minWords: e.target.checked })} />
                  <label>Minimum word count<input type="number" className="inline-num" value={additional.minWordsVal} onChange={(e: any) => setAdditional({ ...additional, minWordsVal: Number(e.target.value) })} /></label></div>
              </div>
              <div>
                <div className="check-row"><input type="checkbox" checked={additional.requiredTerms} onChange={(e: any) => setAdditional({ ...additional, requiredTerms: e.target.checked })} /><label>Must contain specific terms</label></div>
                <input type="text" className="inline-text" placeholder="comma-separated" value={additional.requiredTermsVal} onChange={(e: any) => setAdditional({ ...additional, requiredTermsVal: e.target.value })} />
                <div className="check-row" style={{ marginTop: 10 }}><input type="checkbox" checked={additional.forbiddenTerms} onChange={(e: any) => setAdditional({ ...additional, forbiddenTerms: e.target.checked })} /><label>Must not contain specific terms</label></div>
                <input type="text" className="inline-text" placeholder="comma-separated" value={additional.forbiddenTermsVal} onChange={(e: any) => setAdditional({ ...additional, forbiddenTermsVal: e.target.value })} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="check-cta">
        <button className="btn btn-primary" disabled={running} onClick={onRun}>
          {running ? <><span className="spinner" /> Checking…</> : 'Check with SanityGate'}
        </button>
        {running && <StageProgress current={stage} />}
        {!request.trim() && !running && <div className="notice" style={{ maxWidth: 480 }}>No instructions or reference material provided — SanityGate will only run the additional checks you&apos;ve selected above, with nothing to check the output&apos;s content against.</div>}
        {errorMsg && <div className="notice warn" style={{ maxWidth: 480 }}>{errorMsg}</div>}
        <div className="notice" style={{ maxWidth: 480, marginTop: 4 }}>
          Pilot notice: this is an experimental free tool. Don&apos;t paste anything you wouldn&apos;t want processed by a third-party AI model.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Result screen
// ---------------------------------------------------------------------
type Decision = 'pending' | 'accepted' | 'ignored';

function statusBanner(result: CheckRecord) {
  if (result.checkStatus === 'check_incomplete') {
    const why: Record<IncompleteReason, string> = {
      busy: 'SanityGate is experiencing high demand right now, so part of the review could not run.',
      timeout: 'The review took longer than expected and could not fully finish.',
      general: 'Part of the review could not be completed.',
    };
    return { tone: 'incomplete', text: `The review could not be fully completed. ${why[result.incompleteReason || 'general']} You're welcome to try again.` };
  }
  if (!result.hasReference && !result.additional.cta) {
    return { tone: 'neutral', text: 'No instructions or reference material was provided, so SanityGate only ran the additional checks you selected.' };
  }
  if (result.checkStatus === 'clean') return { tone: 'clean', text: 'This looks consistent with what you asked for.' };
  if (result.checkStatus === 'needs_review') return { tone: 'review', text: "SanityGate found some possible issues but isn't fully confident about them — worth a look." };
  return { tone: 'attention', text: 'SanityGate found some things worth reviewing below.' };
}

function ResultScreen({ result, persisted, onFindingDecision, feedback, onFeedback, onNewCheck }: {
  result: CheckRecord; persisted: boolean;
  onFindingDecision: (checkId: string, findingId: string, decision: 'accepted' | 'ignored' | 'undone') => void;
  feedback: { useful?: boolean; caughtReal?: string; comment?: string };
  onFeedback: (patch: { useful?: boolean; caughtReal?: string; comment?: string }) => void;
  onNewCheck: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const decide = (id: string, d: Decision) => {
    setDecisions(prev => ({ ...prev, [id]: d }));
    onFindingDecision(result.id, id, d === 'pending' ? 'undone' : d);
  };

  const visible = result.findings.filter(f => decisions[f.id] !== 'ignored');
  const ignoredCount = result.findings.length - visible.length;
  const banner = statusBanner(result);

  const marks: MarkInput[] = visible.filter(f => f.passage).map(f => ({
    id: f.id, start: f.passage!.start, end: f.passage!.end,
    state: decisions[f.id] === 'accepted' ? 'accepted' : 'pending',
    replacement: f.edit ? f.edit.replacement : (f.suggestion ?? f.passage!.text),
    severity: f.severity,
  }));
  const segments = buildSegments(result.output, marks);

  function scrollToCard(id: string) {
    const el = document.querySelector(`[data-finding="${id}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
  }

  const title = result.checkStatus === 'clean' ? 'Review complete — nothing to change'
    : result.checkStatus === 'check_incomplete' && visible.length === 0 ? 'Review incomplete'
    : `Review complete — ${visible.length} change${visible.length === 1 ? '' : 's'} suggested`;

  return (
    <div className="wrap">
      <div style={{ padding: '20px 0 0' }}><button className="btn-quiet" onClick={onNewCheck}>← New check</button></div>
      <div style={{ padding: '10px 0 18px' }}>
        <div className="result-summary">
          <div className="rs-eyebrow">SanityGate Review</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <h2 className="rs-title">{title}</h2>
            <span style={{ color: 'var(--ink-faint)', fontSize: 12.5 }}>{new Date(result.createdAt).toLocaleString()} · {result.wordCount} words</span>
          </div>
          <div className={`status-banner ${banner.tone}`}>{banner.text}</div>
          {result.passedChecks.length > 0 && (
            <div className="rs-passed-list">{result.passedChecks.map((p: string, i: number) => <span key={i} className="rs-passed-item">✓ {p}</span>)}</div>
          )}
          {!persisted && <div className="notice" style={{ marginTop: 10 }}>This result couldn&apos;t be saved to your history, but everything below is accurate.</div>}
        </div>
      </div>

      <div className="result-grid">
        <div className="output-panel">
          <h3 style={{ margin: '0 0 12px', fontSize: 14.5 }}>Reviewed output</h3>
          <div className="output-text">
            {segments.map((s, i) => {
              if (s.kind === 'text') return <span key={i}>{s.text}</span>;
              if (s.kind === 'accepted') return <span key={i} className="mk-accepted">{s.text}</span>;
              return <mark key={i} className={`mk-${s.severity}`} onClick={() => scrollToCard(s.id)}>{s.text}</mark>;
            })}
          </div>
          <div className="disclaimer">The original text is never changed automatically. Accepted suggestions update the preview above immediately — nothing is final until you copy it.</div>
        </div>

        <div className="findings-col">
          {visible.length === 0 && (
            <div className="finding-card"><div style={{ fontWeight: 700, marginBottom: 4 }}>Nothing flagged</div>
              <p className="fc-reason">{result.checkStatus === 'check_incomplete' ? 'The parts of the review that did complete came back clean — see the notice above for what could not be checked.' : 'The output appears to follow what you asked for.'}</p></div>
          )}
          {visible.map((f, i) => (
            <FindingCard key={f.id} finding={f} index={i + 1} total={visible.length}
              state={decisions[f.id] === 'accepted' ? 'accepted' : 'pending'}
              onAccept={() => decide(f.id, 'accepted')} onIgnore={() => decide(f.id, 'ignored')} onUndo={() => decide(f.id, 'pending')} />
          ))}
          {ignoredCount > 0 && <div className="finding-card ignored-summary">{ignoredCount} ignored</div>}
        </div>
      </div>

      <div className="feedback-panel">
        <div className="fb-row"><div className="fb-q">Was this review useful?</div><div className="fb-opts">
          <button className={`fb-opt ${feedback.useful === true ? 'sel' : ''}`} onClick={() => onFeedback({ useful: true })}>Yes</button>
          <button className={`fb-opt ${feedback.useful === false ? 'sel' : ''}`} onClick={() => onFeedback({ useful: false })}>No</button>
        </div></div>
        <div className="fb-row"><div className="fb-q">Did SanityGate catch something you actually cared about?</div><div className="fb-opts">
          <button className={`fb-opt ${feedback.caughtReal === 'true' ? 'sel' : ''}`} onClick={() => onFeedback({ caughtReal: 'true' })}>Yes</button>
          <button className={`fb-opt ${feedback.caughtReal === 'false' ? 'sel' : ''}`} onClick={() => onFeedback({ caughtReal: 'false' })}>No</button>
          <button className={`fb-opt ${feedback.caughtReal === 'unsure' ? 'sel' : ''}`} onClick={() => onFeedback({ caughtReal: 'unsure' })}>Not sure</button>
        </div></div>
      </div>
    </div>
  );
}

/** Section 11: a finding is shown as "Error i of N" with the generated passage, a suggested
 * correction, and Accept/Ignore — never a category name, a confidence tag, or a layer name. */
function FindingCard({ finding, index, total, state, onAccept, onIgnore, onUndo }: {
  finding: Finding; index: number; total: number; state: Decision;
  onAccept: () => void; onIgnore: () => void; onUndo: () => void;
}) {
  const generated = finding.passage ? finding.passage.text : null;
  const suggested = finding.edit ? finding.edit.replacement : finding.suggestion;
  return (
    <div data-finding={finding.id} className={`finding-card ${state === 'accepted' ? 'fc-accepted' : ''}`}>
      <div className="fc-index">Error {index} of {total}</div>
      <p className="fc-reason">{finding.reason}</p>
      {finding.requirementQuote && <div className="evidence-block"><div className="el">From your request</div><div className="ev">{finding.requirementQuote}</div></div>}
      {generated !== null && <div className="evidence-block"><div className="el">Generated</div><div className="ev">{generated || '(nothing)'}</div></div>}
      {suggested != null && (
        <div className="evidence-block sv-block"><div className="el">Suggested</div><div className="ev">{suggested === '' ? '(remove this)' : suggested}</div></div>
      )}
      <div className="fc-actions">
        {state === 'accepted'
          ? <button className="btn-quiet btn-sm" onClick={onUndo}>Undo</button>
          : (<><button className="btn btn-primary btn-sm" onClick={onAccept}>Accept</button><button className="btn-quiet btn-sm" onClick={onIgnore}>Ignore</button></>)}
      </div>
    </div>
  );
}

function HistoryScreen({ history, onOpen, onRunFirst }: { history: CheckRecord[] | null; onOpen: (r: CheckRecord) => void; onRunFirst: () => void }) {
  if (history === null) return <div className="wrap"><div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-soft)' }}><span className="spinner dark" /> Loading history…</div></div>;
  if (history.length === 0) {
    return <div className="wrap"><div className="empty-state"><h3>No checks yet</h3><p>Run your first check and it&apos;ll show up here.</p>
      <div style={{ marginTop: 14 }}><button className="btn btn-primary" onClick={onRunFirst}>Run a check</button></div></div></div>;
  }
  const badge = (h: CheckRecord) => {
    if (h.checkStatus === 'check_incomplete') return { text: 'incomplete', cls: 'badge-neutral' };
    if (h.checkStatus === 'clean') return { text: 'clean', cls: 'badge-clean' };
    if (h.checkStatus === 'needs_review') return { text: 'needs a look', cls: 'badge-neutral' };
    return { text: `${h.findings.length} found`, cls: 'badge-attention' };
  };
  return (
    <div className="wrap">
      <div className="check-head"><h1>History</h1><p>Checks from this browser (matched by an anonymous local id, not an account).</p></div>
      <div className="hist-list">
        {history.map(h => {
          const b = badge(h);
          return (
            <div key={h.id} className="hist-item" onClick={() => onOpen(h)}>
              <div><div className="hist-title">{(h.output || '').trim().split('\n')[0].slice(0, 60) || 'Untitled check'}</div>
                <div className="hist-meta">{new Date(h.createdAt).toLocaleString()}</div></div>
              <span className={`type-badge ${b.cls}`}>{b.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
