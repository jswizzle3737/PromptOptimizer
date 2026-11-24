/**
 * Optimization intensity — HOW FAR the original prompt may be changed.
 * Instructions only; hard drift limits belong in the evaluator (Slice 3).
 */

export const DEFAULT_INTENSITY = 'balanced';

export const INTENSITIES = [
  {
    value: 'light',
    label: 'Light',
    description: 'Minimal edits; keep the original wording where it still works.',
    instructions:
      'Make only minimal changes. Keep the draft\'s wording, order and structure where they ' +
      'still work, and fix only what is unclear or missing.'
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Improve clarity and completeness without gratuitous restructuring.',
    instructions: ''
  },
  {
    value: 'aggressive',
    label: 'Aggressive',
    description: 'Reconstruct freely while preserving every requirement.',
    instructions:
      'You may restructure and rewrite the draft substantially, including its order and ' +
      'format, provided every requirement and every verbatim token in the original survives.'
  }
];

export function isIntensity(value) {
  return INTENSITIES.some(item => item.value === value);
}

export function getIntensity(value) {
  return INTENSITIES.find(item => item.value === value) || INTENSITIES.find(item => item.value === DEFAULT_INTENSITY);
}

export function intensityInstructions(value) {
  return getIntensity(value).instructions || '';
}
