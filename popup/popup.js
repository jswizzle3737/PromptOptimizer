import {
  getSettings, saveSettings, getHistory, clearHistory, getSites, takePendingPrompt, PROVIDER_DEFAULTS
} from '../shared/storage.js';
import { getFrameworks } from '../shared/frameworks.js';
import { createSelect, escapeHtml } from '../shared/select.js';
import { createThemeMenu, applyTheme, watchTheme, getTheme } from '../shared/theme-picker.js';
import { icon, hydrateIcons } from '../shared/icons.js';
import { engineOptions, ENGINE_LABELS, DEFAULT_ENGINE } from '../shared/engines.js';
import { saveToLibrary, getLibrary, collectLabels, deriveTitle } from '../shared/library.js';
import { createSaveSheet } from '../shared/save-sheet.js';
import { startRun } from '../shared/run-client.js';
import { secretWarning } from '../shared/secrets.js';
import { withAnswers } from '../shared/clarify.js';
import {
  createResultActions, createClarifySheet, createSecretNotice, createLibraryPicker
} from '../shared/assist.js';
import { checkBuiltInPromptApiStatus, verifyProvider } from '../shared/optimizer-engine.js';

document.addEventListener('DOMContentLoaded', async () => {
  hydrateIcons(document);

  const el = {
    onboardingView: document.getElementById('onboarding-view'),
    onboardingStart: document.getElementById('onboarding-start'),
    onboardingSkip: document.getElementById('onboarding-skip'),
    frameworkBar: document.getElementById('framework-bar'),
    frameworkTabs: document.getElementById('framework-tabs'),
    themeSlot: document.getElementById('theme-toggle-slot'),
    engineSlot: document.getElementById('engine-slot'),
    rawPrompt: document.getElementById('raw-prompt'),
    charCounter: document.getElementById('char-counter'),
    optimizeBtn: document.getElementById('optimize-btn'),
    resultText: document.getElementById('result-text'),
    resultPlaceholder: document.getElementById('result-placeholder'),
    techChips: document.getElementById('tech-chips'),
    qualityChip: document.getElementById('quality-chip'),
    variantChips: document.getElementById('variant-chips'),
    variantSlot: document.getElementById('variant-slot'),
    statusMessage: document.getElementById('status-message'),
    statusDot: document.getElementById('status-dot'),
    engineBadge: document.getElementById('engine-status-badge'),
    degradedNotice: document.getElementById('degraded-notice'),
    degradedTitle: document.getElementById('degraded-title'),
    degradedReason: document.getElementById('degraded-reason'),
    degradedSettingsBtn: document.getElementById('degraded-settings-btn'),
    copyBtn: document.getElementById('copy-btn'),
    saveBtn: document.getElementById('save-btn'),
    saveSlot: document.getElementById('save-slot'),
    optionsBtn: document.getElementById('options-btn'),
    historyToggle: document.getElementById('history-toggle-btn'),
    historyView: document.getElementById('history-view'),
    mainView: document.getElementById('main-view'),
    historyList: document.getElementById('history-list'),
    clearHistoryBtn: document.getElementById('clear-history-btn'),
    siteRow: document.getElementById('site-row'),
    siteText: document.getElementById('site-text'),
    siteToggle: document.getElementById('site-toggle-btn'),
    toast: document.getElementById('toast'),
    libraryToggle: document.getElementById('library-toggle-btn'),
    librarySlot: document.getElementById('library-slot'),
    contextToggle: document.getElementById('context-toggle'),
    askFirstBtn: document.getElementById('ask-first-btn'),
    secretSlot: document.getElementById('secret-slot'),
    clarifySlot: document.getElementById('clarify-slot'),
    resultActionsSlot: document.getElementById('result-actions-slot'),
    setupCard: document.getElementById('setup-card'),
    setupText: document.getElementById('setup-text'),
    setupDownloadBtn: document.getElementById('setup-download-btn'),
    setupProviderSlot: document.getElementById('setup-provider-slot'),
    setupKey: document.getElementById('setup-key'),
    setupKeyLink: document.getElementById('setup-key-link'),
    setupDismissBtn: document.getElementById('setup-dismiss-btn'),
    setupSaveBtn: document.getElementById('setup-save-btn')
  };

  const state = {
    framework: 'smart-expand',
    engine: DEFAULT_ENGINE,
    theme: 'dark',
    latest: '',
    /* What the result on screen came from, so a saved prompt records it. */
    original: '',
    resultEngine: '',
    resultFramework: '',
    busy: false,
    historyOpen: false,
    variantCount: 1,
    variants: [],
    /* The full result on screen (null for a library prompt or history). */
    lastData: null,
    /* Draft the user chose to send despite the credential warning. */
    secretAllowedFor: ''
  };

  /* ---------------------------------------------------------------- Toast */
  let toastTimer;
  function toast(msg, tone = 'neutral') {
    const toneIcon = { success: 'check', danger: 'alert', neutral: 'info' }[tone] || 'info';
    el.toast.innerHTML = `${icon(toneIcon, { size: 13 })}<span>${escapeHtml(msg)}</span>`;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2600);
  }

  /**
   * The status dot only carries meaning when it has a tone. "Ready" is neutral:
   * a green dot before anything has happened claims a success that never occurred.
   */
  function setStatus(text, tone = 'neutral') {
    el.statusMessage.textContent = text;
    el.statusDot.className = 'pc-status-dot' +
      (tone === 'success' ? ' pc-status-dot--success'
        : tone === 'warning' ? ' pc-status-dot--warning'
          : tone === 'danger' ? ' pc-status-dot--danger' : '');
  }

  /* -------------------------------------------------------------- Theming */
  const settings = await getSettings();
  state.theme = settings.theme || 'dark';
  applyTheme(document.documentElement, state.theme);

  const themeMenu = createThemeMenu({
    value: state.theme,
    onChange: async id => {
      state.theme = id;
      applyTheme(document.documentElement, id);
      await saveSettings({ theme: id });
      toast(`${getTheme(id).name} design`, 'success');
    }
  });
  el.themeSlot.appendChild(themeMenu.element);

  watchTheme(id => {
    if (id !== state.theme) {
      state.theme = id;
      applyTheme(document.documentElement, id);
      themeMenu.setValue(id, { silent: true });
    }
  });

  /* ------------------------------------------------------------- Controls */
  const engineSelect = createSelect({
    options: engineOptions(),
    value: settings.preferredEngine || DEFAULT_ENGINE,
    placement: 'up',
    label: 'Optimization engine',
    /* Persisted: the engine picked here is the one the in-page panel uses on
       every other site — a per-run choice silently reverted to Nano there. */
    onChange: async v => {
      state.engine = v;
      await saveSettings({ preferredEngine: v });
    }
  });
  state.engine = engineSelect.getValue();
  el.engineSlot.appendChild(engineSelect.element);

  /* Variant count: how many alternative rewrites each optimization produces.
     Persisted so the in-page panel picks the same number up. */
  state.variantCount = Math.max(1, Math.min(3, parseInt(settings.variantCount, 10) || 1));
  const variantSelect = createSelect({
    options: [
      { value: '1', label: 'Single' },
      { value: '2', label: 'Two' },
      { value: '3', label: 'Three' }
    ],
    value: String(state.variantCount),
    placement: 'up',
    label: 'Rewrite variants',
    onChange: async v => {
      state.variantCount = parseInt(v, 10) || 1;
      await saveSettings({ variantCount: state.variantCount });
    }
  });
  el.variantSlot.appendChild(variantSelect.element);

  /* ----------------------------------------------------------- Frameworks */
  const frameworks = await getFrameworks();
  const valid = id => frameworks.some(f => f.id === id);
  state.framework = valid(settings.preferredFramework)
    ? settings.preferredFramework
    : (frameworks[0]?.id || 'smart-expand');

  function renderFrameworkTabs() {
    el.frameworkTabs.innerHTML = '';
    frameworks.forEach(fw => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'pc-segmented__item';
      tab.setAttribute('role', 'tab');
      tab.dataset.framework = fw.id;
      tab.setAttribute('aria-selected', String(fw.id === state.framework));
      tab.title = fw.tagline || fw.name;
      tab.innerHTML =
        `<span class="pc-segmented__icon">${icon(fw.icon, { size: 13 })}</span>` +
        `<span>${escapeHtml(fw.name)}</span>`;
      el.frameworkTabs.appendChild(tab);
    });
  }
  renderFrameworkTabs();

  el.frameworkTabs.addEventListener('click', e => {
    const tab = e.target.closest('.pc-segmented__item');
    if (!tab) return;
    el.frameworkTabs.querySelectorAll('.pc-segmented__item')
      .forEach(t => t.setAttribute('aria-selected', 'false'));
    tab.setAttribute('aria-selected', 'true');
    state.framework = tab.dataset.framework;
  });

  /* ------------------------------------------------------- Input feedback */
  el.rawPrompt.addEventListener('input', () => {
    el.charCounter.textContent = String(el.rawPrompt.value.length);
  });

  /* --------------------------------------------------------------- Shell */
  el.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  el.degradedSettingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  /* ------------------------------------------------------------- History */
  async function renderHistory() {
    const items = await getHistory();
    el.historyList.innerHTML = '';

    if (items.length === 0) {
      el.historyList.innerHTML = `
        <div class="pc-empty">
          <span class="pc-empty__icon">${icon('clock', { size: 16 })}</span>
          <span class="pc-empty__title">Nothing yet</span>
          <span class="pc-empty__desc">Optimized prompts will be listed here.</span>
        </div>`;
      return;
    }

    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'pc-history__item';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const time = new Date(item.timestamp).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const engineLabel = ENGINE_LABELS[item.engine] || item.engine || '';
      row.innerHTML = `
        <div class="pc-history__meta">
          <span>${escapeHtml(item.framework || '')}</span>
          <span class="pc-history__rule"></span>
          <span>${escapeHtml(item.degraded ? `${engineLabel} · offline` : engineLabel)}</span>
          <span class="pc-history__rule"></span>
          <span>${escapeHtml(time)}</span>
        </div>
        <div class="pc-history__preview">${escapeHtml(item.original || '')}</div>
      `;
      const restore = () => {
        el.rawPrompt.value = item.original || '';
        el.charCounter.textContent = String(el.rawPrompt.value.length);
        state.latest = item.optimized || '';
        state.original = item.original || '';
        state.resultEngine = item.engine || '';
        state.resultFramework = item.framework || '';
        state.lastData = null;
        showResult(state.latest);
        resultActions.update(actionState());
        if (item.engine) {
          engineSelect.setValue(item.engine, { silent: true });
          state.engine = item.engine;
        }
        setHistoryOpen(false);
        el.rawPrompt.focus();
      };
      row.addEventListener('click', restore);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); restore(); }
      });
      el.historyList.appendChild(row);
    });
  }

  function showResult(text) {
    if (!text) return;
    el.resultPlaceholder.hidden = true;
    el.resultText.hidden = false;
    el.resultText.textContent = text;
  }

  function setHistoryOpen(open) {
    state.historyOpen = open;
    el.historyView.hidden = !open;
    el.mainView.hidden = open;
    el.historyToggle.setAttribute('aria-pressed', String(open));
    el.historyToggle.classList.toggle('is-active', open);
    if (open) {
      renderHistory();
      if (libraryPicker.isOpen()) setLibraryOpen(false);
    }
  }

  el.historyToggle.addEventListener('click', () => setHistoryOpen(!state.historyOpen));

  /* Clear-all is destructive and irreversible, so it asks once. */
  let clearArmed = false;
  let clearTimer;
  el.clearHistoryBtn.addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      el.clearHistoryBtn.textContent = 'Confirm?';
      clearTimer = setTimeout(() => {
        clearArmed = false;
        el.clearHistoryBtn.textContent = 'Clear all';
      }, 3000);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    el.clearHistoryBtn.textContent = 'Clear all';
    await clearHistory();
    await renderHistory();
    toast('History cleared', 'success');
  });

  /* ------------------------------------------------------------ Optimize */
  /* While a request runs, the Optimize button becomes Cancel. */
  let currentRun = null;

  function setBusy(busy) {
    state.busy = busy;
    el.optimizeBtn.innerHTML = busy
      ? `${icon('close', { size: 14 })}<span>Cancel</span>`
      : `${icon('wand', { size: 14 })}<span>Optimize</span>`;
    el.optimizeBtn.title = busy ? 'Stop this request' : 'Optimize prompt (Ctrl+Enter)';
    el.askFirstBtn.disabled = busy;
    resultActions.update({ ...actionState(), busy });
  }

  /** Tell the truth about a degraded result rather than painting it as success. */
  function showDegraded(data) {
    const requested = ENGINE_LABELS[data.requestedEngine] || data.requestedEngine || 'That engine';
    el.degradedTitle.textContent = `${requested} unavailable — offline template used`;
    el.degradedReason.textContent = data.degradedReason
      ? `${data.degradedReason} The output below is a local template, not a model response.`
      : 'The output below is a local template, not a model response.';
    el.degradedNotice.hidden = false;
  }

  /* Technique chips: what the optimizer added and why, shown under the result.
     textContent, not innerHTML — chip labels arrive over messaging. */
  function renderTechChips(chips) {
    el.techChips.innerHTML = '';
    if (!Array.isArray(chips) || chips.length === 0) {
      el.techChips.hidden = true;
      return;
    }
    for (const chip of chips) {
      const span = document.createElement('span');
      span.className = 'pc-badge pc-badge--mono';
      span.textContent = String(chip?.label ?? '');
      if (chip?.detail) span.title = String(chip.detail);
      el.techChips.appendChild(span);
    }
    el.techChips.hidden = false;
  }

  /* Quality chip: rule-based rubric before → after, optionally refined by the
     on-device judge. Advisory only — never blocks a result. */
  function renderQualityChip(score, rawText) {
    const after = score?.after;
    if (typeof after !== 'number') {
      el.qualityChip.hidden = true;
      return;
    }
    const before = typeof score?.before === 'number' ? score.before : null;
    el.qualityChip.textContent = before != null ? `Quality ${before}→${after}` : `Quality ${after}/100`;
    const bits = [];
    if (score.method === 'nano+rules') bits.push(`on-device judge ${score.judgeScore} + rules ${score.ruleScore}`);
    else if (score.method === 'nano') bits.push('judged on-device');
    else bits.push('rule-based check');
    if (Array.isArray(score.missed) && score.missed.length) {
      bits.push(`not shown: ${score.missed.map(t => t.label).join(', ')}`);
    }
    if (rawText) bits.push(`draft: ${rawText.slice(0, 120)}`);
    el.qualityChip.title = bits.join(' · ');
    el.qualityChip.className = 'pc-badge pc-badge--mono ' +
      (after >= 80 ? 'pc-badge--success' : after >= 55 ? 'pc-badge--accent' : 'pc-badge--warning');
    el.qualityChip.hidden = false;
  }

  /* Variant chips: clickable alternatives ranked by score. Clicking one swaps
     the result on screen (and everything that follows from it: copy, save,
     insert), keeping the chosen text and its own score in sync. */
  function renderVariantChips() {
    el.variantChips.innerHTML = '';
    if (state.variants.length < 2) {
      el.variantChips.hidden = true;
      return;
    }
    const activeText = state.latest;
    state.variants.forEach((variant, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const active = variant.text === activeText;
      btn.className = 'pc-badge pc-badge--mono pc-variant-chip' + (active ? ' pc-badge--accent' : '');
      btn.textContent = `${String.fromCharCode(65 + index)} · ${variant.label || `Variant ${index + 1}`} ${variant.score ?? '·'}`;
      btn.title = `Use this variant (quality ${variant.score ?? 'n/a'}/100)`;
      btn.setAttribute('aria-pressed', String(active));
      btn.addEventListener('click', () => {
        state.latest = variant.text;
        el.resultText.textContent = variant.text;
        renderVariantChips();
        renderQualityChip({ before: scoreBefore(), after: variant.score, method: 'rules' }, state.original);
      });
      el.variantChips.appendChild(btn);
    });
    el.variantChips.hidden = false;
  }

  /* The "before" half of the quality chip; kept across variant switches. */
  function scoreBefore() {
    const m = el.qualityChip.textContent.match(/Quality (\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /* Refine / Continue under the result. Only for model output: a template of
     a rewrite is not a refinement. */
  function actionState() {
    const data = state.lastData;
    return {
      visible: Boolean(state.latest && data),
      truncated: Boolean(data?.truncated),
      canRefine: Boolean(data && data.engine !== 'offline')
    };
  }

  const resultActions = createResultActions({
    onRefine: kind => runRequest({ action: 'refine', kind, previous: state.latest, text: state.original }),
    onContinue: () => runRequest(
      { action: 'refine', kind: 'continue', previous: state.latest, text: state.original },
      { base: state.latest }
    )
  });
  el.resultActionsSlot.appendChild(resultActions.element);

  /** The tab the popup was opened over: its host tunes the rewrite. */
  async function activeTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch {
      return null;
    }
  }

  function applyResult(data, original) {
    state.lastData = data;
    state.latest = data.optimized;
    state.original = original;
    state.resultEngine = data.engine || '';
    state.resultFramework = data.framework || state.framework;
    state.variants = Array.isArray(data.variants) ? data.variants : [];
    showResult(state.latest);

    el.engineBadge.textContent = ENGINE_LABELS[data.engine] || data.engine || '';
    el.engineBadge.className = 'pc-badge pc-badge--mono ' +
      (data.degraded ? 'pc-badge--warning' : 'pc-badge--accent');
    el.engineBadge.hidden = !data.engine;
    renderQualityChip(data.score, state.original);
    renderVariantChips();
    renderTechChips(data.techniques);

    if (data.degraded) {
      showDegraded(data);
      setStatus('Offline fallback', 'warning');
      toast('Fell back to the offline template', 'danger');
      refreshSetupCard();
    } else if (data.fallbackReason) {
      /* Another configured provider answered for the chosen one. */
      const requested = ENGINE_LABELS[data.requestedEngine] || data.requestedEngine;
      const used = ENGINE_LABELS[data.engine] || data.engine;
      el.engineBadge.title = `${requested} failed: ${data.fallbackReason}`;
      setStatus(`Used ${used}`, 'warning');
      toast(`${requested} unavailable, used ${used}`, 'neutral');
    } else if (data.truncated) {
      el.engineBadge.title = '';
      setStatus('Cut off', 'warning');
      toast('The output was cut off. Press Continue to finish it.', 'neutral');
    } else {
      el.engineBadge.title = '';
      setStatus('Done', 'success');
      toast(data.refinement ? 'Prompt refined' : 'Prompt optimized', 'success');
    }
    resultActions.update(actionState());
  }

  /**
   * One streamed request. `base` is the text a Continue appends to; it stays on
   * screen while the remainder streams in.
   */
  async function runRequest(payload, { base = '' } = {}) {
    if (state.busy) return;
    const isOptimize = !payload.action || payload.action === 'optimize';
    const previous = { latest: state.latest, data: state.lastData };
    setBusy(true);
    saveSheet.close();
    clarifySheet.close();
    secretNotice.hide();
    setStatus(isOptimize ? 'Optimizing…' : 'Refining…', 'neutral');
    el.degradedNotice.hidden = true;
    el.techChips.hidden = true;
    el.qualityChip.hidden = true;
    el.variantChips.hidden = true;
    resultActions.update({ visible: false });
    if (isOptimize) state.variants = [];

    let streamed = base;
    const paint = text => {
      el.resultPlaceholder.hidden = true;
      el.resultText.hidden = false;
      el.resultText.textContent = text;
      el.resultText.classList.add('is-streaming');
    };
    if (base) paint(base);

    currentRun = startRun({ ...payload, engine: state.engine, frameworkId: state.framework }, {
      onStart: engine => {
        streamed = base;
        setStatus(`${ENGINE_LABELS[engine] || engine}…`, 'neutral');
        if (base) paint(base);
      },
      onToken: delta => {
        streamed += delta;
        paint(streamed);
      }
    });

    try {
      const data = await currentRun.promise;
      if (!data) {
        // Cancelled: put back whatever was on screen before.
        state.latest = previous.latest;
        state.lastData = previous.data;
        if (state.latest) showResult(state.latest);
        else { el.resultText.hidden = true; el.resultPlaceholder.hidden = false; }
        setStatus('Cancelled', 'neutral');
        return;
      }
      applyResult(data, isOptimize ? payload.text : state.original);
    } catch (err) {
      if (isOptimize) {
        el.resultText.hidden = true;
        el.resultPlaceholder.hidden = false;
        el.resultPlaceholder.innerHTML = `
          <span class="pc-empty__icon">${icon('alert', { size: 16 })}</span>
          <span class="pc-empty__title">Optimization failed</span>
          <span class="pc-empty__desc">${escapeHtml(err.message)}</span>`;
      } else if (state.latest) {
        // A failed refinement leaves the result it was refining untouched.
        showResult(previous.latest);
      }
      setStatus('Failed', 'danger');
      toast(err.message, 'danger');
    } finally {
      el.resultText.classList.remove('is-streaming');
      currentRun = null;
      setBusy(false);
      resultActions.update(actionState());
    }
  }

  /** Title and address of the active tab, when the user opted in. */
  async function pageContext() {
    if (!el.contextToggle.checked) return '';
    const tab = await activeTab();
    if (!tab?.url || !/^https?:/.test(tab.url)) return '';
    return [`Page title: ${tab.title || ''}`, `URL: ${tab.url}`].join('\n');
  }

  /** A credential in the draft stops the run until the user says so. */
  async function blockedBySecret(text) {
    const warning = secretWarning(text, state.engine, await getSettings());
    if (!warning || state.secretAllowedFor === text) return false;
    secretNotice.show(warning);
    return true;
  }

  async function optimize() {
    const text = el.rawPrompt.value.trim();
    if (!text) {
      toast('Enter a prompt first', 'danger');
      el.rawPrompt.focus();
      return;
    }
    if (await blockedBySecret(text)) return;
    const tab = await activeTab();
    let host = null;
    try { host = tab?.url ? new URL(tab.url).hostname : null; } catch { /* untargeted */ }
    await runRequest({
      action: 'optimize',
      text,
      host,
      variantCount: state.variantCount,
      context: await pageContext()
    });
  }

  el.optimizeBtn.addEventListener('click', () => {
    if (state.busy) { currentRun?.cancel(); return; }
    optimize();
  });

  const secretNotice = createSecretNotice({
    onSendAnyway: () => {
      state.secretAllowedFor = el.rawPrompt.value.trim();
      optimize();
    }
  });
  el.secretSlot.appendChild(secretNotice.element);

  /* Ask me first: questions, then the rewrite with the answers folded in. */
  const clarifySheet = createClarifySheet({
    idPrefix: 'popup-clarify',
    onSubmit: answers => {
      const next = withAnswers(el.rawPrompt.value, answers);
      el.rawPrompt.value = next;
      el.charCounter.textContent = String(next.length);
      optimize();
    },
    onCancel: () => el.rawPrompt.focus()
  });
  el.clarifySlot.appendChild(clarifySheet.element);

  el.askFirstBtn.addEventListener('click', async () => {
    const text = el.rawPrompt.value.trim();
    if (!text) {
      toast('Enter a prompt first', 'danger');
      el.rawPrompt.focus();
      return;
    }
    if (state.busy || await blockedBySecret(text)) return;
    el.askFirstBtn.disabled = true;
    setStatus('Thinking of questions…', 'neutral');
    try {
      const res = await startRun({ action: 'clarify', text, engine: state.engine }).promise;
      if (!res) return;
      clarifySheet.open(res.questions, res.degraded
        ? 'General questions: no AI engine was reachable to tailor them.'
        : '');
      setStatus('Ready', 'neutral');
    } catch (err) {
      setStatus('Failed', 'danger');
      toast(err.message, 'danger');
    } finally {
      el.askFirstBtn.disabled = state.busy;
    }
  });

  /* Page context: opt-in, remembered. */
  el.contextToggle.checked = Boolean(settings.includePageContext);
  el.contextToggle.addEventListener('change', () =>
    saveSettings({ includePageContext: el.contextToggle.checked }));

  el.rawPrompt.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      el.optimizeBtn.click();
    }
  });
  el.rawPrompt.addEventListener('input', () => secretNotice.hide());

  /* ------------------------------------------------------------- Library */
  /* Saved prompts, with a fill-in form for {{variables}}. The chosen text
     becomes the result on screen, ready to copy. */
  const libraryPicker = createLibraryPicker({
    idPrefix: 'popup-lib',
    getEntries: getLibrary,
    onClose: () => {
      el.libraryToggle.setAttribute('aria-pressed', 'false');
      el.libraryToggle.classList.remove('is-active');
    },
    onUse: (text, entry) => {
      setLibraryOpen(false);
      state.lastData = null;
      state.latest = text;
      state.original = entry.original || '';
      state.resultEngine = entry.engine || '';
      state.resultFramework = entry.framework || '';
      state.variants = [];
      el.degradedNotice.hidden = true;
      el.engineBadge.hidden = true;
      el.qualityChip.hidden = true;
      el.variantChips.hidden = true;
      el.techChips.hidden = true;
      showResult(text);
      resultActions.update(actionState());
      setStatus(`Loaded "${entry.title}"`, 'neutral');
      toast('Saved prompt ready to copy', 'success');
    }
  });
  el.librarySlot.appendChild(libraryPicker.element);

  function setLibraryOpen(open) {
    if (!open) { libraryPicker.close(); return; }
    setHistoryOpen(false);
    libraryPicker.open();
    el.libraryToggle.setAttribute('aria-pressed', 'true');
    el.libraryToggle.classList.add('is-active');
  }
  el.libraryToggle.addEventListener('click', () => setLibraryOpen(!libraryPicker.isOpen()));

  /* ------------------------------------------------------------ Engine setup */
  /* When nothing but the offline template can run (Nano missing, no key), say
     so up front and let the user fix it here instead of hunting in Options. */
  const KEY_LINKS = {
    openrouter: 'https://openrouter.ai/keys',
    gemini: 'https://aistudio.google.com/apikey',
    openai: 'https://platform.openai.com/api-keys',
    anthropic: 'https://console.anthropic.com/settings/keys'
  };
  const setupProvider = createSelect({
    options: engineOptions().filter(o => KEY_LINKS[o.value]).map(o => ({ ...o, desc: o.value === 'openrouter' ? 'Free models' : '' })),
    value: 'openrouter',
    label: 'Provider',
    onChange: v => { el.setupKeyLink.href = KEY_LINKS[v]; }
  });
  el.setupKeyLink.href = KEY_LINKS.openrouter;
  el.setupProviderSlot.appendChild(setupProvider.element);

  let nanoStatus = null;
  async function refreshSetupCard() {
    const s = await getSettings();
    const hasKey = Object.keys(KEY_LINKS).some(id => String(s[`${id}ApiKey`] || '').trim());
    nanoStatus ??= await checkBuiltInPromptApiStatus();
    const engineReady = s.preferredEngine === 'offline' || hasKey ||
      (s.preferredEngine === 'nano' && nanoStatus.available);
    const show = !engineReady && !s.setupDismissed;
    el.setupCard.hidden = !show;
    if (!show) return;
    el.setupDownloadBtn.hidden = nanoStatus.status !== 'downloadable';
    el.setupText.textContent = nanoStatus.status === 'downloadable'
      ? 'Chrome can run a private on-device model, but it is not downloaded yet. Download it once, or add a key from any provider. Without either, rewrites use a basic template.'
      : 'Chrome\'s on-device model is not available in this browser, so rewrites use a basic template. Add a key from any provider to get real AI rewrites. OpenRouter has free models.';
  }

  el.setupSaveBtn.addEventListener('click', async () => {
    const provider = setupProvider.getValue();
    const key = el.setupKey.value.trim();
    if (!key) {
      toast('Paste a key first', 'danger');
      el.setupKey.focus();
      return;
    }
    el.setupSaveBtn.disabled = true;
    el.setupSaveBtn.textContent = 'Testing…';
    try {
      await verifyProvider(provider, { apiKey: key, model: PROVIDER_DEFAULTS[provider]?.model });
      await saveSettings({ [`${provider}ApiKey`]: key, preferredEngine: provider });
      state.engine = provider;
      engineSelect.setValue(provider, { silent: true });
      el.setupKey.value = '';
      el.setupCard.hidden = true;
      toast(`${ENGINE_LABELS[provider]} connected`, 'success');
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      el.setupSaveBtn.disabled = false;
      el.setupSaveBtn.textContent = 'Test and save';
    }
  });

  el.setupDismissBtn.addEventListener('click', async () => {
    el.setupCard.hidden = true;
    await saveSettings({ setupDismissed: true });
  });

  /* Downloading Nano needs a user gesture: this click. */
  el.setupDownloadBtn.addEventListener('click', async () => {
    const LM = globalThis.LanguageModel;
    if (!LM) return;
    el.setupDownloadBtn.disabled = true;
    try {
      const session = await LM.create({
        monitor(m) {
          m.addEventListener('downloadprogress', e => {
            el.setupDownloadBtn.lastElementChild.textContent = `Downloading… ${Math.round((e.loaded || 0) * 100)}%`;
          });
        }
      });
      session.destroy?.();
      nanoStatus = null;
      await saveSettings({ preferredEngine: 'nano' });
      state.engine = 'nano';
      engineSelect.setValue('nano', { silent: true });
      toast('On-device model ready', 'success');
      await refreshSetupCard();
    } catch (err) {
      toast(`Download failed: ${err.message}`, 'danger');
      el.setupDownloadBtn.disabled = false;
    }
  });

  /* ---------------------------------------------------------------- Copy */
  el.copyBtn.addEventListener('click', async () => {
    if (!state.latest) {
      toast('Nothing to copy yet', 'danger');
      return;
    }
    await navigator.clipboard.writeText(state.latest);
    el.copyBtn.innerHTML = `${icon('check', { size: 13 })}<span>Copied</span>`;
    toast('Copied to clipboard', 'success');
    setTimeout(() => {
      el.copyBtn.innerHTML = `${icon('copy', { size: 13 })}<span>Copy</span>`;
    }, 1800);
  });

  /* ---------------------------------------------------------------- Save */
  /* Saves the result on screen to the library, with a name and labels. The
     library itself is managed in Options. */
  const saveSheet = createSaveSheet({
    idPrefix: 'popup-save',
    getSuggestions: async () => collectLabels(await getLibrary()),
    onSave: async ({ title, labels }) => {
      await saveToLibrary({
        title,
        labels,
        text: state.latest,
        original: state.original,
        framework: state.resultFramework,
        engine: state.resultEngine
      });
      toast('Saved to library', 'success');
    }
  });
  el.saveSlot.appendChild(saveSheet.element);

  el.saveBtn.addEventListener('click', () => {
    if (!state.latest) {
      toast('Nothing to save yet', 'danger');
      return;
    }
    if (saveSheet.isOpen()) {
      saveSheet.close();
      return;
    }
    saveSheet.open({ title: deriveTitle(state.latest) });
  });

  /* -------------------------------------------------------- Per-site opt-in */
  /* The floating button is automatic on the AI sites listed in the manifest.
     Anywhere else it is opt-in, one origin at a time, and the browser asks for
     that origin's permission — nothing is requested up front. */
  const builtInMatches = chrome.runtime.getManifest().content_scripts.flatMap(c => c.matches);

  function toOrigin(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
    } catch {
      return null;
    }
  }

  async function initSiteRow() {
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      return;
    }
    // `tab.url` is only present when the extension may see this page.
    const origin = toOrigin(tab?.url);
    if (!origin) return;

    const host = new URL(origin).host;
    el.siteRow.hidden = false;

    if (builtInMatches.includes(`${origin}/*`)) {
      el.siteText.textContent = `Optimize button is on for ${host}`;
      return;
    }

    let enabled = (await getSites()).includes(origin);
    const render = () => {
      el.siteText.textContent = enabled
        ? `Optimize button is on for ${host}`
        : `Optimize button is off for ${host}`;
      el.siteToggle.textContent = enabled ? 'Turn off' : 'Turn on';
      el.siteToggle.hidden = false;
    };
    render();

    el.siteToggle.addEventListener('click', async () => {
      el.siteToggle.disabled = true;
      try {
        if (!enabled) {
          // permissions.request needs the user gesture of this click, so it must
          // be the first thing awaited here.
          const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
          if (!granted) {
            toast('Permission was not granted', 'danger');
            return;
          }
          const res = await chrome.runtime.sendMessage({ type: 'ENABLE_SITE', origin, tabId: tab.id });
          if (!res?.success) throw new Error(res?.error || 'Could not enable this site.');
          enabled = true;
          toast(`Enabled on ${host}`, 'success');
        } else {
          const res = await chrome.runtime.sendMessage({ type: 'DISABLE_SITE', origin });
          if (!res?.success) throw new Error(res?.error || 'Could not disable this site.');
          enabled = false;
          toast(`Turned off on ${host}`, 'success');
        }
        render();
      } catch (err) {
        toast(err.message, 'danger');
      } finally {
        el.siteToggle.disabled = false;
      }
    });
  }
  initSiteRow();

  /* ------------------------------------------------------------ First run */
  function setOnboardingVisible(visible) {
    el.onboardingView.hidden = !visible;
    el.frameworkBar.hidden = visible;
    el.mainView.hidden = visible;
  }

  async function finishOnboarding() {
    setOnboardingVisible(false);
    await saveSettings({ onboardingComplete: true });
    await refreshSetupCard();
    el.rawPrompt.focus();
  }

  el.onboardingStart.addEventListener('click', finishOnboarding);
  el.onboardingSkip.addEventListener('click', finishOnboarding);

  setStatus('Ready', 'neutral');

  /* Text handed over by the service worker when the page it came from cannot
     host the in-page modal (chrome://, the Web Store, the PDF viewer). */
  const pending = await takePendingPrompt();
  if (pending) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'PromptOptimizer' });
  }

  if (pending?.text) {
    setOnboardingVisible(false);
    el.rawPrompt.value = pending.text;
    el.charCounter.textContent = String(pending.text.length);
    el.rawPrompt.focus();
    if (pending.autoRun) el.optimizeBtn.click();
  } else if (!settings.onboardingComplete) {
    setOnboardingVisible(true);
  } else {
    el.rawPrompt.focus();
  }
  if (settings.onboardingComplete || pending?.text) refreshSetupCard();
});
