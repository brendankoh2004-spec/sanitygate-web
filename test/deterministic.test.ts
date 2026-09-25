import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runDeterministic, findTerm, countWords, countListItems } from '../lib/validators/deterministic';
import { DEFAULT_ADDITIONAL, sanitizeAdditional } from '../lib/types';
import { check, done } from './helpers';

const adv = (o: object) => ({ ...DEFAULT_ADDITIONAL, ...o });
const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- word count ----------------------------------------------------------
{
  const text = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  check('word count: counts whitespace-delimited words', countWords(text) === 60 && countWords('  ') === 0 && countWords('a\nb\tc') === 3);
  let r = runDeterministic(text, adv({ maxWords: true, maxWordsVal: 50 }));
  check('max words: 60 > 50 -> one finding, structural, no passage', r.findings.length === 1 && r.findings[0].category === 'structural' && r.findings[0].passage === null && /10 words over/.test(r.findings[0].reason), JSON.stringify(r.findings));
  r = runDeterministic(text, adv({ maxWords: true, maxWordsVal: 60 }));
  check('max words: exactly at limit passes (boundary)', r.findings.length === 0 && r.passed.some(p => /60-word limit/.test(p)));
  r = runDeterministic(text, adv({ minWords: true, minWordsVal: 61 }));
  check('min words: 60 < 61 -> finding', r.findings.length === 1 && /below|under/.test(r.findings[0].reason));
  r = runDeterministic(text, adv({ minWords: true, minWordsVal: 60, maxWords: true, maxWordsVal: 500 }));
  check('min/max words: both satisfied -> clean', r.findings.length === 0 && r.passed.length >= 2);
}

// ---- forbidden terms -----------------------------------------------------
{
  let r = runDeterministic('We compete with RivalCorp daily.', adv({ forbiddenTerms: true, forbiddenTermsVal: 'rivalcorp' }));
  check('forbidden: case-insensitive hit with exact passage', r.findings.length === 1 && r.findings[0].passage?.text === 'RivalCorp' && r.findings[0].severity === 'critical');
  check('forbidden: hit carries a removal edit anchored to original offsets', r.findings[0].edit?.replacement === '' && r.findings[0].edit?.original === 'RivalCorp' && r.findings[0].edit?.start === 16);
  r = runDeterministic('Our category leader.', adv({ forbiddenTerms: true, forbiddenTermsVal: 'cat' }));
  check('forbidden: whole-word only ("cat" does not match "category")', r.findings.length === 0 && r.passed.includes('No forbidden terms found'));
  r = runDeterministic('A cat sat. Another CAT. Cat!', adv({ forbiddenTerms: true, forbiddenTermsVal: 'cat' }));
  check('forbidden: every whole-word occurrence flagged', r.findings.length === 3);
  r = runDeterministic('This is a real estate deal.', adv({ forbiddenTerms: true, forbiddenTermsVal: 'real estate, mortgage' }));
  check('forbidden: multi-word phrase + list', r.findings.length === 1 && r.findings[0].passage?.text === 'real estate');
  r = runDeterministic('Clean text here.', adv({ forbiddenTerms: true, forbiddenTermsVal: 'foo, bar' }));
  check('forbidden: clean output -> no findings', r.findings.length === 0);
  check('forbidden: regex metacharacters are literal', findTerm('cost (approx.) is $5', 'approx.').length === 1 && findTerm('cost approxX is', 'approx.').length === 0);
  r = runDeterministic('anything', adv({ forbiddenTerms: true, forbiddenTermsVal: ' , ,' }));
  check('forbidden: empty term list is a no-op', r.findings.length === 0);
}

// ---- required terms / format / placeholders -----------------------------
{
  let r = runDeterministic('We sell widgets.', adv({ requiredTerms: true, requiredTermsVal: 'widgets, warranty' }));
  check('required: reports only the missing term', r.findings.length === 1 && /warranty/.test(r.findings[0].reason) && !/widgets/.test(r.findings[0].reason));
  r = runDeterministic('Widgets with Warranty.', adv({ requiredTerms: true, requiredTermsVal: 'widgets, warranty' }));
  check('required: all present (case-insensitive) -> clean', r.findings.length === 0);
  r = runDeterministic('- one\n- two', adv({ bulletFormat: true }));
  check('bullets: present passes', r.findings.length === 0);
  r = runDeterministic('plain prose', adv({ bulletFormat: true, numberedFormat: true }));
  check('bullets/numbered: absence flagged (2 findings)', r.findings.length === 2);
  r = runDeterministic('1. a\n2) b', adv({ numberedFormat: true }));
  check('numbered: present passes', r.findings.length === 0);
  r = runDeterministic('Dear [Customer Name], your {{plan}} is ready. XXX', adv({}));
  check('placeholders: three kinds detected with exact passages', r.findings.length === 3 && r.findings.every(f => !!f.passage && f.edit === null), JSON.stringify(r.findings.map(f => f.passage?.text)));
  r = runDeterministic('Perfectly finished text.', adv({}));
  check('clean output: no findings, placeholder pass recorded', r.findings.length === 0 && r.passed.length === 1);
  check('countListItems: max of bullets/numbered', countListItems('- a\n- b\n1. x') === 2 && countListItems('prose') === 0);
}

// ---- scope guard: the deterministic layer does NOT judge numbers/dates/meaning ----
{
  const r = runDeterministic('Revenue was $9.99 million, up 80% on 1 January 2031. The Business plan costs $19/user.', adv({}));
  check('numbers/percentages/dates/money in the output are never judged deterministically', r.findings.length === 0, JSON.stringify(r.findings));
  const src = fs.readFileSync(path.join(DIR, '../lib/validators/deterministic.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('runDeterministic takes no request argument (cannot compare request to output)', /runDeterministic\(output: string, adv: AdditionalChecks\)/.test(src));
  check('no numeric/money/percent/date matching code remains in the deterministic file', !/MONEY_RE|PERCENT_RE|valuesEqual|overlapScore|contextWords|numerical_mismatch|extractNumbers/.test(src));
}

// ---- sanitizeAdditional --------------------------------------------------
{
  const s = sanitizeAdditional({ maxWords: 'yes', maxWordsVal: 'abc', requiredTermsVal: 42, forbiddenTerms: true, forbiddenTermsVal: 'x', minWordsVal: -5, evil: 1 });
  check('sanitizeAdditional: coerces junk safely', s.maxWords === false && s.maxWordsVal === 500 && s.requiredTermsVal === '' && s.forbiddenTerms === true && s.minWordsVal === 50 && !('evil' in s));
  check('sanitizeAdditional: null/garbage -> defaults', JSON.stringify(sanitizeAdditional(null)) === JSON.stringify(DEFAULT_ADDITIONAL) && JSON.stringify(sanitizeAdditional('x')) === JSON.stringify(DEFAULT_ADDITIONAL));
}

done();
