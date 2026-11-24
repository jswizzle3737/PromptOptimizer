/**
 * Optimization modes — WHAT is being optimized.
 *
 * A mode contributes system guidance; a framework (shared/frameworks.js) still
 * decides HOW the result is organized, the target model decides for WHOM, and
 * intensity decides HOW FAR the original may be changed. Keeping those four
 * separate is what lets a new mode be added without touching the engine.
 *
 * Built-in modes are data, not classes. User overrides are intended to live in
 * a separate `promptcraft_modes` store so `promptcraft_frameworks` is never
 * touched by a mode migration.
 */

export const DEFAULT_MODE = 'general';

export const MODES = [
  {
    id: 'general',
    name: 'General',
    description: 'Improve clarity and specificity without imposing a structure.',
    instructions: '',
    validate: []
  },
  {
    id: 'system',
    name: 'System Prompt',
    description: 'Persistent behavioural instructions rather than a one-off task.',
    instructions:
      'Write persistent behavioural instructions: scope, role, voice, boundaries and ' +
      'behaviour under uncertainty or failure. Keep task-specific examples out unless ' +
      'the draft asked for them.',
    validate: ['intent', 'boundaries']
  },
  {
    id: 'reasoning',
    name: 'Reasoning',
    description: 'Hard analysis without unnecessary chain-of-thought directives.',
    instructions:
      'Do not ask the model to narrate its chain of thought. State the goal, the constraints, ' +
      'and the criteria by which the answer can be checked; leave the reasoning to the model ' +
      'and any native reasoning controls it has.',
    validate: ['intent', 'verification']
  },
  {
    id: 'agentic',
    name: 'Agentic',
    description: 'Tools, permissions and autonomous execution with explicit boundaries.',
    instructions:
      'Define the permitted tools and permissions, the boundaries on autonomous action, ' +
      'explicit stop and escalation conditions, and how results are reported. Do not ' +
      'authorize actions the original draft did not authorize.',
    validate: ['intent', 'boundaries', 'security']
  },
  {
    id: 'coding',
    name: 'Coding',
    description: 'Implementation, debugging and testing work.',
    instructions:
      'Preserve identifiers, file paths, API names and code snippets exactly. Specify ' +
      'inputs, outputs, relevant edge cases and the tests that would prove the ' +
      'implementation works.',
    validate: ['intent', 'tokens', 'verification']
  }
];

export function getMode(id) {
  return MODES.find(mode => mode.id === id) || MODES.find(mode => mode.id === DEFAULT_MODE);
}

export function isMode(id) {
  return MODES.some(mode => mode.id === id);
}

export function modeInstructions(id) {
  return getMode(id).instructions || '';
}
