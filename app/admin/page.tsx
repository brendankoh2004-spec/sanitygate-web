'use client';

import { useState } from 'react';

export default function AdminPage() {
  const [key, setKey] = useState('');
  const [stats, setStats] = useState<any>(null);
  const [evalResult, setEvalResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  async function loadStats() {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/admin/stats', { headers: { 'x-admin-key': key } });
      if (!res.ok) { setError(`Unauthorized or error (${res.status})`); setLoading(false); return; }
      setStats(await res.json());
    } catch (e) { setError('Network error'); }
    setLoading(false);
  }

  async function runEval() {
    setRunning(true); setError(''); setEvalResult(null);
    try {
      const res = await fetch('/api/admin/eval', { method: 'POST', headers: { 'x-admin-key': key } });
      if (!res.ok) { setError(`Eval failed (${res.status})`); setRunning(false); return; }
      setEvalResult(await res.json());
    } catch (e) { setError('Network error running eval'); }
    setRunning(false);
  }

  return (
    <div className="wrap" style={{ paddingTop: 30, paddingBottom: 60 }}>
      <h1 style={{ fontSize: 22 }}>SanityGate — Admin</h1>
      <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>Aggregated pilot analytics and live checker evaluation. No raw source/output text is shown here.</p>

      <div className="panel" style={{ maxWidth: 480, marginTop: 16 }}>
        <div className="panel-title">Admin key</div>
        <input type="password" className="inline-text" style={{ marginLeft: 0, width: '100%' }} value={key} onChange={(e: any) => setKey(e.target.value)} placeholder="X-Admin-Key" />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" onClick={loadStats} disabled={loading}>{loading ? 'Loading…' : 'Load stats'}</button>
          <button className="btn btn-ghost btn-sm" onClick={runEval} disabled={running}>{running ? 'Running (can take a minute)…' : 'Run checker evaluation'}</button>
        </div>
        {error && <div className="notice warn" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {stats && !stats.error && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 16.5 }}>Users</h2>
          <div className="stat-grid">
            <div className="stat-card"><div className="sn">{stats.users.totalSessions}</div><div className="sl">Total sessions</div></div>
            <div className="stat-card"><div className="sn">{stats.users.returning}</div><div className="sl">Returning (2+ checks)</div></div>
            <div className="stat-card"><div className="sn">{stats.users.power}</div><div className="sl">Power users (5+ checks)</div></div>
            <div className="stat-card"><div className="sn">{stats.users.returningPct}%</div><div className="sl">% who returned</div></div>
          </div>
          <h2 style={{ fontSize: 16.5, marginTop: 24 }}>Checks</h2>
          <div className="stat-grid">
            <div className="stat-card"><div className="sn">{stats.checks.total}</div><div className="sl">Total checks</div></div>
            <div className="stat-card"><div className="sn">{stats.checks.today}</div><div className="sl">Today</div></div>
            <div className="stat-card"><div className="sn">{stats.checks.week}</div><div className="sl">This week</div></div>
            <div className="stat-card"><div className="sn">{stats.checks.avgPerSession}</div><div className="sl">Avg / session</div></div>
          </div>
          <h2 style={{ fontSize: 16.5, marginTop: 24 }}>Quality</h2>
          <div className="stat-grid">
            <div className="stat-card"><div className="sn">{stats.quality.avgFindingsPerCheck}</div><div className="sl">Avg findings / check</div></div>
            <div className="stat-card"><div className="sn">{stats.quality.sourceUsedPct}%</div><div className="sl">Checks with source</div></div>
            <div className="stat-card"><div className="sn">{stats.quality.usefulPct ?? '—'}{stats.quality.usefulPct != null ? '%' : ''}</div><div className="sl">Said review was useful</div></div>
            <div className="stat-card"><div className="sn">{stats.quality.caughtRealPct ?? '—'}{stats.quality.caughtRealPct != null ? '%' : ''}</div><div className="sl">Caught something real</div></div>
            <div className="stat-card"><div className="sn">{stats.quality.falsePositiveRate ?? '—'}{stats.quality.falsePositiveRate != null ? '%' : ''}</div><div className="sl">User-reported false positives</div></div>
            <div className="stat-card"><div className="sn">{stats.quality.semanticFailPct}%</div><div className="sl">Semantic review failures</div></div>
          </div>
          {stats.findingTypes.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h2 style={{ fontSize: 16.5 }}>Finding types</h2>
              {stats.findingTypes.map(([t, v]: [string, number]) => (
                <div key={t} className="bar-row"><span className="bar-label">{t}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.round(v / stats.findingTypes[0][1] * 100)}%` }} /></div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{v}</span></div>
              ))}
            </div>
          )}
        </div>
      )}

      {evalResult && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 16.5 }}>Checker evaluation — live run</h2>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Evaluator: {evalResult.evaluatorModel} · Verifier: {evalResult.verifierModel} · Extraction: {evalResult.extractionModel} · {evalResult.summary.totalCases} golden cases</p>
          <div className="stat-grid">
            <div className="stat-card"><div className="sn">{evalResult.summary.precision ?? '—'}</div><div className="sl">Precision</div></div>
            <div className="stat-card"><div className="sn">{evalResult.summary.recall ?? '—'}</div><div className="sl">Recall</div></div>
            <div className="stat-card"><div className="sn">{evalResult.summary.falsePositiveRate ?? '—'}</div><div className="sl">False positive rate</div></div>
            <div className="stat-card"><div className="sn">{evalResult.summary.evidenceAccuracy ?? '—'}</div><div className="sl">Evidence accuracy</div></div>
            <div className="stat-card"><div className="sn">{evalResult.summary.suggestionGroundingAccuracy ?? '—'}</div><div className="sl">Suggestion grounding</div></div>
            <div className="stat-card"><div className="sn">{evalResult.summary.requirementExtractionAccuracy ?? '—'}</div><div className="sl">Requirement extraction accuracy</div></div>
            <div className="stat-card"><div className="sn">{evalResult.summary.semanticFailures}</div><div className="sl">Semantic call failures</div></div>
          </div>
          <div style={{ marginTop: 16 }}>
            {evalResult.graded.map((g: any) => (
              <div key={g.id} className="notice" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>{g.id} <span style={{ color: 'var(--ink-faint)' }}>({g.category})</span></span>
                <strong style={{ color: g.classification === 'TP' || g.classification === 'TN' ? 'var(--passed)' : 'var(--critical)' }}>{g.classification}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
