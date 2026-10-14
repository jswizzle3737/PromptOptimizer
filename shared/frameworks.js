/**
 * PromptOptimizer Frameworks & Rule-Based Optimizers
 * Supports user-editable, customizable, and dynamically extensible frameworks.
 *
 * Framework definitions are persisted to chrome.storage.local on first use, so
 * a change to DEFAULT_FRAMEWORKS below does NOT reach an existing install.
 * Any shape change must go through `migrateFrameworks`.
 */

import { hasIcon } from './icons.js';

export const DEFAULT_FRAMEWORKS = [
  {
    id: 'smart-expand',
    name: 'Smart Expand',
    tagline: 'Clarifies intent, adds persona, constraints & step-by-step execution.',
    icon: 'wand',
    isDefault: true,
    systemPrompt: `You are an elite Prompt Engineer. Your task is to rewrite the user's raw prompt into a highly effective, professional-grade prompt for advanced LLMs.
Rules:
1. Identify the core intent and assign an appropriate expert persona/role.
2. Structure with clear sections: [Role & Objective], [Context], [Specific Requirements & Constraints], and [Output Format].
3. Add relevant edge cases and quality criteria.
4. Output ONLY the improved prompt. Do not add introductory or conversational pleasantries.`,
    template: `Act as a {{persona}}.

**Objective:**
{{prompt}}

**Requirements & Constraints:**
1. Provide an in-depth, rigorous solution addressing all aspects of the objective.
2. Highlight critical considerations, practical trade-offs, and best practices.
3. Address edge cases and potential failure modes proactively.
4. Ensure the solution is immediately actionable.

**Deliverable Format:**
- Structure with clear Markdown headers, concise explanations, and bulleted takeaways.
- Include concrete examples or implementation snippets where applicable.
- Conclude with high-impact next steps.`
  },
  {
    id: 'rtf',
    name: 'RTF',
    tagline: 'Role, Task, Format — the standard enterprise three-part frame.',
    icon: 'ruler',
    isDefault: true,
    systemPrompt: `Transform the user's input into the strict RTF (Role-Task-Format) prompt framework.
Structure:
- **Role**: Define the exact domain expert persona and authority.
- **Task**: Detail the precise action, core deliverable, and step-by-step instructions.
- **Format**: Specify the exact output schema, tone, length, and styling (e.g., Markdown tables, bulleted hierarchy, or JSON).
Output ONLY the structured RTF prompt.`,
    template: `### ROLE
Act as a {{persona}}.

### TASK
Your objective is to accomplish the following task:
"{{prompt}}"

Follow these execution guidelines:
1. Provide a comprehensive, accurate, and deeply reasoned solution.
2. Explicitly address relevant edge cases, prerequisites, and common pitfalls.
3. Validate all assumptions before finalizing conclusions.

### FORMAT
- Organize your response using clear Markdown headings (H2, H3) and bullet points.
- {{deliverable}}.
- Maintain an authoritative, precise, and professional tone throughout.`
  },
  {
    id: 'create',
    name: 'CREATE',
    tagline: 'Context, Role, Instructions, Audience, Tone, Execution.',
    icon: 'layers',
    isDefault: true,
    systemPrompt: `Transform the user's prompt into the comprehensive CREATE framework:
- **Context**: Background circumstances, purpose, and problem statement.
- **Role**: Specific persona, mindset, and perspective to adopt.
- **Explicit Instructions**: Numbered, unambiguous directions with clear boundaries and "do not" constraints.
- **Audience**: Who will consume the final output and their knowledge level.
- **Tone & Style**: Desired voice (e.g., authoritative, analytical, conversational).
- **Execution / Expected Output**: The exact structure and deliverables required.
Output ONLY the formatted CREATE prompt.`,
    template: `### 1. CONTEXT
I need expert guidance to address the following objective:
"{{prompt}}"

### 2. ROLE
Adopt the mindset and knowledge base of a {{persona}}.

### 3. EXPLICIT INSTRUCTIONS
- Address the core problem thoroughly and systematically.
- Provide step-by-step reasoning and breakdown.
- Highlight any trade-offs, security considerations, or optimization opportunities.
- Avoid generic advice; offer specific, implementable solutions.

### 4. AUDIENCE
Tailored for {{audience}}.

### 5. TONE & STYLE
Objective, analytical, structured, and unambiguous.

### 6. EXPECTED OUTPUT
{{deliverable}} formatted with clean Markdown structure.`
  },
  {
    id: 'chain-of-thought',
    name: 'Reasoning',
    tagline: 'Forces deep step-by-step reasoning, assumption validation, and self-critique.',
    icon: 'brain',
    isDefault: true,
    systemPrompt: `Rewrite the user's prompt into a deep Reasoning & Verification prompt that forces the AI to think critically before answering.
Rules:
1. Instruct the AI to explicitly state its initial assumptions and decompose the problem into sub-steps.
2. Demand an internal chain of reasoning and analysis of alternative hypotheses.
3. Require an explicit self-verification / sanity-check step before delivering the final answer.
4. Output ONLY the optimized prompt.`,
    template: `You are a {{persona}}. 

Your objective is:
"{{prompt}}"

Before presenting your final answer, please execute this deliberate reasoning process:
1. **Deconstruction & Assumptions**: Break down the problem into fundamental components and state all underlying assumptions.
2. **Analysis & Step-by-Step Reasoning**: Walk through the analysis systematically, evaluating alternative approaches and potential counter-arguments.
3. **Verification & Edge Cases**: Test your solution against edge cases and identify any potential failure modes.
4. **Final Deliverable**: Present the clear, refined solution formatted with structured Markdown headings.`
  },
  {
    id: 'concise',
    name: 'Concise',
    tagline: 'Strips fluff, disables conversational filler, demands raw actionable output.',
    icon: 'minimize',
    isDefault: true,
    systemPrompt: `Rewrite the prompt into a minimal, zero-fluff directive.
Rules:
1. Demand direct, actionable responses with zero preamble, zero conversational pleasantries, and no summary conclusion.
2. If code or data is requested, enforce pure code/raw tables/JSON without conversational prose.
3. Keep the prompt punchy, authoritative, and direct.
4. Output ONLY the rewritten prompt.`,
    template: `Task: {{prompt}}

Directives:
- Provide direct, concise output with zero conversational fluff, greetings, or postamble summaries.
- Deliverable: {{deliverable}}.
- Include only strictly necessary explanation. If code/data is involved, output clean, production-ready syntax directly.`
  }
];

/**
 * Emoji that shipped as `icon` values before v1.1.0, mapped to icon-set names.
 * Keys are matched with the variation selector stripped — see `normalizeIconKey`.
 */
const LEGACY_ICON_MAP = {
  '\u2728': 'wand',           // sparkles
  '\uD83D\uDCD0': 'ruler',    // triangular ruler
  '\uD83C\uDFD7': 'layers',   // building construction
  '\uD83E\uDDE0': 'brain',    // brain
  '\u26A1': 'minimize'        // high voltage
};

/** Strip the emoji variation selector so the two forms of an emoji match. */
function normalizeIconKey(value) {
  return String(value ?? '').replace(/\uFE0F/g, '');
}

/**
 * Bring a stored framework into the current shape.
 * Only touches `icon`, so user edits to names, taglines, prompts and templates
 * survive untouched. Returns { frameworks, changed }.
 */
export function migrateFrameworks(stored) {
  if (!Array.isArray(stored) || stored.length === 0) {
    return { frameworks: DEFAULT_FRAMEWORKS, changed: false };
  }

  let changed = false;
  const frameworks = stored.map(fw => {
    if (fw && typeof fw === 'object' && !hasIcon(fw.icon)) {
      changed = true;
      const mapped = LEGACY_ICON_MAP[normalizeIconKey(fw.icon)];
      return { ...fw, icon: mapped || 'wand' };
    }
    return fw;
  });

  return { frameworks, changed };
}

/**
 * Loads the user's customized frameworks from chrome.storage.local.
 * Falls back to DEFAULT_FRAMEWORKS if none saved.
 */
export async function getFrameworks() {
  const result = await chrome.storage.local.get('promptcraft_frameworks');
  const stored = result.promptcraft_frameworks;

  if (Array.isArray(stored) && stored.length > 0) {
    const { frameworks, changed } = migrateFrameworks(stored);
    // Persist the migration once so the fix is not recomputed on every read.
    if (changed) await chrome.storage.local.set({ promptcraft_frameworks: frameworks });
    return frameworks;
  }

  // Initialize defaults in storage
  await chrome.storage.local.set({ promptcraft_frameworks: DEFAULT_FRAMEWORKS });
  return DEFAULT_FRAMEWORKS;
}

/**
 * Saves the full list of frameworks.
 */
export async function saveFrameworks(frameworks) {
  await chrome.storage.local.set({ promptcraft_frameworks: frameworks });
  return frameworks;
}

/**
 * Adds or updates a single framework by id.
 */
export async function upsertFramework(framework) {
  const list = await getFrameworks();
  const index = list.findIndex(f => f.id === framework.id);
  if (index >= 0) {
    list[index] = { ...list[index], ...framework };
  } else {
    list.push(framework);
  }
  await saveFrameworks(list);
  return list;
}

/**
 * Deletes a framework by id.
 */
export async function deleteFramework(id) {
  const list = await getFrameworks();
  const filtered = list.filter(f => f.id !== id);
  await saveFrameworks(filtered);
  return filtered;
}

/**
 * Resets all frameworks to the default list.
 */
export async function resetFrameworksToDefault() {
  await chrome.storage.local.set({ promptcraft_frameworks: DEFAULT_FRAMEWORKS });
  return DEFAULT_FRAMEWORKS;
}

/* Persona cues for the offline heuristic. Precedence: code, then writing, then analysis. */
const CODE_CUES = /\b(?:code\w*|debug\w*|bugs?|functions?|python|javascript|css|golang|goroutines?|rust)\b|\b(?:in|using|with) go\b/i;
const WRITING_CUES = /\b(?:write|writer|rewrite|article|blog|email|copy)s?\b/i;
const ANALYSIS_CUES = /\b(?:analy[sz]e|analysis|data|metrics?|reports?|sql)\b/i;

/**
 * Extract the offline heuristic's read of a draft: persona, audience,
 * deliverable, and which cue group fired.
 *
 * Whole-word cues only: substring matching let "go" fire on "good" and
 * "category", and "write" on "overwrite".
 *
 * @returns {{ persona: string, audience: string, deliverable: string,
 *             signal: 'code' | 'writing' | 'analysis' | null }}
 */
export function analyzePromptSignals(trimmed) {
  let persona = 'Senior Domain Expert and Technical Consultant';
  let audience = 'Professional stakeholders';
  let deliverable = 'Comprehensive, actionable response';
  let signal = null;

  if (CODE_CUES.test(trimmed)) {
    signal = 'code';
    persona = 'Principal Software Engineer and System Architect';
    audience = 'Senior software developers';
    deliverable = 'Production-ready, well-commented code with complexity analysis and unit test cases';
  } else if (WRITING_CUES.test(trimmed)) {
    signal = 'writing';
    persona = 'Lead Communications Strategist and Executive Copywriter';
    audience = 'Target end-users and decision-makers';
    deliverable = 'Compelling, high-converting copy formatted with clear headings';
  } else if (ANALYSIS_CUES.test(trimmed)) {
    signal = 'analysis';
    persona = 'Principal Data Scientist and Quantitative Analyst';
    audience = 'Technical and leadership teams';
    deliverable = 'Rigorous analytical breakdown with key metrics, insights, and recommendations';
  }

  return { persona, audience, deliverable, signal };
}

/**
 * Offline Heuristic Generator (works with 0 API calls and zero network latency).
 * Analyzes the user's input and builds an enterprise-grade prompt structure.
 *
 * @param {string} rawPrompt
 * @param {string} [frameworkId]
 * @param {Array|null} [customFrameworks]
 * @param {object} [options]
 * @param {string} [options.targetNote] - Target-model formatting note (from
 *   target-profiles.js) appended as a final section when present.
 */
export function generateOfflineOptimization(rawPrompt, frameworkId = 'smart-expand', customFrameworks = null, options = {}) {
  const trimmed = rawPrompt.trim();
  if (!trimmed) return '';

  const frameworks = customFrameworks || DEFAULT_FRAMEWORKS;
  const fw = frameworks.find(f => f.id === frameworkId) || frameworks[0] || DEFAULT_FRAMEWORKS[0];

  const { persona, audience, deliverable } = analyzePromptSignals(trimmed);

  // If the framework has a template defined, interpolate variables. One pass
  // over the template with a function replacer: a string replacement would
  // interpret `$&` / `$'` in the user's text, and chained passes would
  // re-substitute any `{{persona}}` the user typed.
  const targetSection = options.targetNote
    ? `\n\n**Target model note:**\n${options.targetNote}`
    : '';

  if (fw.template && typeof fw.template === 'string') {
    const values = { prompt: trimmed, persona, audience, deliverable };
    return fw.template.replace(/{{(prompt|persona|audience|deliverable)}}/g, (_, key) => values[key]) + targetSection;
  }

  // Fallback if no template specified for a custom framework
  return `### ${fw.name.toUpperCase()}
Act as a ${persona}.

**Primary Directive:**
${trimmed}

**Context & Guidelines:**
- Target audience: ${audience}.
- Expected deliverable: ${deliverable}.
- Follow the methodology of ${fw.name}: ${fw.tagline || ''}

**Output Structure:**
- Deliver a clear, professional, and well-structured response.` + targetSection;
}
