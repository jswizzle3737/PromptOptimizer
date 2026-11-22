/**
 * PromptOptimizer Design System — Assist controls
 * The pieces around a result that the popup and the in-page panel share:
 *
 *   createResultActions  "Output was cut off · Continue" and the one-tap
 *                        refinements (Shorter, More formal, Add examples)
 *   createClarifySheet   "Ask me first": up to three questions, answered
 *                        before the rewrite runs
 *   createSendNotice     approval for fallback destinations and suspected credentials
 *                        to a cloud provider
 *   createLibraryPicker  saved prompts, searchable, with a fill-in form for
 *                        {{variables}}
 *
 * Like the save sheet, none of these own storage or messaging: each surface
 * wires the callbacks to its own route.
 */

import { icon } from './icons.js';
import { escapeHtml } from './select.js';
import { extractVariables, fillTemplate } from './templates.js';

/** Keys must match REFINEMENTS in optimizer-engine.js (unit-tested). */
export const REFINE_ACTIONS = [
  { kind: 'shorter', label: 'Shorter', icon: 'minimize' },
  { kind: 'formal', label: 'More formal', icon: 'edit' },
  { kind: 'examples', label: 'Add examples', icon: 'layers' }
];

/* ------------------------------------------------------------------ */
/* Undo history & inline editable output                               */
/* ------------------------------------------------------------------ */

/**
 * Bounded stack of result snapshots so users can revert AI refinements,
 * variant switches, or manual inline edits before copying/inserting.
 */
export function createUndoStack(limit = 25) {
  let stack = [];
  return {
    push(snapshot) {
      if (!snapshot || typeof snapshot.text !== 'string' || !snapshot.text.trim()) return false;
      const prev = stack[stack.length - 1];
      if (prev && prev.text === snapshot.text && prev.framework === snapshot.framework) return false;
      stack.push({ ...snapshot });
      if (stack.length > limit) stack = stack.slice(stack.length - limit);
      return true;
    },
    pop() { return stack.pop() || null; },
    peek() { return stack[stack.length - 1] || null; },
    canUndo: () => stack.length > 0,
    size: () => stack.length,
    clear() { stack = []; },
    toJSON: () => stack.slice(),
    load(entries) {
      stack = Array.isArray(entries)
        ? entries.filter(e => e && typeof e.text === 'string' && e.text.trim()).slice(-limit)
        : [];
    }
  };
}

/**
 * Make a <pre> output surface editable (`contenteditable="plaintext-only"`)
 * while idle so users can tweak text directly without breaking streaming or
 * auto-expanding layout height.
 */
export function bindEditableResult({ element, onSnapshot, onEdit } = {}) {
  let active = false;
  let burstOpen = false;
  let burstTimer = null;

  const readPlain = () => String(element.textContent ?? '').replace(/\r\n?/g, '\n');

  const closeBurst = () => {
    clearTimeout(burstTimer);
    burstTimer = null;
    burstOpen = false;
  };

  element.addEventListener('beforeinput', () => {
    if (!active) return;
    if (!burstOpen) {
      onSnapshot?.();
      burstOpen = true;
    }
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => { burstOpen = false; }, 900);
  });

  element.addEventListener('input', () => {
    if (!active) return;
    onEdit?.(readPlain());
  });

  element.addEventListener('blur', closeBurst);

  return {
    setEditable(editable) {
      active = Boolean(editable);
      if (active) {
        element.setAttribute('contenteditable', 'plaintext-only');
        element.setAttribute('spellcheck', 'true');
        element.dataset.editable = 'true';
      } else {
        closeBurst();
        element.removeAttribute('contenteditable');
        delete element.dataset.editable;
      }
    },
    resetBurst: closeBurst
  };
}

/* ------------------------------------------------------------------ */
/* Result actions                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {object} cfg
 * @param {(kind: string) => void} cfg.onRefine
 * @param {(instruction: string) => void} [cfg.onCustomRefine]
 * @param {() => void} cfg.onContinue
 * @param {() => void} [cfg.onUndo]
 * @returns {{ element: HTMLElement, update: (s: { visible?: boolean, truncated?: boolean, canRefine?: boolean, canUndo?: boolean, busy?: boolean }) => void, clearCustomInput: () => void }}
 */
export function createResultActions({ onRefine, onCustomRefine, onContinue, onUndo } = {}) {
  const root = document.createElement('div');
  root.className = 'pc-assist';
  root.hidden = true;
  root.innerHTML = `
    <div class="pc-callout pc-callout--warning pc-assist__cutoff" role="status" hidden>
      <span class="pc-callout__icon">${icon('alert', { size: 15 })}</span>
      <div class="pc-callout__body">
        <span class="pc-callout__title">Output was cut off</span>
        <span class="pc-callout__text">The model hit its length limit before finishing.</span>
        <button type="button" class="pc-btn pc-btn--secondary pc-btn--sm" data-act="continue">
          ${icon('arrowRight', { size: 13 })}<span>Continue</span>
        </button>
      </div>
    </div>
    <div class="pc-assist__bar">
      <div class="pc-assist__refine" role="group" aria-label="Refine the result">
        <span class="pc-assist__label">Refine</span>
        ${REFINE_ACTIONS.map(a => `
          <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm pc-assist__chip" data-kind="${a.kind}">
            ${icon(a.icon, { size: 12 })}<span>${escapeHtml(a.label)}</span>
          </button>`).join('')}
      </div>
      <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm pc-assist__undo" data-act="undo" title="Undo last change" hidden>
        ${icon('reset', { size: 12 })}<span>Undo</span>
      </button>
    </div>
    <form class="pc-assist__custom" novalidate hidden>
      <input type="text" class="pc-input pc-assist__custom-input" placeholder="Custom tweak (e.g., focus on security, output YAML)" aria-label="Custom refinement instruction" autocomplete="off">
      <button type="submit" class="pc-btn pc-btn--secondary pc-btn--sm pc-assist__custom-btn" data-act="custom-refine">Apply</button>
    </form>
  `;

  const cutoff = root.querySelector('.pc-assist__cutoff');
  const bar = root.querySelector('.pc-assist__bar');
  const refine = root.querySelector('.pc-assist__refine');
  const undoBtn = root.querySelector('[data-act="undo"]');
  const customForm = root.querySelector('.pc-assist__custom');
  const customInput = root.querySelector('.pc-assist__custom-input');
  const buttons = [...root.querySelectorAll('button')];

  root.querySelector('[data-act="continue"]').addEventListener('click', () => onContinue?.());
  undoBtn.addEventListener('click', () => onUndo?.());
  refine.addEventListener('click', e => {
    const btn = e.target.closest('[data-kind]');
    if (btn) onRefine?.(btn.dataset.kind);
  });
  customForm.addEventListener('submit', e => {
    e.preventDefault();
    const instruction = customInput.value.trim();
    if (!instruction) {
      customInput.focus();
      return;
    }
    onCustomRefine?.(instruction);
  });

  return {
    element: root,
    clearCustomInput() { customInput.value = ''; },
    update({ visible = false, truncated = false, canRefine = true, canUndo = false, busy = false } = {}) {
      cutoff.hidden = !truncated;
      refine.hidden = !canRefine;
      customForm.hidden = !canRefine;
      undoBtn.hidden = !canUndo;
      bar.hidden = !canRefine && !canUndo;
      root.hidden = !visible || (!truncated && !canRefine && !canUndo);
      buttons.forEach(b => { b.disabled = busy; });
      customInput.disabled = busy;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Clarify sheet                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {object} cfg
 * @param {(answers: Array<{question: string, answer: string}>) => void} cfg.onSubmit
 * @param {() => void} [cfg.onCancel]
 * @param {string} [cfg.idPrefix]
 */
export function createClarifySheet({ onSubmit, onCancel, idPrefix = 'pc-clarify' } = {}) {
  const form = document.createElement('form');
  form.className = 'pc-savesheet pc-clarify';
  form.hidden = true;
  form.noValidate = true;
  form.setAttribute('aria-label', 'Questions before optimizing');
  form.innerHTML = `
    <div class="pc-clarify__head">
      <span class="pc-label">A few questions first</span>
      <span class="pc-clarify__note"></span>
    </div>
    <div class="pc-clarify__fields"></div>
    <div class="pc-savesheet__actions">
      <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm" data-act="cancel">Cancel</button>
      <button type="submit" class="pc-btn pc-btn--primary pc-btn--sm">
        ${icon('wand', { size: 13 })}<span>Optimize with answers</span>
      </button>
    </div>
  `;
  const fields = form.querySelector('.pc-clarify__fields');
  const note = form.querySelector('.pc-clarify__note');
  let questions = [];

  const close = () => { form.hidden = true; fields.innerHTML = ''; };

  form.addEventListener('submit', e => {
    e.preventDefault();
    const answers = questions.map((question, i) => ({
      question,
      answer: form.querySelector(`#${idPrefix}-q${i}`)?.value || ''
    }));
    close();
    onSubmit?.(answers);
  });
  form.querySelector('[data-act="cancel"]').addEventListener('click', () => { close(); onCancel?.(); });
  form.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); onCancel?.(); }
  });

  return {
    element: form,
    isOpen: () => !form.hidden,
    close,
    open(list, noteText = '') {
      questions = list.slice(0, 3);
      note.textContent = noteText;
      note.hidden = !noteText;
      fields.innerHTML = questions.map((q, i) => `
        <div class="pc-field">
          <label class="pc-label pc-clarify__q" for="${idPrefix}-q${i}">${escapeHtml(q)}</label>
          <input type="text" class="pc-input" id="${idPrefix}-q${i}" autocomplete="off" placeholder="Optional">
        </div>`).join('');
      form.hidden = false;
      form.querySelector('input')?.focus();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Secret notice                                                       */
/* ------------------------------------------------------------------ */

/**
 * Resolve the current request only after a user action. A web page cannot
 * approve a request by synthesizing a click in the in-page panel.
 */
export function createSendNotice({ labelForEngine } = {}) {
  const root = document.createElement('div');
  root.className = 'pc-callout pc-callout--danger pc-secret-notice';
  root.setAttribute('role', 'alert');
  root.hidden = true;
  root.innerHTML = `
    <span class="pc-callout__icon">${icon('lock', { size: 15 })}</span>
    <div class="pc-callout__body">
      <span class="pc-callout__title"></span>
      <span class="pc-callout__text"></span>
      <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm pc-btn--danger-text" data-act="send">Send anyway</button>
      <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm" data-act="cancel">Cancel</button>
    </div>
  `;
  const text = root.querySelector('.pc-callout__text');
  const title = root.querySelector('.pc-callout__title');
  const send = root.querySelector('[data-act="send"]');
  const cancel = root.querySelector('[data-act="cancel"]');
  let resolveApproval = null;
  let returnFocus = null;

  function settle(approved) {
    root.hidden = true;
    const resolve = resolveApproval;
    resolveApproval = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    resolve?.(approved);
  }

  send.addEventListener('click', event => {
    if (event.isTrusted) settle(true);
  });
  cancel.addEventListener('click', () => settle(false));
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    settle(false);
  });
  return {
    element: root,
    ask({ engine, model, origin, secrets = [], fallback, email }) {
      settle(false);
      const provider = labelForEngine?.(engine) || engine;
      const destination = [provider, model, origin].filter(Boolean).join(' · ');
      title.textContent = secrets.length ? 'Possible credential in this request'
        : email ? 'Draft with this provider?' : 'Send to the fallback provider?';
      let message = fallback ? `Your selected engine failed. The next provider is ${destination}.` : `Destination is ${destination}.`;
      if (email) message += ' This sends the incoming email, your notes and style instructions, and the samples you selected.';
      if (secrets.length) message += ` The request may contain ${secrets.join(', ')}.`;
      text.textContent = message;
      send.textContent = secrets.length ? 'Send anyway' : email ? 'Approve and draft' : 'Send to fallback';
      returnFocus = root.getRootNode().activeElement;
      root.hidden = false;
      cancel.focus({ preventScroll: true });
      root.scrollIntoView({ block: 'nearest' });
      return new Promise(resolve => { resolveApproval = resolve; });
    },
    hide() { settle(false); }
  };
}

/* ------------------------------------------------------------------ */
/* Library picker                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {object} cfg
 * @param {() => Promise<Array<{id, title, text, labels?: string[]}>>} cfg.getEntries
 * @param {(text: string, entry: object) => void} cfg.onUse  Receives the text
 *        with every {{variable}} filled in.
 * @param {() => void} [cfg.onClose]  Called whenever the picker closes, by any route.
 * @param {string} [cfg.idPrefix]
 */
export function createLibraryPicker({ getEntries, onUse, onClose, idPrefix = 'pc-lib' } = {}) {
  const root = document.createElement('div');
  root.className = 'pc-savesheet pc-libpick';
  root.hidden = true;
  root.innerHTML = `
    <div class="pc-libpick__head">
      <label class="pc-label" for="${idPrefix}-search">Saved prompts</label>
      <button type="button" class="pc-icon-btn" data-act="close" title="Close" aria-label="Close saved prompts">
        ${icon('close', { size: 14 })}
      </button>
    </div>
    <input type="search" class="pc-input" id="${idPrefix}-search" placeholder="Search by name, text or label" autocomplete="off">
    <div class="pc-libpick__list" role="list"></div>
    <form class="pc-libpick__fill" hidden novalidate>
      <span class="pc-label pc-libpick__fill-title"></span>
      <div class="pc-libpick__fields"></div>
      <div class="pc-savesheet__actions">
        <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm" data-act="back">Back</button>
        <button type="submit" class="pc-btn pc-btn--primary pc-btn--sm">
          ${icon('check', { size: 13 })}<span>Use prompt</span>
        </button>
      </div>
    </form>
  `;
  const search = root.querySelector('input[type="search"]');
  const list = root.querySelector('.pc-libpick__list');
  const fill = root.querySelector('.pc-libpick__fill');
  const fillTitle = root.querySelector('.pc-libpick__fill-title');
  const fillFields = root.querySelector('.pc-libpick__fields');
  let entries = [];
  let picked = null;
  let vars = [];

  const close = () => {
    const wasOpen = !root.hidden;
    root.hidden = true;
    if (wasOpen) onClose?.();
  };

  function render() {
    const q = search.value.trim().toLowerCase();
    const shown = entries.filter(e => !q ||
      [e.title, e.text, ...(e.labels || [])].some(v => String(v || '').toLowerCase().includes(q)));
    list.innerHTML = shown.length ? '' :
      `<p class="pc-libpick__empty">${entries.length ? 'No saved prompts match.' : 'No saved prompts yet. Press Save under a result to keep one.'}</p>`;
    for (const entry of shown.slice(0, 50)) {
      const n = extractVariables(entry.text).length;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pc-libpick__item';
      btn.setAttribute('role', 'listitem');
      btn.innerHTML = `
        <span class="pc-libpick__title">${escapeHtml(entry.title || 'Untitled')}</span>
        ${n ? `<span class="pc-badge pc-badge--mono">${n} blank${n === 1 ? '' : 's'}</span>` : ''}
        <span class="pc-libpick__preview">${escapeHtml(String(entry.text || '').slice(0, 140))}</span>`;
      btn.addEventListener('click', () => choose(entry));
      list.appendChild(btn);
    }
  }

  function choose(entry) {
    vars = extractVariables(entry.text);
    if (!vars.length) {
      close();
      onUse?.(entry.text, entry);
      return;
    }
    picked = entry;
    fillTitle.textContent = `Fill in "${entry.title || 'Untitled'}"`;
    fillFields.innerHTML = vars.map((v, i) => `
      <div class="pc-field">
        <label class="pc-label" for="${idPrefix}-v${i}">${escapeHtml(v)}</label>
        <input type="text" class="pc-input" id="${idPrefix}-v${i}" autocomplete="off">
      </div>`).join('');
    list.hidden = true;
    search.hidden = true;
    fill.hidden = false;
    fillFields.querySelector('input')?.focus();
  }

  function showList() {
    picked = null;
    fill.hidden = true;
    list.hidden = false;
    search.hidden = false;
  }

  fill.addEventListener('submit', e => {
    e.preventDefault();
    const values = Object.fromEntries(vars.map((v, i) => [v, root.querySelector(`#${idPrefix}-v${i}`)?.value || '']));
    const entry = picked;
    close();
    showList();
    onUse?.(fillTemplate(entry.text, values), entry);
  });
  root.querySelector('[data-act="back"]').addEventListener('click', showList);
  root.querySelector('[data-act="close"]').addEventListener('click', close);
  search.addEventListener('input', render);
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  return {
    element: root,
    isOpen: () => !root.hidden,
    close,
    async open() {
      showList();
      search.value = '';
      root.hidden = false;
      list.innerHTML = '<p class="pc-libpick__empty">Loading…</p>';
      try {
        entries = await getEntries();
      } catch (err) {
        entries = [];
        list.innerHTML = `<p class="pc-libpick__empty">Could not load saved prompts: ${escapeHtml(err.message)}</p>`;
        return;
      }
      render();
      search.focus();
    }
  };
}
