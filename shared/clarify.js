/**
 * "Ask me first": pure helpers shared by the engine (which asks the model for
 * questions) and the surfaces (which fold the answers into the draft). No
 * storage and no DOM, so the in-page panel can load it.
 */

/** Asked when no engine can generate draft-specific questions. */
export const DEFAULT_CLARIFY_QUESTIONS = [
  'Who is the answer for, and how much do they already know?',
  'What should the result look like (format, length, sections)?',
  'Anything it must include or avoid?'
];

/** One question per line; numbering and bullets stripped; at most three. */
export function parseQuestions(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(l => l.length > 3)
    .slice(0, 3);
}

/** Fold clarifying answers into the draft; unanswered questions are dropped. */
export function withAnswers(rawPrompt, answers) {
  const lines = (answers || [])
    .filter(a => a && String(a.answer ?? '').trim())
    .map(a => `- ${String(a.question ?? '').trim()} ${String(a.answer).trim()}`);
  const draft = String(rawPrompt ?? '').trim();
  return lines.length ? `${draft}\n\nDetails:\n${lines.join('\n')}` : draft;
}
