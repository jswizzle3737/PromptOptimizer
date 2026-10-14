/**
 * Prompt quality scoring.
 *
 * Two layers, both on-device:
 *
 * 1. A deterministic rule-based rubric (this file, `scorePrompt`). It checks
 *    the rewrite for concrete, checkable traits — expert role, output format,
 *    step-by-step structure, constraints, verification, success criteria — and
 *    returns 0-100. Deterministic means it is unit-testable as an output
 *    contract: every default framework's offline template must score 100
 *    against its own targeted traits (see unit/scorer.test.mjs).
 *
 * 2. An optional Gemini Nano judge (`judgeWithNano`) that rates the rewrite
 *    like a reader would. Used only when the Nano engine produced the result
 *    and the rule score is uncertain (< 80), so a good rewrite never pays the
 *    extra latency. Any failure degrades silently to rules-only.
 *
 * Scoring is framework-aware: `contractTraitIds` narrows the rubric to the
 * traits a framework actually targets (from FRAMEWORK_TECHNIQUES), so Concise
 * is not punished for dropping the persona it intentionally omits. Custom
 * frameworks fall back to the full rubric.
 */

import { FRAMEWORK_TECHNIQUES } from './target-profiles.js';

/* ------------------------------------------------------------------ */
/* Rubric                                                              */
/* ------------------------------------------------------------------ */

export const SCORING_TRAITS = [
  {
    id: 'role', label: 'Expert role', weight: 20,
    test: t => /\b(act as|you are|adopt|persona|take the role|as an expert|as a|as the)\b/i.test(t)
  },
  {
    id: 'format', label: 'Output format', weight: 20,
    test: t => /(output format|deliverable|expected output|format(?:ted|ting)?\b|markdown|json|table|headings?|bullets?|sections?)/i.test(t)
  },
  {
    id: 'steps', label: 'Step-by-step', weight: 15,
    test: t => /(step[- ]by[- ]step|\n\s*\d+\.\s|first,|decompose|break\b[^.]*\binto|ordered steps|execution guidelines)/i.test(t)
  },
  {
    id: 'constraints', label: 'Constraints & edge cases', weight: 15,
    test: t => /(constraint|edge case|requirement|must not|do not|don't|limitations?|trade-?offs?|pitfalls?|prerequisites?|failure modes?)/i.test(t)
  },
  {
    id: 'verification', label: 'Verify & cite', weight: 10,
    test: t => /(verif|valid|self-?check|sanity|double-?check|cite|citation|quote|sources?|assumptions?)/i.test(t)
  },
  {
    id: 'context', label: 'Context first', weight: 15,
    test: t => /(context|background|purpose|circumstances|problem statement)/i.test(t)
  },
  {
    id: 'success', label: 'Success criteria', weight: 20,
    test: t => /(success|criteria|quality bar|must include|acceptance|immediately actionable|high-impact|what good looks like|expected deliverable)/i.test(t)
  }
];

/** FRAMEWORK_TECHNIQUES ids → rubric trait ids. `brevity` has no reliable
    text test, so it never enters the denominator. */
const TECHNIQUE_TO_TRAIT = {
  persona: 'role',
  context: 'context',
  decomposition: 'steps',
  outputContract: 'format',
  edgeCases: 'constraints',
  verification: 'verification'
};

/**
 * The trait ids a framework's rewrite contractually targets, or null when the
 * full rubric applies (custom frameworks).
 */
export function contractTraitIds(frameworkId) {
  const ids = FRAMEWORK_TECHNIQUES[frameworkId];
  if (!ids) return null;
  const mapped = [...new Set(ids.map(id => TECHNIQUE_TO_TRAIT[id]).filter(Boolean))];
  return mapped.length ? mapped : null;
}

/* ------------------------------------------------------------------ */
/* Rule-based scoring                                                  */
/* ------------------------------------------------------------------ */

/**
 * Score a prompt against the rubric.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string[]|null} [options.traitIds] - limit the rubric to these trait
 *   ids (framework contract). Null/undefined = full rubric.
 * @returns {{ score: number|null, hit: Array, missed: Array }}
 *   `score` is null only when the chosen contract has no text-checkable
 *   traits, in which case the UI hides the chip.
 */
export function scorePrompt(text, { traitIds = null } = {}) {
  const traits = traitIds
    ? SCORING_TRAITS.filter(t => traitIds.includes(t.id))
    : SCORING_TRAITS;

  const totalWeight = traits.reduce((sum, t) => sum + t.weight, 0);
  if (!traits.length || totalWeight === 0) return { score: null, hit: [], missed: [] };

  const hit = [];
  const missed = [];
  for (const trait of traits) {
    (trait.test(String(text ?? '')) ? hit : missed).push({ id: trait.id, label: trait.label, weight: trait.weight });
  }

  const earned = hit.reduce((sum, t) => sum + t.weight, 0);
  return { score: Math.round((earned / totalWeight) * 100), hit, missed };
}

/* ------------------------------------------------------------------ */
/* Nano judge (optional refinement)                                    */
/* ------------------------------------------------------------------ */

const JUDGE_SYSTEM_PROMPT =
  'You are a strict prompt-quality reviewer. You will be shown a raw draft and an ' +
  'improved rewrite of it. Rate ONLY the rewrite: how well it specifies the role, ' +
  'context, constraints, structure and success criteria a strong answer needs. ' +
  'Reply with a single JSON object and nothing else: {"score": <0-100>, "note": "<one sentence>"}';

/** Skip the model judge when the rule check is already confident. */
export const NANO_JUDGE_RULE_THRESHOLD = 80;

/**
 * Judge a rewrite with Chrome's built-in model. Never throws: any failure
 * (unsupported, busy, unparseable reply) resolves to null and the caller
 * falls back to the rule score.
 */
export async function judgeWithNano(rawPrompt, optimized, timeoutMs = 15000) {
  let session;
  try {
    const LanguageModel = globalThis.LanguageModel;
    if (!LanguageModel) return null;

    let availability;
    try {
      availability = await LanguageModel.availability();
    } catch {
      return null;
    }
    if (availability !== 'available') return null;

    session = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: JUDGE_SYSTEM_PROMPT }]
    });

    const reply = await session.prompt(
      `Raw draft:\n<raw_prompt>\n${String(rawPrompt ?? '').slice(0, 4000)}\n</raw_prompt>\n\n` +
      `Rewrite to judge:\n<rewrite>\n${String(optimized ?? '').slice(0, 6000)}\n</rewrite>`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );

    const m = String(reply ?? '').match(/"score"\s*:\s*(\d{1,3})/);
    if (!m) return null;
    const score = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    if (Number.isNaN(score)) return null;
    return { score };
  } catch {
    return null;
  } finally {
    try { session?.destroy?.(); } catch { /* already gone */ }
  }
}

/* ------------------------------------------------------------------ */
/* Variant ranking                                                     */
/* ------------------------------------------------------------------ */

/**
 * Rank variants best-first by score. Stable for ties ( Array.prototype.sort is
 * stable in modern engines, and we re-tie on label so the order is fully
 * deterministic for tests).
 */
export function rankVariants(variants) {
  return [...variants].sort((a, b) =>
    ((b.score ?? -1) - (a.score ?? -1)) || String(a.label).localeCompare(String(b.label)));
}
