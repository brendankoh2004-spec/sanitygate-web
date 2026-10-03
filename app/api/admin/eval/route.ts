import { NextRequest, NextResponse } from 'next/server';
import goldenCases from '@/evaluation/golden_cases.json';
import { runGoldenCase, summarize, describeModels, GoldenCase, GradedCase } from '@/evaluation/metrics';
import { getProvider } from '@/lib/llm';
import { Providers } from '@/lib/pipeline';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300; // 50 cases x (3 parallel reviewers + 1 adjudication) can take a while on a free model

function isAdmin(req: NextRequest): boolean {
  const key = req.headers.get('x-admin-key');
  return !!key && !!process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY;
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let providers: Providers;
  try {
    providers = { direct: getProvider('direct'), coverage: getProvider('coverage'), reverse: getProvider('reverse'), adjudicator: getProvider('adjudicator') };
  } catch (e: any) {
    return NextResponse.json({ error: 'no_provider', message: e.message }, { status: 500 });
  }

  const cases = goldenCases as unknown as GoldenCase[];
  const graded: GradedCase[] = [];
  for (const c of cases) {
    try {
      graded.push(await runGoldenCase(providers, c));
    } catch (e: any) {
      graded.push({ id: c.id, category: c.category, classification: 'FN', matched: [], evidenceOk: null, suggestionOk: null, semanticError: 'exception', durationMs: 0 });
    }
  }
  const summary = summarize(graded);
  const models = describeModels(providers);

  const supabase = getSupabase();
  if (supabase) {
    await supabase.from('eval_runs').insert({
      reviewer_model: `direct=${models.direct} coverage=${models.coverage} reverse=${models.reverse}`,
      adjudicator_model: models.adjudicator,
      total_cases: summary.totalCases,
      true_positives: summary.truePositives, false_positives: summary.falsePositives,
      false_negatives: summary.falseNegatives, true_negatives: summary.trueNegatives,
      precision: summary.precision, recall: summary.recall, false_positive_rate: summary.falsePositiveRate,
      evidence_accuracy: summary.evidenceAccuracy, suggestion_grounding_accuracy: summary.suggestionGroundingAccuracy,
      details: graded,
    }).then(({ error }) => { if (error) console.error('failed to store eval run:', error.message); });
  }

  return NextResponse.json({ models, summary, graded });
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const supabase = getSupabase();
  if (!supabase) return NextResponse.json({ runs: [] });
  const { data } = await supabase.from('eval_runs').select('*').order('created_at', { ascending: false }).limit(20);
  return NextResponse.json({ runs: data || [] });
}
