/**
 * Realistic long-form case: Q3 2026 Singapore Consumer Electronics summary.
 * Shared by the mocked pipeline tests (test/q3_long_case.test.ts) and the
 * live-model script (evaluation/run_q3_live.ts).
 */

export const Q3_REQUEST = `Write a Q3 2026 performance summary of about 200 words for the Singapore Consumer Electronics division, for the executive committee. Use the figures below exactly as given.

Instructions:
- Cover four things: revenue, profitability, the loyalty programme, and Q4 plans.
- Do not mention any competitor by name.
- Do not state that the Connected Living campaign caused the revenue growth.
- End with a clear call to action inviting the committee to the Q4 planning session.

Reference information:
Total revenue for Q3 2026 was S$8.42 million, up 6.3% from Q3 2025 (S$7.92 million).
Online sales contributed S$3.54 million of the Q3 2026 revenue.
Gross margin improved to 42.0% in Q3 2026 from 39.5% in Q3 2025.
Operating profit was S$1.17 million in Q3 2026, compared with S$0.96 million in Q3 2025.
Marketing spend was S$2.87 million in Q3 2026.
The loyalty programme grew to more than 4,820 members, enrolled between August 15 and September 30, 2026.
Management has not established a causal relationship between the Connected Living campaign and the division's revenue growth.
No store expansion has been formally approved for Q4.
The Q4 promotional plan launches on November 30, 2026.
The Q4 planning session is on October 22, 2026.`;

/** Correct output using deliberately DIFFERENT wording/notation ("S$960,000", "42%", "through the end of September"). Should be clean. */
export const Q3_GOOD_OUTPUT = `Q3 2026 was a solid quarter for the Singapore Consumer Electronics division. Total revenue reached S$8.42 million, up 6.3% from S$7.92 million a year earlier, with online sales contributing S$3.54 million of that total.

Profitability improved: gross margin rose to 42% from 39.5%, and operating profit was S$1.17 million compared with S$960,000 in Q3 2025. Marketing spend for the quarter was S$2.87 million.

The loyalty programme now has more than 4,820 members, who enrolled from August 15 through the end of September.

Looking ahead, no store expansion has been formally approved for Q4. The Q4 promotional plan launches on November 30, 2026.

We invite the committee to join the Q4 planning session on October 22, 2026 to shape the plan.`;

/** Deliberately introduced errors (see Q3_ERRORS) plus correct decoys (S$960,000, 42%, S$3.54 million for ONLINE sales, S$2.87 million marketing). */
export const Q3_BAD_OUTPUT = `Q3 2026 was a strong quarter for the Singapore Consumer Electronics division. Total revenue reached S$3.54 million, up 6.3% from S$7.92 million a year earlier, while online sales were S$3.54 million.

Profitability improved: gross margin rose to 42% from 39.5%, and operating profit was S$1.17 million compared with S$960,000 in Q3 2025. Marketing spend for the quarter was S$2.87 million. Unlike RivalCorp, our results were driven by the Connected Living campaign, which drove the revenue growth.

The division has approved plans to open two additional stores in Q4. The Q4 promotional plan launches on December 15, 2026.

Please join us for the discussion.`;

export interface Q3Error {
  id: string;
  category: 'factual_contradiction' | 'instruction_violation' | 'unsupported_addition' | 'omission';
  outputQuote: string;              // '' for an omission
  requestFragment: string;          // verbatim fragment of Q3_REQUEST that governs it
  fix?: { original: string; replacement: string };
}

export const Q3_ERRORS: Q3Error[] = [
  { id: 'wrong_metric_value', category: 'factual_contradiction', outputQuote: 'Total revenue reached S$3.54 million', requestFragment: 'Total revenue for Q3 2026 was S$8.42 million', fix: { original: 'S$3.54 million, up 6.3%', replacement: 'S$8.42 million, up 6.3%' } },
  { id: 'prohibited_competitor', category: 'instruction_violation', outputQuote: 'Unlike RivalCorp, ', requestFragment: 'Do not mention any competitor by name.', fix: { original: 'Unlike RivalCorp, ', replacement: '' } },
  { id: 'unsupported_causal', category: 'unsupported_addition', outputQuote: 'which drove the revenue growth', requestFragment: 'Management has not established a causal relationship between the Connected Living campaign and the division\'s revenue growth.', fix: { original: ', which drove the revenue growth', replacement: '' } },
  { id: 'negation_contradiction', category: 'factual_contradiction', outputQuote: 'The division has approved plans to open two additional stores in Q4.', requestFragment: 'No store expansion has been formally approved for Q4.', fix: { original: 'The division has approved plans to open two additional stores in Q4.', replacement: 'No store expansion has been formally approved for Q4.' } },
  { id: 'wrong_date', category: 'factual_contradiction', outputQuote: 'launches on December 15, 2026', requestFragment: 'The Q4 promotional plan launches on November 30, 2026.', fix: { original: 'December 15, 2026', replacement: 'November 30, 2026' } },
  { id: 'omitted_loyalty', category: 'omission', outputQuote: '', requestFragment: 'Cover four things: revenue, profitability, the loyalty programme, and Q4 plans.' },
  { id: 'omitted_cta', category: 'omission', outputQuote: '', requestFragment: 'End with a clear call to action inviting the committee to the Q4 planning session.' },
];
