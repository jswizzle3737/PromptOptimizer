/**
 * Shared UI controls for the PromptOptimizer surfaces (popup and Options).
 *
 * Kept separate from the engine so adding a control on every surface costs one
 * shared function call instead of several copies of the same markup.
 */

import { MODES, DEFAULT_MODE, isMode } from './modes.js';
import { TARGET_PROFILES } from './target-profiles.js';
import { INTENSITIES, DEFAULT_INTENSITY, isIntensity } from './intensity.js';
import { createSelect, escapeHtml } from './select.js';

/** Result tabs, in display order. */
export const RESULT_TABS = [
  { id: 'optimized', label: 'Optimized' },
  { id: 'compare', label: 'Compare' }
];

export function resolveMode(value) {
  return isMode(value) ? value : DEFAULT_MODE;
}

export function resolveIntensity(value) {
  return isIntensity(value) ? value : DEFAULT_INTENSITY;
}

/**
 * Build the mode, target and intensity controls used by popup and Options.
 * The engine reads the saved values (shared/optimizer-engine.js buildSystemPrompt).
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.container  Element the controls are appended into.
 * @param {object} [cfg.value]         { modeId?, targetId?, intensity? }
 * @param {function} cfg.onChange      Called with { modeId, targetId, intensity }.
 */
export function createAdvancedControls({ container, value = {}, onChange }) {
  const current = {
    modeId: resolveMode(value.modeId),
    targetId: TARGET_PROFILES.some(p => p.id === value.targetId) ? value.targetId : '',
    intensity: resolveIntensity(value.intensity)
  };
  const wrapper = document.createElement('div');
  wrapper.className = 'pc-advanced';

  // Same custom select as the engine and variant pickers; descriptions show in the menu.
  const fields = [
    ['modeId', 'Mode', 'Optimization mode',
      MODES.map(m => ({ value: m.id, label: m.name, desc: m.description }))],
    ['targetId', 'Target', 'Target model',
      [{ value: '', label: 'Auto', desc: 'Tuned for the AI site you are on' },
        ...TARGET_PROFILES.map(p => ({ value: p.id, label: p.name }))]],
    ['intensity', 'Intensity', 'Optimization intensity',
      INTENSITIES.map(i => ({ value: i.value, label: i.label, desc: i.description }))]
  ];
  const selects = {};
  for (const [key, shortLabel, label, options] of fields) {
    const row = document.createElement('div');
    row.className = 'pc-advanced__row';
    const name = document.createElement('span');
    name.className = 'pc-label';
    name.textContent = shortLabel;
    const select = createSelect({
      options,
      value: current[key],
      label,
      onChange: v => { current[key] = v; onChange?.({ ...current }); }
    });
    row.append(name, select.element);
    wrapper.appendChild(row);
    selects[key] = select;
  }
  container.appendChild(wrapper);

  // `selects` lets Options treat each picker like its other form controls.
  return { selects, destroy() { wrapper.remove(); } };
}

/**
 * Optimized / Compare tabs under the rewrite result in the popup.
 *
 * The Optimized tab is the caller's own output box (it used to be a second
 * copy of the result under it); `onTabChange(id)` lets the caller hide that box
 * while Compare shows the diff in its place.
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.container
 * @param {string} cfg.resultText
 * @param {string} [cfg.originalText]
 * @param {(id: string) => void} [cfg.onTabChange]
 */
export function createResultTabs({ container, resultText, originalText, onTabChange }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pc-result-tabs';
  wrapper.innerHTML = `
    <div class="pc-result-tabs__bar" role="tablist" aria-label="Result views">
      ${RESULT_TABS.map(t => `<button type="button" role="tab" data-tab="${t.id}" class="pc-result-tabs__item">${t.label}</button>`).join('')}
    </div>
    <div class="pc-result-tab" data-tab="compare" role="tabpanel" hidden></div>
  `;
  container.appendChild(wrapper);

  const items = wrapper.querySelectorAll('.pc-result-tabs__item');
  const comparePane = wrapper.querySelector('.pc-result-tab[data-tab="compare"]');
  let current = 'optimized';

  function showTab(id) {
    current = id;
    comparePane.hidden = id !== 'compare';
    items.forEach(b => {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('is-active', on);
    });
    onTabChange?.(id);
  }

  function render(result, original) {
    wrapper.hidden = !result;
    if (!result && current !== 'optimized') showTab('optimized');
    const hunks = diffLines(original || '', result || '');
    const changed = hunks.filter(h => h.type !== 'equal').length;
    comparePane.innerHTML = `
      <p class="pc-diff__summary">${changed ? `${changed} changed block${changed === 1 ? '' : 's'} · removed lines are struck through` : 'No changes from your draft'}</p>
      <div class="pc-diff">
        ${hunks.map(h => `<div class="pc-diff__line pc-diff__line--${DIFF_CLASS[h.type]}">${escapeHtml(h.text)}</div>`).join('')}
      </div>
    `;
  }

  for (const item of items) item.addEventListener('click', () => showTab(item.dataset.tab));
  render(resultText, originalText);
  showTab('optimized');

  return {
    destroy() { wrapper.remove(); },
    showTab,
    refresh(result, original) { render(result, original); }
  };
}

const DIFF_CLASS = { equal: 'same', add: 'add', del: 'del' };

/** Line-level LCS diff; consecutive lines of the same type are merged. */
export function diffLines(a = '', b = '') {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  const N = A.length;
  const M = B.length;
  const dp = Array.from({ length: N + 1 }, () => Array(M + 1).fill(0));
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const hunks = [];
  let i = N, j = M;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
      hunks.push({ type: 'equal', text: A[--i] });
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      hunks.push({ type: 'add', text: B[--j] });
    } else {
      hunks.push({ type: 'del', text: A[--i] });
    }
  }
  hunks.reverse();
  const merged = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && last.type === h.type) last.text += '\n' + h.text;
    else merged.push({ ...h });
  }
  return merged;
}
