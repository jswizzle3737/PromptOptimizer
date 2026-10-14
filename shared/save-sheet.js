/**
 * PromptOptimizer Design System — Save sheet
 * The small "Save as / Labels" form shown under an optimized prompt, shared by
 * the popup and the in-page modal so saving looks and behaves the same in both.
 *
 * The sheet owns no storage. It collects a title and labels and hands them to
 * `onSave`, which each surface wires to the library in its own way (the popup
 * writes directly; the in-page modal asks the service worker).
 */

import { icon } from './icons.js';
import { normalizeLabels, LIMITS } from './library.js';

const SUGGESTION_LIMIT = 12;

/**
 * @param {object} cfg
 * @param {({ title: string, labels: string[] }) => Promise<void>} cfg.onSave
 *        Throw to keep the sheet open; the message is shown to the user.
 * @param {() => Promise<Array<{label:string,count:number}>>} [cfg.getSuggestions]
 *        Labels already in use, offered as one-click chips.
 * @param {string} [cfg.idPrefix]  Distinguishes ids when two sheets share a page.
 * @returns {{ element: HTMLFormElement, open:(init?:{title?:string,labels?:string[]})=>Promise<void>, close:()=>void, isOpen:()=>boolean }}
 */
export function createSaveSheet({ onSave, getSuggestions, idPrefix = 'pc-save' } = {}) {
  const form = document.createElement('form');
  form.className = 'pc-savesheet';
  form.hidden = true;
  form.setAttribute('aria-label', 'Save prompt');
  form.noValidate = true;

  form.innerHTML = `
    <div class="pc-field">
      <label class="pc-label" for="${idPrefix}-title">Save as</label>
      <input type="text" class="pc-input" id="${idPrefix}-title" maxlength="${LIMITS.title}"
             placeholder="Name this prompt" autocomplete="off">
    </div>
    <div class="pc-field">
      <label class="pc-label" for="${idPrefix}-labels">Labels <span class="pc-field__hint-inline">optional, comma-separated</span></label>
      <input type="text" class="pc-input" id="${idPrefix}-labels"
             placeholder="e.g. email, sales" autocomplete="off">
      <div class="pc-savesheet__chips" role="group" aria-label="Labels already in use" hidden></div>
    </div>
    <p class="pc-savesheet__error" role="alert" hidden></p>
    <div class="pc-savesheet__actions">
      <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm" data-act="cancel">Cancel</button>
      <button type="submit" class="pc-btn pc-btn--primary pc-btn--sm" data-act="save">
        ${icon('bookmark', { size: 13 })}<span>Save prompt</span>
      </button>
    </div>
  `;

  const titleInput = form.querySelector(`#${idPrefix}-title`);
  const labelsInput = form.querySelector(`#${idPrefix}-labels`);
  const chipsEl = form.querySelector('.pc-savesheet__chips');
  const errorEl = form.querySelector('.pc-savesheet__error');
  const saveBtn = form.querySelector('[data-act="save"]');
  const cancelBtn = form.querySelector('[data-act="cancel"]');

  const showError = message => {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  };

  const currentLabels = () => normalizeLabels(labelsInput.value);

  /** Reflect which suggestion chips are already in the labels field. */
  function syncChips() {
    const active = new Set(currentLabels().map(l => l.toLowerCase()));
    chipsEl.querySelectorAll('.pc-labelchip').forEach(chip => {
      chip.setAttribute('aria-pressed', String(active.has(chip.dataset.label.toLowerCase())));
    });
  }

  function renderChips(suggestions) {
    chipsEl.innerHTML = '';
    const shown = (suggestions || []).slice(0, SUGGESTION_LIMIT);
    chipsEl.hidden = shown.length === 0;
    for (const { label } of shown) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'pc-labelchip';
      chip.dataset.label = label;
      chip.textContent = label;
      chip.setAttribute('aria-pressed', 'false');
      chipsEl.appendChild(chip);
    }
    syncChips();
  }

  chipsEl.addEventListener('click', e => {
    const chip = e.target.closest('.pc-labelchip');
    if (!chip) return;
    const label = chip.dataset.label;
    const current = currentLabels();
    const has = current.some(l => l.toLowerCase() === label.toLowerCase());
    labelsInput.value = (has
      ? current.filter(l => l.toLowerCase() !== label.toLowerCase())
      : [...current, label]).join(', ');
    syncChips();
  });
  labelsInput.addEventListener('input', syncChips);

  function close() {
    form.hidden = true;
    showError('');
  }

  async function open({ title = '', labels = [] } = {}) {
    showError('');
    titleInput.value = title;
    labelsInput.value = labels.join(', ');
    form.hidden = false;
    // Bring the whole sheet into view (the buttons sit at its bottom), rather than
    // letting focus scroll only the first field into view.
    titleInput.focus({ preventScroll: true });
    titleInput.select();
    form.scrollIntoView({ block: 'nearest' });

    if (typeof getSuggestions === 'function') {
      try {
        renderChips(await getSuggestions());
      } catch {
        renderChips([]);
      }
    }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    showError('');
    saveBtn.disabled = true;
    try {
      await onSave({ title: titleInput.value.trim(), labels: currentLabels() });
      close();
    } catch (err) {
      showError(err?.message || 'Could not save this prompt.');
    } finally {
      saveBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', close);

  // Escape closes the sheet only; an enclosing dialog must not also close.
  form.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  return { element: form, open, close, isOpen: () => !form.hidden };
}
