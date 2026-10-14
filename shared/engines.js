/**
 * Engine catalogue — single source of truth for the optimization engines.
 *
 * Previously re-listed in popup.js, options.js and content.js, with the copies
 * drifting apart. `label`/`desc` are the compact forms used in the popup and the
 * in-page modal; `fullLabel`/`fullDesc` are the spelled-out forms for Options.
 */

export const ENGINES = [
  {
    value: 'nano', icon: 'cpu',
    label: 'Chrome Nano', desc: 'On-device',
    fullLabel: 'Chrome built-in Nano', fullDesc: 'On-device, private'
  },
  {
    value: 'offline', icon: 'shield',
    label: 'Offline', desc: 'No API required',
    fullLabel: 'Offline frameworks', fullDesc: 'No API required'
  },
  {
    value: 'openrouter', icon: 'branch',
    label: 'OpenRouter', desc: 'Your key',
    fullLabel: 'OpenRouter', fullDesc: 'Your API key · free models available'
  },
  {
    value: 'gemini', icon: 'cloud',
    label: 'Gemini', desc: 'Your key',
    fullLabel: 'Google Gemini', fullDesc: 'Your API key'
  },
  {
    value: 'openai', icon: 'cloud',
    label: 'OpenAI', desc: 'Your key',
    fullLabel: 'OpenAI', fullDesc: 'Your API key'
  },
  {
    value: 'anthropic', icon: 'cloud',
    label: 'Claude', desc: 'Your key',
    fullLabel: 'Anthropic Claude', fullDesc: 'Your API key'
  }
];

export const DEFAULT_ENGINE = 'nano';

export const ENGINE_LABELS = Object.fromEntries(ENGINES.map(e => [e.value, e.label]));

export function isEngine(value) {
  return ENGINES.some(e => e.value === value);
}

/**
 * Options in the shape `createSelect` expects.
 * @param {{ full?: boolean }} [cfg]  `full` selects the spelled-out Options wording.
 */
export function engineOptions({ full = false } = {}) {
  return ENGINES.map(e => ({
    value: e.value,
    label: full ? e.fullLabel : e.label,
    desc: full ? e.fullDesc : e.desc,
    icon: e.icon
  }));
}
