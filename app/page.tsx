'use client';

import { useEffect, useState, useCallback } from 'react';
import { Finding, AdditionalChecks, DEFAULT_ADDITIONAL, CheckRecord } from '@/lib/types';

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

function typeLabel(t: string) {
  return ({
    missing_requirement: 'Missing requirement', requirement_violation: 'Requirement violation',
    contradiction: 'Contradiction', unsupported_claim: 'Unsupported claim', source_mismatch: 'Source mismatch',
    numerical_mismatch: 'Numerical mismatch', entity_mismatch: 'Entity mismatch', format_violation: 'Format / constraint',
  } as Record<string, string>)[t] || 'Potential issue';
}
function isHigh(f: Finding) { return !f.needsReview; }

export default function Page() {
  const sessionId = useSessionId();
  const [view, setView] = useState<View>('landing');
  const [request, setRequest] = useState('');
  const [output, setOutput] = useState('');
  const [checksOpen, setChecksOpen] = useState(false);
  const [additional, setAdditional] = useState<AdditionalChecks>({ ...DEFAULT_ADDITIONAL });

  const [running, setRunning] = useState(false);
  const [runStage, setRunStage] = useState('');
  const [result, setResult] = useState<CheckRecord | null>(null);
  const [showCorrected, setShowCorrected] = useState(false);
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
    setRunStage('Understanding what you asked for…');
    try {
      const stageTimer1 = setTimeout(() => setRunStage('Comparing the output against your request…'), 900);
      const stageTimer2 = setTimeout(() => setRunStage('Verifying each finding…'), 2400);
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, request, output, additional }),
      });
      clearTimeout(stageTimer1); clearTimeout(stageTimer2);
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        setErrorMsg(j.message || 'SanityGate has temporarily reached its free AI capacity. Please try again later.');
        setRunning(false);
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErrorMsg(j.message || 'Something went wrong running the check. Please try again.');
        setRunning(false);
        return;
      }
      const rec: CheckRecord = await res.json();
      setResult(rec);
      setShowCorrected(false);
      setFeedback({});
      setView('result');
      setHistory(null);
    } catch (e) {
      setErrorMsg('Network error running the check. Please try again.');
    }
    setRunning(false);
  }

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`);
    const j = await res.json();
    setHistory(j.checks || []);
  }, [sessionId]);

  useEffect(() => { if (view === 'history' && history === null) loadHistory(); }, [view, history, loadHistory]);

  function updateFinding(id: string, patch: Partial<Finding>) {
    if (!result) return;
    const findings = result.findings.map(f => f.id === id ? { ...f, ...patch } : f);
    setResult({ ...result, findings });
  }

  async function sendFindingFeedback(f: Finding, verdict: 'correct' | 'false_positive') {
    updateFinding(f.id, { userVerdict: verdict });
    if (!result) return;
    fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkId: result.id, kind: 'finding', findingId: f.id, verdict }),
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
          running={running} runStage={runStage} errorMsg={errorMsg}
          onRun={runCheck}
        />
      )}
      {view === 'result' && result && (
        <ResultScreen
          result={result} showCorrected={showCorrected} setShowCorrected={setShowCorrected}
          onDismiss={(id) => updateFinding(id, { status: 'dismissed' })}
          onApply={(id) => updateFinding(id, { status: 'applied' })}
          onUndo={(id) => updateFinding(id, { status: 'open' })}
          onVerdict={sendFindingFeedback}
          feedback={feedback} onFeedback={sendReviewFeedback}
          onNewCheck={() => { resetDraft(); setView('check'); }}
        />
      )}
      {view === 'history' && <HistoryScreen history={history} onOpen={(rec) => { setResult(rec); setFeedback({}); setShowCorrected(false); setView('result'); }} onRunFirst={() => { resetDraft(); setView('check'); }} />}
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
          <div className="label">What you asked for</div>
          <div className="src-box">&quot;...mention the price ($24/user/month)...&quot;</div>
          <div className="label">What the AI generated</div>
          <div>&quot;The Business plan is available for just <mark className="mk-critical">$19/user/month</mark> and includes seamless <mark className="mk-warning">Slack integration</mark>.&quot;</div>
          <div style={{ marginTop: 12, borderTop: '1px dashed var(--border)', paddingTop: 10, fontSize: 13 }}>
            <strong>Price does not match what you asked for</strong><br />
            <span style={{ color: 'var(--ink-soft)' }}>Your request says $24/user/month.</span><br />
            <span style={{ color: 'var(--accent-ink)', fontFamily: 'var(--mono)' }}>Suggested: change to &quot;$24/user/month&quot; · High confidence</span>
          </div>
        </div>
      </div></section>
      <div className="footer-note">
        SanityGate is a free public pilot. It never rewrites your text automatically, and it distinguishes high-confidence findings from ones that need your judgment. Semantic checks run on a shared free AI capacity — during busy periods, checks may take longer or need a retry. Don&apos;t paste anything you wouldn&apos;t want processed by a third-party AI model.
      </div>
    </div>
  );
}

function CheckScreen(props: any) {
  const { request, setRequest, output, setOutput, checksOpen, setChecksOpen, additional, setAdditional, running, runStage, errorMsg, onRun } = props;

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
          {running ? <><span className="spinner" /> {runStage || 'Checking…'}</> : 'Check with SanityGate'}
        </button>
        {!request.trim() && <div className="notice" style={{ maxWidth: 480 }}>No instructions or reference material provided — SanityGate will only run the additional checks you&apos;ve selected above, with nothing to check the output&apos;s content against.</div>}
        {errorMsg && <div className="notice warn" style={{ maxWidth: 480 }}>{errorMsg}</div>}
        <div className="notice" style={{ maxWidth: 480, marginTop: 4 }}>
          Pilot notice: this is an experimental free tool. Don&apos;t paste anything you wouldn&apos;t want processed by a third-party AI model.
        </div>
      </div>
    </div>
  );
}

function renderHighlighted(output: string, findings: Finding[], showCorrected: boolean, onClickMark: (id: string) => void) {
  const withPos = findings.filter(f => f.start != null).sort((a, b) => a.start! - b.start!);
  if (showCorrected) {
    let text = output;
    const applied = withPos.filter(f => f.status === 'applied').sort((a, b) => b.start! - a.start!);
    for (const f of applied) text = text.slice(0, f.start!) + (f.suggestion || f.matchedText) + text.slice(f.end!);
    return <>{text}</>;
  }
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  withPos.forEach((f, i) => {
    if (f.start! < cursor) return;
    nodes.push(<span key={`t${i}`}>{output.slice(cursor, f.start!)}</span>);
    nodes.push(
      <mark key={f.id} className={`mk-${f.severity}`} onClick={() => onClickMark(f.id)}>
        {output.slice(f.start!, f.end!)}
      </mark>
    );
    cursor = f.end!;
  });
  nodes.push(<span key="tail">{output.slice(cursor)}</span>);
  return nodes;
}

interface ReviewFeedback {
  useful?: boolean;
  caughtReal?: string;
  comment?: string;
}

interface ResultScreenProps {
  result: CheckRecord;
  showCorrected: boolean;
  setShowCorrected: (value: boolean) => void;
  onDismiss: (id: string) => void;
  onApply: (id: string) => void;
  onUndo: (id: string) => void;
  onVerdict: (finding: Finding, verdict: 'correct' | 'false_positive') => void;
  feedback: ReviewFeedback;
  onFeedback: (patch: ReviewFeedback) => void;
  onNewCheck: () => void;
}

function ResultScreen({ result, showCorrected, setShowCorrected, onDismiss, onApply, onUndo, onVerdict, feedback, onFeedback, onNewCheck }: ResultScreenProps) {
  const active: Finding[] = result.findings.filter((f: Finding) => f.status !== 'dismissed');
  const high = active.filter(isHigh);
  const review = active.filter((f: Finding) => !isHigh(f));
  const dismissed = result.findings.filter((f: Finding) => f.status === 'dismissed');

  const complianceStatus = !result.hasReference && !result.additional?.cta ? 'No instructions provided' : result.semanticError ? 'Could not verify' : active.length ? 'Needs attention' : 'Followed your request';

  function scrollToCard(id: string) {
    const el = document.querySelector(`[data-finding="${id}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
  }

  return (
    <div className="wrap">
      <div style={{ padding: '20px 0 0' }}><button className="btn-quiet" onClick={onNewCheck}>← New check</button></div>
      <div style={{ padding: '10px 0 18px' }}>
        <div className="result-summary">
          <div className="rs-eyebrow">SanityGate Review</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <h2 className="rs-title">Review complete — {active.length} change{active.length === 1 ? '' : 's'} recommended</h2>
            <span style={{ color: 'var(--ink-faint)', fontSize: 12.5 }}>{new Date(result.createdAt).toLocaleString()} · {result.durationMs}ms · {result.wordCount} words</span>
          </div>
          <div className="rs-counts">
            <div className="rs-count high"><div className="n">{high.length}</div><div className="l">High confidence</div></div>
            <div className="rs-count review"><div className="n">{review.length}</div><div className="l">Needs review</div></div>
          </div>
          <div style={{ marginTop: 14, fontSize: 13.5 }}>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-faint)', textTransform: 'uppercase' }}>Did the AI do what you asked?</span>
            <strong style={{ color: complianceStatus === 'Followed your request' ? 'var(--passed)' : complianceStatus === 'Needs attention' ? 'var(--critical)' : 'var(--ink-faint)' }}>{complianceStatus}</strong>
          </div>
          {result.passedChecks.length > 0 && (
            <div className="rs-passed-list">{result.passedChecks.map((p: string, i: number) => <span key={i} className="rs-passed-item">✓ {p}</span>)}</div>
          )}
          {result.semanticError && (
            <div className="semantic-fail">
              <div><strong>SanityGate couldn&apos;t complete the semantic review.</strong> {result.semanticError === 'rate_limited' ? 'Free AI capacity was temporarily exceeded.' : 'Only deterministic checks ran.'} Instruction-following and reference-fact checking did not run — the findings above are not a clean bill of health.</div>
            </div>
          )}
        </div>
      </div>

      <div className="result-grid">
        <div className="output-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14.5 }}>Reviewed output</h3>
            <button className="btn-quiet btn-sm" onClick={() => setShowCorrected(!showCorrected)}>{showCorrected ? 'Show original' : 'Show corrected version'}</button>
          </div>
          <div className="output-text">{renderHighlighted(result.output, active, showCorrected, scrollToCard)}</div>
          <div className="disclaimer">The original text is never changed automatically. Applied suggestions only appear in the corrected preview above.</div>
        </div>

        <div className="findings-col">
          {active.length === 0 && (
            <div className="finding-card"><div style={{ fontWeight: 700, marginBottom: 4 }}>Nothing flagged</div>
              <p className="fc-reason">{result.semanticError ? 'Deterministic checks came back clean, but the instruction-following review did not complete — see the notice above.' : 'The output appears to follow what you asked for.'}</p></div>
          )}
          {active.map((f: Finding) => (
            <div key={f.id} data-finding={f.id} className="finding-card">
              <div className="fc-top">
                <span className={`type-badge sev-${f.severity}`}>{typeLabel(f.type)}</span>
                <span className={`conf-tag ${isHigh(f) ? 'conf-high' : 'conf-review'}`}>{isHigh(f) ? 'High confidence' : 'Needs review'}</span>
              </div>
              <p className="fc-reason">{f.reason}</p>
              {f.matchedText && <div className="evidence-block"><div className="el">Generated</div><div className="ev">&quot;{f.matchedText}&quot;</div></div>}
              {f.evidence && <div className="evidence-block"><div className="el">Your request said</div><div className="ev">&quot;{f.evidence}&quot;</div></div>}
              {f.requirement && <div className="evidence-block"><div className="el">Requirement</div><div className="ev">{f.requirement}</div></div>}
              {f.suggestion && (
                <div className="suggestion-row">
                  <span className="sv">{f.suggestion}</span>
                  {f.status === 'applied' ? <button className="btn-quiet btn-sm" onClick={() => onUndo(f.id)}>Undo</button> :
                    (f.start != null ? <button className="btn btn-primary btn-sm" onClick={() => onApply(f.id)}>Apply</button> : null)}
                </div>
              )}
              <div className="fc-actions">
                <button className="btn-quiet btn-sm" onClick={() => onDismiss(f.id)}>Dismiss</button>
                {f.userVerdict == null ? (<>
                  <button className="btn-quiet btn-sm" onClick={() => onVerdict(f, 'correct')}>Correct</button>
                  <button className="btn-quiet btn-sm" onClick={() => onVerdict(f, 'false_positive')}>False positive</button>
                </>) : <span className="conf-tag conf-review">You marked this: {f.userVerdict === 'correct' ? 'correct' : 'false positive'}</span>}
              </div>
            </div>
          ))}
          {dismissed.length > 0 && <div className="finding-card" style={{ opacity: .6 }}><div style={{ fontWeight: 700 }}>{dismissed.length} dismissed finding{dismissed.length === 1 ? '' : 's'}</div></div>}
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

function HistoryScreen({ history, onOpen, onRunFirst }: { history: CheckRecord[] | null; onOpen: (r: CheckRecord) => void; onRunFirst: () => void }) {
  if (history === null) return <div className="wrap"><div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-soft)' }}><span className="spinner dark" /> Loading history…</div></div>;
  if (history.length === 0) {
    return <div className="wrap"><div className="empty-state"><h3>No checks yet</h3><p>Run your first check and it&apos;ll show up here.</p>
      <div style={{ marginTop: 14 }}><button className="btn btn-primary" onClick={onRunFirst}>Run a check</button></div></div></div>;
  }
  return (
    <div className="wrap">
      <div className="check-head"><h1>History</h1><p>Checks from this browser (matched by an anonymous local id, not an account).</p></div>
      <div className="hist-list">
        {history.map(h => {
          const active = h.findings.filter(f => f.status !== 'dismissed');
          const high = active.filter(isHigh).length;
          return (
            <div key={h.id} className="hist-item" onClick={() => onOpen(h)}>
              <div><div className="hist-title">{(h.output || '').trim().split('\n')[0].slice(0, 60) || 'Untitled check'}</div>
                <div className="hist-meta">{new Date(h.createdAt).toLocaleString()} · {active.length} issue{active.length === 1 ? '' : 's'}</div></div>
              <span className="type-badge" style={{ background: high > 0 ? 'var(--critical-soft)' : 'var(--passed-soft)', color: high > 0 ? 'var(--critical)' : 'var(--passed)' }}>{high > 0 ? `${high} high` : 'clean'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
