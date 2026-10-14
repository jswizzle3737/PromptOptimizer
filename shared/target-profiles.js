/**
 * Target-model awareness and technique explanation.
 *
 * The extension is the only prompt optimizer that knows *where* the user is:
 * the content script runs inside ChatGPT, Claude, Gemini, Perplexity, DeepSeek,
 * Mistral, Grok and Copilot. Each target model responds best to a different prompt shape
 * (Claude reads XML structure reliably, Perplexity is search-first, etc.), so
 * the rewrite guidance adapts to the host. Host-locked apps (GC AI, Anthropic
 * Console) and host-blind web tools (AIPRM, PromptPerfect) cannot do this.
 *
 * Also owns the "technique chips": the short explanation of what the optimizer
 * added and why, shown under every result in the popup and the in-page panel.
 */

/* ------------------------------------------------------------------ */
/* Target-model profiles                                               */
/* ------------------------------------------------------------------ */

export const TARGET_PROFILES = [
  {
    id: 'claude',
    name: 'Claude',
    hosts: ['claude.ai'],
    systemGuidance:
      'Structure the rewritten prompt for Claude: use XML-style section tags such as <context>, <task>, ' +
      '<requirements> and <output_format> — Claude tracks XML structure reliably. Put long reference ' +
      'material first and the core instruction at the end.',
    offlineNote:
      'Claude follows XML structure best — sections below map to <context>, <task>, <requirements> and ' +
      '<output_format> tags. Wrap them if you want Claude-explicit formatting.'
  },
  {
    id: 'openai',
    name: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    systemGuidance:
      'Structure the rewritten prompt for ChatGPT: Markdown headings, the primary instruction up front, ' +
      'then numbered requirements and a short output-format section.',
    offlineNote:
      'Tuned for ChatGPT: the primary instruction leads, requirements are numbered, and the output format ' +
      'is stated explicitly.'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    hosts: ['gemini.google.com'],
    systemGuidance:
      'Structure the rewritten prompt for Google Gemini: concise directive sentences under Markdown ' +
      'headings; Gemini rewards explicit, unambiguous task statements over long prose.',
    offlineNote:
      'Tuned for Gemini: directive sentences and unambiguous task statements work best.'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    hosts: ['perplexity.ai'],
    systemGuidance:
      'Structure the rewritten prompt for Perplexity, a search-first product: one focused question per ' +
      'ask, explicit scope and time frame, and a requirement to cite sources with publication dates when ' +
      'freshness matters.',
    offlineNote:
      'Tuned for Perplexity: search-first — keep the question focused and ask for cited, dated sources.'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hosts: ['chat.deepseek.com'],
    systemGuidance:
      'Structure the rewritten prompt for DeepSeek: explicit step ordering and Markdown formatting; ' +
      'DeepSeek reasoning models do their own chain-of-thought, so state the goal and verification ' +
      'criteria rather than narrating reasoning.',
    offlineNote:
      'Tuned for DeepSeek: states the goal and checks to pass; the model handles its own chain-of-thought.'
  },
  {
    id: 'grok',
    name: 'Grok',
    hosts: ['grok.com'],
    systemGuidance:
      'Structure the rewritten prompt for xAI Grok: a direct primary instruction, Markdown sections, and ' +
      'an explicit request to separate verified facts from speculation, since Grok often draws on live posts.',
    offlineNote:
      'Tuned for Grok: direct instruction first, and facts kept separate from speculation.'
  },
  {
    id: 'copilot',
    name: 'Copilot',
    hosts: ['copilot.microsoft.com'],
    systemGuidance:
      'Structure the rewritten prompt for Microsoft Copilot: the primary instruction up front, numbered ' +
      'requirements, an explicit output-format section, and a request to cite web sources when it searches.',
    offlineNote:
      'Tuned for Copilot: instruction first, numbered requirements, cited sources when it searches.'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    hosts: ['chat.mistral.ai'],
    systemGuidance:
      'Structure the rewritten prompt for Mistral Le Chat: compact Markdown sections with numbered ' +
      'instructions and a clearly labelled expected-output section.',
    offlineNote:
      'Tuned for Mistral: compact sections with numbered instructions.'
  }
];

/**
 * Resolve a hostname (or full URL) to a target profile.
 * Returns null on anything unrecognised — no guidance is better than wrong guidance.
 */
export function getTargetProfile(hostOrUrl) {
  let host = String(hostOrUrl ?? '').trim().toLowerCase();
  if (!host) return null;
  if (host.includes('://')) {
    try { host = new URL(host).hostname; } catch { return null; }
  }
  if (host.startsWith('www.')) host = host.slice(4);
  for (const profile of TARGET_PROFILES) {
    if (profile.hosts.some(h => host === h || host.endsWith('.' + h))) return profile;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Techniques                                                          */
/* ------------------------------------------------------------------ */

/** Short chip label + the "why" shown on hover. */
export const TECHNIQUES = {
  persona: {
    label: 'Persona & perspective',
    detail: 'Assigns an expert role and point of view, so the answer is framed by the right judgment.'
  },
  context: {
    label: 'Context first',
    detail: 'States background and purpose before the task — context beats one-line asks.'
  },
  decomposition: {
    label: 'Step-by-step',
    detail: 'Breaks the work into ordered, separately checkable steps.'
  },
  outputContract: {
    label: 'Output contract',
    detail: 'Fixes the format, sections and tone of the answer, so it is structured instead of improvised.'
  },
  verification: {
    label: 'Verify & cite',
    detail: 'Requires quotes, citations or a self-check before conclusions — treat unsourced answers as drafts.'
  },
  edgeCases: {
    label: 'Edge cases',
    detail: 'Probes failure modes and boundary conditions up front.'
  },
  brevity: {
    label: 'Zero fluff',
    detail: 'Bans preambles and filler so the answer goes straight to the work.'
  },
  framework: {
    label: 'Custom framework',
    detail: 'Structured with your custom framework from Options.'
  }
};

/** Which techniques each built-in framework already embodies. */
export const FRAMEWORK_TECHNIQUES = {
  'smart-expand': ['persona', 'edgeCases', 'outputContract'],
  rtf: ['persona', 'outputContract'],
  create: ['context', 'persona', 'outputContract'],
  'chain-of-thought': ['persona', 'decomposition', 'verification'],
  concise: ['brevity', 'outputContract']
};

/* Short names for the persona signals detected by the offline heuristic. */
const PERSONA_CHIP = {
  code: 'Code persona detected',
  writing: 'Writing persona detected',
  analysis: 'Analysis persona detected'
};

/**
 * Build the explanation chips for a result.
 *
 * @param {object} args
 * @param {string} args.frameworkId - framework that produced the result
 * @param {object|null} [args.targetProfile] - from getTargetProfile()
 * @param {string|null} [args.signal] - 'code'|'writing'|'analysis' from the offline
 *   heuristic. Only pass it when the offline heuristic actually produced the
 *   result — an LLM engine picks its own persona, and the chip must not claim
 *   something the engine did not do.
 * @returns {Array<{ label: string, detail: string }>}
 */
export function buildExplanationChips({ frameworkId, targetProfile = null, signal = null }) {
  const chips = [];

  const ids = FRAMEWORK_TECHNIQUES[frameworkId] || ['framework'];
  for (const id of ids) {
    const t = TECHNIQUES[id];
    if (t) chips.push({ label: t.label, detail: t.detail });
  }

  if (signal && PERSONA_CHIP[signal]) {
    chips.unshift({
      label: PERSONA_CHIP[signal],
      detail: 'The offline heuristic read task keywords and picked the matching expert persona.'
    });
  }

  if (targetProfile) {
    chips.push({
      label: `Tuned for ${targetProfile.name}`,
      detail: targetProfile.systemGuidance || targetProfile.offlineNote || ''
    });
  }

  return chips;
}
