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

/** Cover concrete missing details for recognizable drafts without an AI engine. */
export function getOfflineClarifyQuestions(text) {
  const draft = String(text ?? '');
  if (/\b(?:trip|vacation|itinerary|holiday)\b/i.test(draft)) {
    const details = [
      [/\b(?:destination|(?:trip|travel|vacation|holiday|itinerary)\s+(?:to|in|for)\s+(?!me\b|us\b)[a-z])/i,
        'Where are you going?'],
      [/\b(?:dates?|next (?:week|month|year)|\d+[- ](?:days?|weeks?|nights?)|jan(?:uary)?|feb(?:ruary)?|march|april|may|june|july|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
        'What dates or duration should the itinerary cover?'],
      [/\b(?:budget|usd|cad|eur)\b|[$€£]\s*\d/i,
        'What is the total budget or daily spending range?']
    ];
    const questions = details.filter(([provided]) => !provided.test(draft)).map(([, question]) => question);
    if (questions.length) return questions;
  }
  return DEFAULT_CLARIFY_QUESTIONS;
}

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
