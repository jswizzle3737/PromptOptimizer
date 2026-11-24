import {
  getSettings, OPENROUTER_FREE_MODELS, PROVIDER_DEFAULTS,
  PROVIDER_MODEL_PRESETS, clampMaxHistory, normalizeBaseUrl,
  getHistory
} from '../shared/storage.js';
import { createAdvancedControls } from '../shared/pco-controls.js';
import { checkBuiltInPromptApiStatus, verifyProvider } from '../shared/optimizer-engine.js';
import { NANO_SESSION_OPTIONS } from '../shared/nano.js';
import { engineOptions, DEFAULT_ENGINE, ENGINE_LABELS } from '../shared/engines.js';
import { writeUserData } from '../shared/run-client.js';
import {
  LIBRARY_KEY, LIMITS, getLibrary,
  collectLabels, filterLibrary, normalizeLabels, deriveTitle
} from '../shared/library.js';
import { getFrameworks } from '../shared/frameworks.js';
import { createSelect, escapeHtml } from '../shared/select.js';
import { createThemePicker, applyTheme, watchTheme, getTheme } from '../shared/theme-picker.js';
import { icon, hydrateIcons, ICON_NAMES, isEmoji, iconValue } from '../shared/icons.js';

const CUSTOM_MODEL = '__custom__';
const DEFAULT_FALLBACK_MODEL = '__default__';
const HISTORY_KEY = 'promptcraft_history';
const FRAMEWORKS_KEY = 'promptcraft_frameworks';

document.addEventListener('DOMContentLoaded', async () => {
  hydrateIcons(document);

  const $ = id => document.getElementById(id);

  const el = {
    themeSlot: $('theme-picker-slot'),
    advancedSlot: $('advanced-slot'),
    engineSlot: $('preferred-engine-slot'),
    frameworkSlot: $('preferred-framework-slot'),
    fallback1EngineSlot: $('fallback-1-engine-slot'),
    fallback1PresetSlot: $('fallback-1-preset-slot'),
    fallback1Model: $('fallback-1-model'),
    fallback1Hint: $('fallback-1-hint'),
    fallback2EngineSlot: $('fallback-2-engine-slot'),
    fallback2PresetSlot: $('fallback-2-preset-slot'),
    fallback2Model: $('fallback-2-model'),
    fallback2Hint: $('fallback-2-hint'),
    allowCloudFallback: $('allow-cloud-fallback'),
    saveStatus: $('save-status'),
    saveStatusDot: $('save-status-dot'),
    saveStatusText: $('save-status-text'),
    orAllToggle: $('openrouter-all-models-toggle'),
    orModelFilter: $('openrouter-model-filter'),
    orModelSelectLabel: $('openrouter-model-select-label'),
    orModelSlot: $('openrouter-model-slot'),
    orModelInput: $('openrouter-model'),
    orApiKey: $('openrouter-api-key'),
    fetchModelsBtn: $('fetch-openrouter-free-models-btn'),
    omniEnabled: $('omniroute-enabled'),
    omniBaseUrl: $('omniroute-base-url'),
    omniApiKey: $('omniroute-api-key'),
    omniModelSlot: $('omniroute-model-slot'),
    omniModelInput: $('omniroute-model'),
    fetchOmniModelsBtn: $('fetch-omniroute-models-btn'),
    geminiApiKey: $('gemini-api-key'),
    geminiModelSlot: $('gemini-model-slot'),
    geminiModel: $('gemini-model'),
    openaiApiKey: $('openai-api-key'),
    openaiModelSlot: $('openai-model-slot'),
    openaiModel: $('openai-model'),
    anthropicApiKey: $('anthropic-api-key'),
    anthropicModelSlot: $('anthropic-model-slot'),
    anthropicModel: $('anthropic-model'),
    saveBtn: $('save-btn'),
    toast: $('toast'),
    nanoText: $('nano-status-text'),
    nanoActions: $('nano-actions'),
    nanoCheckBtn: $('nano-check-btn'),
    nanoDownloadBtn: $('nano-download-btn'),
    nanoHelp: $('nano-instructions'),
    nanoBanner: $('nano-status-banner'),
    frameworksList: $('frameworks-list'),
    exportFrameworksBtn: $('export-frameworks-btn'),
    importFrameworksBtn: $('import-frameworks-btn'),
    importFrameworksFile: $('import-frameworks-file'),
    addFrameworkBtn: $('add-framework-btn'),
    resetFrameworksBtn: $('reset-frameworks-btn'),
    modalBackdrop: $('framework-modal-backdrop'),
    modalTitle: $('modal-title'),
    modalCloseBtn: $('modal-close-btn'),
    cancelFrameworkBtn: $('cancel-framework-btn'),
    saveFrameworkBtn: $('save-framework-btn'),
    fwId: $('fw-id'),
    fwName: $('fw-name'),
    fwTagline: $('fw-tagline'),
    fwSystemPrompt: $('fw-system-prompt'),
    fwTemplate: $('fw-template'),
    maxHistory: $('max-history'),
    widgetToggle: $('enable-floating-widget'),
    quickRepairToggle: $('quick-repair-enabled'),
    customPrompt: $('custom-system-prompt'),
    exportLibraryBtn: $('export-library-btn'),
    importLibraryBtn: $('import-library-btn'),
    importLibraryFile: $('import-library-file'),
    historySummary: $('history-summary'),
    clearHistoryBtn: $('clear-history-options-btn'),
    historySearch: $('history-search'),
    historyList: $('history-options-list')
  };

  const settings = await getSettings();
  let theme = settings.theme || 'dark';
  let frameworkOptions = [];
  let savedSnapshot = null;
  let isDirty = false;

  /* ---------------------------------------------------------------- Toast */
  let toastTimer;
  function toast(msg, tone = 'success') {
    const toneIcon = { success: 'check', danger: 'alert', neutral: 'info' }[tone] || 'info';
    el.toast.innerHTML = `${icon(toneIcon, { size: 13 })}<span>${escapeHtml(msg)}</span>`;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2600);
  }

  /* Destructive actions ask for a second click within 3s, like the popup's
     Clear all, instead of the browser's confirm() box. True on the second click. */
  const armedButtons = new WeakMap();
  function confirmByClick(btn, message) {
    const disarm = () => { clearTimeout(armedButtons.get(btn)); armedButtons.delete(btn); btn.classList.remove('is-armed'); };
    if (armedButtons.has(btn)) {
      disarm();
      return true;
    }
    btn.classList.add('is-armed');
    armedButtons.set(btn, setTimeout(disarm, 3000));
    toast(message, 'danger');
    return false;
  }

  /* ----------------------------------------------------------- Dirty state */
  function getSettingControls() {
    return {
      preferredEngine: engineSelect,
      preferredFramework: frameworkSelect,
      modeId: advanced.selects.modeId,
      preferredTarget: advanced.selects.targetId,
      optimizationIntensity: advanced.selects.intensity,
      fallback1Engine: fallback1.engineSelect,
      fallback1Model: el.fallback1Model,
      fallback2Engine: fallback2.engineSelect,
      fallback2Model: el.fallback2Model,
      allowCloudFallback: el.allowCloudFallback,
      geminiApiKey: el.geminiApiKey,
      geminiModel: el.geminiModel,
      openaiApiKey: el.openaiApiKey,
      openaiModel: el.openaiModel,
      anthropicApiKey: el.anthropicApiKey,
      anthropicModel: el.anthropicModel,
      openrouterApiKey: el.orApiKey,
      openrouterModel: el.orModelInput,
      omnirouteEnabled: el.omniEnabled,
      omnirouteBaseUrl: el.omniBaseUrl,
      omnirouteApiKey: el.omniApiKey,
      omnirouteModel: el.omniModelInput,
      customSystemPrompt: el.customPrompt,
      enableFloatingWidget: el.widgetToggle,
      quickRepairEnabled: el.quickRepairToggle,
      maxHistoryItems: el.maxHistory
    };
  }

  function getFormState() {
    return Object.fromEntries(Object.entries(getSettingControls()).map(([key, control]) => {
      if (control.getValue) return [key, control.getValue()];
      if (control.type === 'checkbox') return [key, control.checked];
      return [key, control.value.trim()];
    }));
  }

  function syncDirtyState() {
    if (savedSnapshot === null) return;
    isDirty = Object.entries(getFormState()).some(([key, value]) => savedSnapshot[key] !== value);
    el.saveStatus.classList.toggle('is-dirty', isDirty);
    el.saveStatusDot.classList.toggle('pc-status-dot--warning', isDirty);
    el.saveStatusDot.classList.toggle('pc-status-dot--success', !isDirty);
    el.saveStatusText.textContent = isDirty ? 'Unsaved changes' : 'Saved locally';
  }

  function markClean() {
    savedSnapshot = getFormState();
    syncDirtyState();
  }

  window.addEventListener('beforeunload', e => {
    if (!isDirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* -------------------------------------------------------------- Theming */
  applyTheme(document.documentElement, theme);

  const themePicker = createThemePicker({
    value: theme,
    placement: 'down',
    onChange: async id => {
      theme = id;
      applyTheme(document.documentElement, id);
      await writeUserData('saveSettings', { theme: id });
      toast(`${getTheme(id).name} applied`);
    }
  });
  el.themeSlot.appendChild(themePicker.element);

  watchTheme(id => {
    if (id === theme) return;
    theme = id;
    applyTheme(document.documentElement, id);
    themePicker.setValue(id, { silent: true });
  });

  /* ------------------------------------------------------------- Controls */
  const MODEL_FIELDS = {
    gemini: el.geminiModel,
    openai: el.openaiModel,
    anthropic: el.anthropicModel,
    openrouter: el.orModelInput,
    omniroute: el.omniModelInput
  };
  const API_KEY_FIELDS = {
    gemini: el.geminiApiKey,
    openai: el.openaiApiKey,
    anthropic: el.anthropicApiKey,
    openrouter: el.orApiKey
  };

  let orRawCatalog = null;
  let orShowAll = false;
  let orFilterQuery = '';
  let orModels = OPENROUTER_FREE_MODELS.slice();
  let omniModels = PROVIDER_MODEL_PRESETS.omniroute.slice();

  function refreshFallbackSlots() {
    fallback1.syncControls();
    fallback2.syncControls();
    updateFallbackHints();
  }

  const engineSelect = createSelect({
    options: engineOptions({ full: true }),
    value: settings.preferredEngine || DEFAULT_ENGINE,
    label: 'Default engine',
    onChange: () => {
      updateFallbackHints();
      syncDirtyState();
    }
  });
  el.engineSlot.appendChild(engineSelect.element);

  const frameworkSelect = createSelect({
    options: [],
    value: settings.preferredFramework || 'smart-expand',
    label: 'Default framework',
    onChange: () => syncDirtyState()
  });
  el.frameworkSlot.appendChild(frameworkSelect.element);

  // Saved with the rest of the Engine card by "Save changes", not on every pick.
  const advanced = createAdvancedControls({
    container: el.advancedSlot,
    value: {
      modeId: settings.modeId,
      targetId: settings.preferredTarget,
      intensity: settings.optimizationIntensity
    },
    onChange: () => syncDirtyState()
  });

  /* An optimizer type's icon: one picker in which an emoji and a stroke icon
     are the same kind of choice. Picking either one sets the icon. */
  const EMOJI_SUGGESTIONS = ['🚀', '🧠', '✍️', '💡', '🎯', '🔍', '📊', '🧪', '⚖️', '💬', '🛠️', '📚', '🎨', '⚡',
    '📝', '🤖', '📈', '🧭', '🔧', '💼', '🗂️', '🧩', '🌐', '❤️'];
  const fwIconTrigger = $('fw-icon-trigger');
  const fwIconGlyph = $('fw-icon-glyph');
  const fwIconPanel = $('fw-icon-panel');
  const fwEmoji = $('fw-emoji');
  let iconChoice = 'wand';

  function choiceButton(value, label) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'pc-icon-choice';
    choice.dataset.value = value;
    choice.title = label;
    choice.setAttribute('aria-label', label);
    choice.setAttribute('aria-pressed', 'false');
    choice.innerHTML = icon(value, { size: 18 });
    choice.addEventListener('click', () => { setIcon(value); showIconPanel(false); });
    return choice;
  }
  $('fw-emoji-grid').append(...EMOJI_SUGGESTIONS.map(value => choiceButton(value, value)));
  $('fw-icon-grid').append(...ICON_NAMES.map(name => choiceButton(name, name)));
  const iconChoices = [...fwIconPanel.querySelectorAll('.pc-icon-choice')];

  function setIcon(value) {
    iconChoice = iconValue(value);
    fwIconGlyph.innerHTML = icon(iconChoice, { size: 18 });
    fwIconTrigger.setAttribute('aria-label', `Icon: ${iconChoice}`);
    for (const choice of iconChoices) choice.setAttribute('aria-pressed', String(choice.dataset.value === iconChoice));
    // The custom box shows an emoji that is not among the suggestions.
    const custom = isEmoji(iconChoice) && !EMOJI_SUGGESTIONS.includes(iconChoice);
    fwEmoji.value = custom ? iconChoice : '';
    fwEmoji.removeAttribute('aria-invalid');
  }

  function showIconPanel(open) {
    fwIconPanel.hidden = !open;
    fwIconTrigger.setAttribute('aria-expanded', String(open));
    if (open) (iconChoices.find(c => c.dataset.value === iconChoice) || fwEmoji).focus();
    else fwIconTrigger.focus();
  }

  fwIconTrigger.addEventListener('click', () => showIconPanel(fwIconPanel.hidden));
  // Escape closes the picker, not the whole dialog.
  fwIconPanel.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    showIconPanel(false);
  });

  fwEmoji.addEventListener('input', () => {
    const value = fwEmoji.value.trim();
    if (!value) { fwEmoji.removeAttribute('aria-invalid'); return; }
    if (!isEmoji(value)) { fwEmoji.setAttribute('aria-invalid', 'true'); return; }
    iconChoice = value;
    fwIconGlyph.innerHTML = icon(value, { size: 18 });
    fwIconTrigger.setAttribute('aria-label', `Icon: ${value}`);
    for (const choice of iconChoices) choice.setAttribute('aria-pressed', String(choice.dataset.value === value));
    fwEmoji.removeAttribute('aria-invalid');
  });
  fwEmoji.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (!fwEmoji.hasAttribute('aria-invalid')) showIconPanel(false); }
  });

  /* ---------------------------------------------- Ordered fallback models */
  function fallbackEngineOptions() {
    return [
      { value: '', label: 'Automatic', desc: 'Use remaining keyed providers automatically', icon: 'wand' },
      ...engineOptions({ full: true }).map(opt =>
        opt.value === 'offline'
          ? { ...opt, label: 'Offline (stop here)', desc: 'Degrade to offline template without trying later providers' }
          : opt
      )
    ];
  }

  function providerDefaultModel(eng) {
    return MODEL_FIELDS[eng]?.value.trim() || PROVIDER_DEFAULTS[eng]?.model || '';
  }

  function fallbackPresetModelsFor(eng) {
    if (eng === 'openrouter') {
      if (orRawCatalog) {
        const pool = orShowAll ? orRawCatalog : orRawCatalog.filter(isOpenRouterFree);
        return pool.slice(0, 120);
      }
      return OPENROUTER_FREE_MODELS;
    }
    if (eng === 'omniroute') return omniModels;
    return PROVIDER_MODEL_PRESETS[eng] || [];
  }

  function buildFallbackPresetOptions(eng, models) {
    const iconName = eng === 'omniroute' || eng === 'openrouter' ? 'branch' : 'cloud';
    const configuredDefault = providerDefaultModel(eng);
    return [
      {
        value: DEFAULT_FALLBACK_MODEL,
        label: 'Default (provider setting)',
        desc: configuredDefault ? `Currently ${configuredDefault}` : 'Uses provider default',
        icon: iconName
      },
      ...models.map(m => ({ value: m.id, label: m.name || m.id, desc: m.id, icon: iconName })),
      { value: CUSTOM_MODEL, label: 'Custom model ID…', desc: 'Type your own on the right', icon: 'edit' }
    ];
  }

  function createFallbackBinding({ index, engineSlot, presetSlot, modelInput }) {
    const engineSelectSlot = createSelect({
      options: fallbackEngineOptions(),
      value: '',
      label: `Fallback ${index} engine`,
      placement: 'down',
      onChange: () => {
        modelInput.value = '';
        syncControls();
        updateFallbackHints();
        syncDirtyState();
      }
    });
    engineSlot.appendChild(engineSelectSlot.element);

    const presetSelect = createSelect({
      options: [
        { value: DEFAULT_FALLBACK_MODEL, label: 'No model selection', desc: 'Pick an engine to choose a model', icon: 'wand' }
      ],
      value: DEFAULT_FALLBACK_MODEL,
      label: `Fallback ${index} model preset`,
      placement: 'down',
      onChange: v => {
        if (v === DEFAULT_FALLBACK_MODEL) {
          modelInput.value = '';
        } else if (v === CUSTOM_MODEL) {
          modelInput.focus();
          modelInput.select();
        } else {
          modelInput.value = v;
        }
        updateFallbackHints();
        syncDirtyState();
      }
    });
    presetSlot.appendChild(presetSelect.element);

    function syncPresetFromInput() {
      const eng = engineSelectSlot.getValue();
      if (!eng || eng === 'nano' || eng === 'offline') return;
      const typed = modelInput.value.trim();
      if (!typed) {
        if (presetSelect.getValue() !== DEFAULT_FALLBACK_MODEL) {
          presetSelect.setValue(DEFAULT_FALLBACK_MODEL, { silent: true });
        }
        return;
      }
      const models = fallbackPresetModelsFor(eng);
      const want = models.some(m => m.id === typed) ? typed : CUSTOM_MODEL;
      if (presetSelect.getValue() !== want) presetSelect.setValue(want, { silent: true });
    }

    function syncControls() {
      const eng = engineSelectSlot.getValue();
      const hasModel = Boolean(eng && eng !== 'nano' && eng !== 'offline');
      const trigger = presetSelect.element.querySelector('.pc-select__trigger');

      if (!hasModel) {
        if (modelInput.value !== '') modelInput.value = '';
        modelInput.placeholder = 'No model needed';
        modelInput.disabled = true;
        presetSelect.setOptions([
          {
            value: DEFAULT_FALLBACK_MODEL,
            label: 'No model selection',
            desc: 'Not used for this option',
            icon: eng === 'nano' ? 'cpu' : eng === 'offline' ? 'shield' : 'wand'
          }
        ]);
        presetSelect.setValue(DEFAULT_FALLBACK_MODEL, { silent: true });
        if (trigger) trigger.disabled = true;
        return;
      }

      const defaultModel = providerDefaultModel(eng);
      modelInput.disabled = false;
      modelInput.placeholder = defaultModel ? `Default (${defaultModel})` : 'Provider default';
      if (trigger) trigger.disabled = false;

      presetSelect.setOptions(buildFallbackPresetOptions(eng, fallbackPresetModelsFor(eng)));
      syncPresetFromInput();
    }

    modelInput.addEventListener('input', () => {
      syncPresetFromInput();
      updateFallbackHints();
      syncDirtyState();
    });

    return { engineSelect: engineSelectSlot, presetSelect, syncControls };
  }

  function updateFallbackHints() {
    const primary = engineSelect.getValue();
    const allowCloud = el.allowCloudFallback.checked;
    const fb1Eng = fallback1.engineSelect.getValue();
    const fb1Raw = el.fallback1Model.value.trim();

    for (const idx of [1, 2]) {
      const slot = idx === 1 ? fallback1 : fallback2;
      const input = idx === 1 ? el.fallback1Model : el.fallback2Model;
      const hintEl = idx === 1 ? el.fallback1Hint : el.fallback2Hint;
      const eng = slot.engineSelect.getValue();
      const rawModel = input.value.trim();

      if (idx === 2 && fb1Eng === 'offline') {
        hintEl.textContent = 'Skipped because Fallback 1 stops at the offline template.';
        continue;
      }
      if (!eng) {
        hintEl.textContent = 'Empty slot. Choose a provider or use the offline template.';
        continue;
      }
      if (eng === 'offline') {
        hintEl.textContent = 'Stops the fallback chain here and returns the offline template immediately.';
        continue;
      }
      if (!allowCloud && eng !== 'nano') {
        hintEl.textContent = 'Skipped while cloud fallback is off.';
        continue;
      }
      if (API_KEY_FIELDS[eng] && !API_KEY_FIELDS[eng].value.trim()) {
        hintEl.textContent = `No ${ENGINE_LABELS[eng] || eng} API key entered below yet — skipped until a key is saved.`;
        continue;
      }
      if (eng === 'nano') {
        hintEl.textContent = primary === 'nano'
          ? 'Matches Default engine (Chrome Nano) and is skipped unless Default engine changes.'
          : 'Runs on-device Chrome built-in Nano if it is available in this browser.';
        continue;
      }

      const effModel = rawModel || providerDefaultModel(eng);
      const effPrimaryModel = providerDefaultModel(primary);
      if (eng === primary && effModel === effPrimaryModel) {
        hintEl.textContent = `Matches Default engine (${ENGINE_LABELS[eng] || eng} · ${effModel}) — enter a different Model ID override to retry another model on this provider.`;
        continue;
      }
      if (idx === 2 && fb1Eng && fb1Eng !== 'nano' && fb1Eng !== 'offline') {
        const effFb1Model = fb1Raw || providerDefaultModel(fb1Eng);
        if (eng === fb1Eng && effModel === effFb1Model) {
          hintEl.textContent = `Matches Fallback 1 (${ENGINE_LABELS[fb1Eng] || fb1Eng} · ${effFb1Model}) and will be skipped as a duplicate.`;
          continue;
        }
      }
      if (eng === 'omniroute') {
        hintEl.textContent = `Routes via OmniRoute (${effModel}) after you approve the destination.`;
        continue;
      }
      hintEl.textContent = `Runs ${ENGINE_LABELS[eng] || eng} (${effModel}) after you approve the destination.`;
    }
  }

  const fallback1 = createFallbackBinding({
    index: 1,
    engineSlot: el.fallback1EngineSlot,
    presetSlot: el.fallback1PresetSlot,
    modelInput: el.fallback1Model
  });

  const fallback2 = createFallbackBinding({
    index: 2,
    engineSlot: el.fallback2EngineSlot,
    presetSlot: el.fallback2PresetSlot,
    modelInput: el.fallback2Model
  });

  /* ------------------------------------------------ Provider model presets */
  function createPresetBinding({ presets, input, slot, label, iconName = 'cloud', placement = 'up' }) {
    let list = presets.slice();

    function buildOptions(models) {
      return models
        .map(m => ({ value: m.id, label: m.name || m.id, desc: m.id, icon: iconName }))
        .concat([{ value: CUSTOM_MODEL, label: 'Custom model ID…', desc: 'Type your own below', icon: 'edit' }]);
    }

    const select = createSelect({
      options: buildOptions(list),
      value: CUSTOM_MODEL,
      label,
      placement,
      onChange: v => {
        if (v === CUSTOM_MODEL) {
          input.focus();
          input.select();
        } else {
          input.value = v;
          refreshFallbackSlots();
          syncDirtyState();
        }
      }
    });
    slot.appendChild(select.element);

    function syncFromInput() {
      const val = input.value.trim();
      const want = list.some(m => m.id === val) ? val : CUSTOM_MODEL;
      if (select.getValue() !== want) select.setValue(want, { silent: true });
    }

    input.addEventListener('input', syncFromInput);

    return {
      select,
      syncFromInput,
      setModels(nextModels) {
        list = nextModels.slice();
        select.setOptions(buildOptions(list));
        syncFromInput();
      }
    };
  }

  const omniPreset = createPresetBinding({
    presets: PROVIDER_MODEL_PRESETS.omniroute,
    input: el.omniModelInput,
    slot: el.omniModelSlot,
    label: 'OmniRoute preset',
    iconName: 'branch'
  });

  const geminiPreset = createPresetBinding({
    presets: PROVIDER_MODEL_PRESETS.gemini,
    input: el.geminiModel,
    slot: el.geminiModelSlot,
    label: 'Gemini preset'
  });

  const openaiPreset = createPresetBinding({
    presets: PROVIDER_MODEL_PRESETS.openai,
    input: el.openaiModel,
    slot: el.openaiModelSlot,
    label: 'OpenAI preset'
  });

  const anthropicPreset = createPresetBinding({
    presets: PROVIDER_MODEL_PRESETS.anthropic,
    input: el.anthropicModel,
    slot: el.anthropicModelSlot,
    label: 'Anthropic preset'
  });

  /* --------------------------------------------------- OpenRouter catalog */
  function isOpenRouterFree(m) {
    return m.id === 'openrouter/free'
      || m.id.endsWith(':free')
      || (m.pricing && m.pricing.prompt === '0' && m.pricing.completion === '0');
  }

  function filteredOpenRouterModels() {
    const base = orRawCatalog || OPENROUTER_FREE_MODELS;
    const pool = orShowAll ? base : base.filter(isOpenRouterFree);
    const q = orFilterQuery.trim().toLowerCase();
    const matched = q
      ? pool.filter(m => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
      : pool;
    return matched.slice(0, 120);
  }

  function buildOrOptions(models) {
    return models
      .map(m => ({ value: m.id, label: m.name || m.id, desc: m.id, icon: 'cloud' }))
      .concat([{ value: CUSTOM_MODEL, label: 'Custom model ID…', desc: 'Type your own below', icon: 'edit' }]);
  }

  const orModelSelect = createSelect({
    options: buildOrOptions(orModels),
    value: settings.openrouterModel || PROVIDER_DEFAULTS.openrouter.model,
    label: 'OpenRouter model',
    placement: 'up',
    onChange: v => {
      if (v === CUSTOM_MODEL) {
        el.orModelInput.focus();
        el.orModelInput.select();
      } else {
        el.orModelInput.value = v;
        refreshFallbackSlots();
        syncDirtyState();
      }
    }
  });
  el.orModelSlot.appendChild(orModelSelect.element);

  function refreshOpenRouterOptions() {
    orModels = filteredOpenRouterModels();
    orModelSelect.setOptions(buildOrOptions(orModels));
    const current = el.orModelInput.value.trim();
    const want = orModels.some(m => m.id === current) ? current : CUSTOM_MODEL;
    if (orModelSelect.getValue() !== want) orModelSelect.setValue(want, { silent: true });
  }

  async function fetchOpenRouterCatalog() {
    const btn = el.fetchModelsBtn;
    btn.disabled = true;
    btn.innerHTML = `<span class="pc-spinner"></span> Fetching…`;
    try {
      const key = el.orApiKey.value.trim();
      const headers = key ? { Authorization: `Bearer ${key}` } : {};
      const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = (data.data || []).map(m => ({ id: m.id, name: m.name || m.id, pricing: m.pricing }));
      if (!all.length) throw new Error('No models returned');

      orRawCatalog = all;
      refreshOpenRouterOptions();
      refreshFallbackSlots();
      const freeCount = all.filter(isOpenRouterFree).length;
      toast(orShowAll ? `Loaded ${all.length} models` : `Loaded ${freeCount} free models`);
    } catch (err) {
      toast(`Fetch failed: ${err.message}`, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('refresh', { size: 12 })} Fetch live models`;
    }
  }

  el.orModelSelectLabel.textContent = orShowAll ? 'Catalog model' : 'Free model';
  el.orModelInput.addEventListener('input', () => {
    const match = orModels.some(m => m.id === el.orModelInput.value.trim());
    const want = match ? el.orModelInput.value.trim() : CUSTOM_MODEL;
    if (orModelSelect.getValue() !== want) orModelSelect.setValue(want, { silent: true });
  });

  el.orAllToggle.addEventListener('change', async () => {
    orShowAll = el.orAllToggle.checked;
    el.orModelSelectLabel.textContent = orShowAll ? 'Catalog model' : 'Free model';
    if (orShowAll && orRawCatalog === null) {
      await fetchOpenRouterCatalog();
    } else {
      refreshOpenRouterOptions();
      refreshFallbackSlots();
    }
  });

  el.orModelFilter.addEventListener('input', () => {
    orFilterQuery = el.orModelFilter.value;
    refreshOpenRouterOptions();
  });

  el.fetchModelsBtn.addEventListener('click', fetchOpenRouterCatalog);

  /* --------------------------------------------------- OmniRoute helpers */
  async function ensureOriginPermission(rawUrl) {
    const normalized = normalizeBaseUrl(rawUrl);
    if (!normalized) {
      throw new Error('Enter a valid http:// or https:// OmniRoute Base URL.');
    }
    const originPattern = `${new URL(normalized).origin}/*`;
    if (chrome.permissions?.request) {
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) {
        throw new Error(`Permission for ${new URL(normalized).origin} was denied.`);
      }
    }
    return normalized;
  }

  el.fetchOmniModelsBtn.addEventListener('click', async () => {
    const btn = el.fetchOmniModelsBtn;
    try {
      const baseUrl = await ensureOriginPermission(el.omniBaseUrl.value);
      el.omniBaseUrl.value = baseUrl;
      btn.disabled = true;
      btn.innerHTML = `<span class="pc-spinner"></span> Fetching…`;

      const key = el.omniApiKey.value.trim();
      const headers = key ? { Authorization: `Bearer ${key}` } : {};
      const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const seen = new Set(PROVIDER_MODEL_PRESETS.omniroute.map(m => m.id));
      const discovered = (data.data || [])
        .map(m => ({ id: String(m.id || '').trim(), name: String(m.name || m.id || '').trim() }))
        .filter(m => m.id && !seen.has(m.id));

      if (!discovered.length) {
        omniModels = PROVIDER_MODEL_PRESETS.omniroute.slice();
        omniPreset.setModels(omniModels);
        toast('Gateway answered; using default auto routes', 'neutral');
      } else {
        omniModels = [...PROVIDER_MODEL_PRESETS.omniroute, ...discovered];
        omniPreset.setModels(omniModels);
        toast(`Loaded ${discovered.length} OmniRoute route${discovered.length === 1 ? '' : 's'}`);
      }
      if (!el.omniEnabled.checked) {
        el.omniEnabled.checked = true;
      }
      refreshFallbackSlots();
      syncDirtyState();
    } catch (err) {
      toast(`Fetch failed: ${err.message}`, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('refresh', { size: 12 })} Fetch live routes`;
    }
  });

  /* ------------------------------------------------------------ Populate */
  const preferredEngine = settings.preferredEngine || DEFAULT_ENGINE;
  engineSelect.setValue(preferredEngine, { silent: true });
  el.allowCloudFallback.checked = settings.allowCloudFallback !== false;

  for (const [provider, input] of Object.entries(MODEL_FIELDS)) {
    input.placeholder = PROVIDER_DEFAULTS[provider].model;
    input.value = settings[`${provider}Model`] || PROVIDER_DEFAULTS[provider].model;
  }

  el.geminiApiKey.value = settings.geminiApiKey || '';
  el.openaiApiKey.value = settings.openaiApiKey || '';
  el.anthropicApiKey.value = settings.anthropicApiKey || '';
  el.orApiKey.value = settings.openrouterApiKey || '';

  el.omniEnabled.checked = Boolean(settings.omnirouteEnabled);
  el.omniBaseUrl.placeholder = PROVIDER_DEFAULTS.omniroute.baseUrl;
  el.omniBaseUrl.value = settings.omnirouteBaseUrl || PROVIDER_DEFAULTS.omniroute.baseUrl;
  el.omniApiKey.value = settings.omnirouteApiKey || '';

  el.customPrompt.value = settings.customSystemPrompt || '';
  el.widgetToggle.checked = settings.enableFloatingWidget !== false;
  el.quickRepairToggle.checked = settings.quickRepairEnabled !== false;
  el.maxHistory.value = String(clampMaxHistory(settings.maxHistoryItems, 20));

  geminiPreset.syncFromInput();
  openaiPreset.syncFromInput();
  anthropicPreset.syncFromInput();
  omniPreset.syncFromInput();
  refreshOpenRouterOptions();

  el.fallback1Model.value = settings.fallback1Model || '';
  el.fallback2Model.value = settings.fallback2Model || '';
  fallback1.engineSelect.setValue(settings.fallback1Engine || '', { silent: true });
  fallback2.engineSelect.setValue(settings.fallback2Engine || '', { silent: true });
  refreshFallbackSlots();

  el.maxHistory.addEventListener('change', () => {
    el.maxHistory.value = String(clampMaxHistory(el.maxHistory.value, 20));
    syncDirtyState();
  });
  el.maxHistory.addEventListener('blur', () => {
    el.maxHistory.value = String(clampMaxHistory(el.maxHistory.value, 20));
    syncDirtyState();
  });

  const fallbackSensitiveInputs = [
    el.orApiKey, el.orModelInput,
    el.omniBaseUrl, el.omniApiKey, el.omniModelInput,
    el.geminiApiKey, el.geminiModel,
    el.openaiApiKey, el.openaiModel,
    el.anthropicApiKey, el.anthropicModel
  ];
  fallbackSensitiveInputs.forEach(input => input.addEventListener('input', refreshFallbackSlots));

  const watchedTextInputs = [
    ...fallbackSensitiveInputs,
    el.customPrompt, el.maxHistory
  ];
  watchedTextInputs.forEach(input => input.addEventListener('input', syncDirtyState));
  [el.allowCloudFallback, el.omniEnabled, el.widgetToggle, el.quickRepairToggle].forEach(cb => {
    cb.addEventListener('change', () => {
      updateFallbackHints();
      syncDirtyState();
    });
  });

  /* ---------------------------------------------------------- Frameworks */
  let frameworkNames = new Map();

  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function refreshFrameworks() {
    const frameworks = await getFrameworks();
    frameworkNames = new Map(frameworks.map(f => [f.id, f.name]));
    frameworkOptions = frameworks.map(fw => ({
      value: fw.id,
      label: fw.name,
      icon: iconValue(fw.icon)
    }));

    const keep = frameworks.some(f => f.id === frameworkSelect.getValue())
      ? frameworkSelect.getValue()
      : (settings.preferredFramework && frameworks.some(f => f.id === settings.preferredFramework)
          ? settings.preferredFramework
          : frameworks[0]?.id);

    frameworkSelect.setOptions(frameworkOptions);
    if (keep) frameworkSelect.setValue(keep, { silent: true });

    el.frameworksList.innerHTML = '';
    frameworks.forEach(fw => {
      const only = frameworks.length <= 1;
      const card = document.createElement('div');
      card.className = 'pc-framework';
      card.innerHTML = `
        <span class="pc-framework__glyph">${icon(iconValue(fw.icon), { size: 16 })}</span>
        <div class="pc-framework__body">
          <div class="pc-framework__title">
            <span class="pc-framework__name">${escapeHtml(fw.name)}</span>
            <span class="pc-framework__id">${escapeHtml(fw.id)}</span>
          </div>
          <div class="pc-framework__tagline">${escapeHtml(fw.tagline || '—')}</div>
          ${fw.systemPrompt ? `<div class="pc-framework__snippet">${escapeHtml(fw.systemPrompt)}</div>` : ''}
        </div>
        <div class="pc-framework__actions">
          <button type="button" class="pc-icon-btn" data-action="edit" data-id="${escapeHtml(fw.id)}"
                  title="Edit" aria-label="Edit ${escapeHtml(fw.name)}">${icon('edit', { size: 14 })}</button>
          <button type="button" class="pc-icon-btn" data-action="delete" data-id="${escapeHtml(fw.id)}"
                  title="${only ? 'At least one type is required' : 'Delete'}"
                  aria-label="Delete ${escapeHtml(fw.name)}" ${only ? 'disabled style="opacity:.35;"' : ''}>
            ${icon('trash', { size: 14 })}
          </button>
        </div>
      `;

      card.querySelector('[data-action="edit"]').addEventListener('click', () => openModal(fw));
      const del = card.querySelector('[data-action="delete"]');
      if (!only) {
        del.addEventListener('click', async () => {
          if (!confirmByClick(del, `Click delete again to remove "${fw.name}"`)) return;
          await writeUserData('deleteFramework', fw.id);
          toast(`Deleted "${fw.name}"`);
          await refreshFrameworks();
          syncDirtyState();
        });
      }

      el.frameworksList.appendChild(card);
    });
  }

  el.exportFrameworksBtn.addEventListener('click', async () => {
    const frameworks = await getFrameworks();
    downloadJson('promptoptimizer-frameworks.json', { version: 1, frameworks });
    toast(`Exported ${frameworks.length} optimizer type${frameworks.length === 1 ? '' : 's'}`);
  });

  el.importFrameworksBtn.addEventListener('click', () => {
    el.importFrameworksFile.value = '';
    el.importFrameworksFile.click();
  });

  el.importFrameworksFile.addEventListener('change', async () => {
    const file = el.importFrameworksFile.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rawList = Array.isArray(parsed) ? parsed : parsed?.frameworks;
      if (!Array.isArray(rawList)) throw new Error('Expected a JSON array or { frameworks: [...] }.');

      const validItems = [];
      for (const item of rawList) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim();
        const systemPrompt = String(item.systemPrompt || '').trim();
        const template = String(item.template || '').trim();
        if (!name || (!systemPrompt && !template)) continue;
        const slug = String(item.id || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/(^-|-$)/g, '') ||
          name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') ||
          `custom-${Date.now()}-${validItems.length}`;
        validItems.push({
          id: slug,
          name,
          tagline: String(item.tagline || '').trim(),
          icon: iconValue(item.icon),
          systemPrompt: systemPrompt || 'Rewrite the user prompt for optimal clarity, structure, and depth.',
          template
        });
      }

      if (!validItems.length) throw new Error('No valid optimizer types found in file.');

      const existing = await getFrameworks();
      const merged = existing.slice();
      let imported = 0;
      for (const fw of validItems) {
        const idx = merged.findIndex(f => f.id === fw.id);
        if (idx >= 0) merged[idx] = { ...merged[idx], ...fw };
        else merged.push(fw);
        imported++;
      }
      await writeUserData('saveFrameworks', merged);
      await refreshFrameworks();
      syncDirtyState();
      toast(`Imported ${imported} optimizer type${imported === 1 ? '' : 's'}`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'danger');
    }
  });

  /* --------------------------------------------------------------- Modal */
  function openModal(fw = null) {
    if (fw) {
      el.modalTitle.textContent = `Edit · ${fw.name}`;
      el.fwId.value = fw.id;
      setIcon(fw.icon);
      el.fwName.value = fw.name || '';
      el.fwTagline.value = fw.tagline || '';
      el.fwSystemPrompt.value = fw.systemPrompt || '';
      el.fwTemplate.value = fw.template || '';
    } else {
      el.modalTitle.textContent = 'New optimizer type';
      el.fwId.value = '';
      setIcon('wand');
      el.fwName.value = '';
      el.fwTagline.value = '';
      el.fwSystemPrompt.value = '';
      el.fwTemplate.value = '';
    }
    fwIconPanel.hidden = true;
    fwIconTrigger.setAttribute('aria-expanded', 'false');
    el.modalBackdrop.hidden = false;
    el.fwName.focus();
  }

  function closeModal() {
    el.modalBackdrop.hidden = true;
  }

  el.modalCloseBtn.addEventListener('click', closeModal);
  el.cancelFrameworkBtn.addEventListener('click', closeModal);
  el.modalBackdrop.addEventListener('click', e => {
    if (e.target === el.modalBackdrop) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el.modalBackdrop.hidden) closeModal();
  });

  el.addFrameworkBtn.addEventListener('click', () => openModal(null));

  el.resetFrameworksBtn.addEventListener('click', async () => {
    if (!confirmByClick(el.resetFrameworksBtn, 'Click Reset again to restore the factory types. Custom edits will be lost.')) return;
    await writeUserData('resetFrameworksToDefault');
    await refreshFrameworks();
    syncDirtyState();
    toast('Restored defaults');
  });

  el.saveFrameworkBtn.addEventListener('click', async () => {
    const name = el.fwName.value.trim();
    if (!name) {
      el.fwName.focus();
      toast('A display name is required', 'danger');
      return;
    }
    if (fwEmoji.hasAttribute('aria-invalid')) {
      showIconPanel(true);
      fwEmoji.focus();
      toast('Use a single emoji, or pick an icon', 'danger');
      return;
    }
    const id = el.fwId.value.trim() ||
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') ||
      `custom-${Date.now()}`;

    await writeUserData('upsertFramework', {
      id,
      name,
      icon: iconChoice,
      tagline: el.fwTagline.value.trim(),
      systemPrompt: el.fwSystemPrompt.value.trim() ||
        'Rewrite the user prompt for optimal clarity, structure, and depth.',
      template: el.fwTemplate.value.trim()
    });

    closeModal();
    toast(`Saved "${name}"`);
    await refreshFrameworks();
    syncDirtyState();
  });

  await refreshFrameworks();
  markClean();

  /* -------------------------------------------------------------- Library */
  /* Saved prompts: named, labelled, searchable. Changes apply immediately and
     are not part of the "Save changes" form above. Prompts arrive here from the
     Save button in the popup and the in-page optimizer. */
  const lib = { entries: [], query: '', label: '', frameworkNames: new Map() };

  const libEl = {
    summary: $('library-summary'),
    search: $('library-search'),
    labels: $('library-labels'),
    list: $('library-list'),
    addBtn: $('add-prompt-btn'),
    backdrop: $('prompt-modal-backdrop'),
    modalTitle: $('prompt-modal-title'),
    closeBtn: $('prompt-modal-close-btn'),
    cancelBtn: $('cancel-prompt-btn'),
    saveBtn: $('save-prompt-btn'),
    id: $('pm-id'),
    title: $('pm-title'),
    labelsInput: $('pm-labels'),
    chips: $('pm-label-chips'),
    text: $('pm-text'),
    originalHint: $('pm-original-hint')
  };

  const formatDate = ts =>
    ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  function labelChip({ label, count, pressed, filter }) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pc-labelchip';
    chip.dataset.label = filter;
    chip.setAttribute('aria-pressed', String(pressed));
    chip.innerHTML = `<span>${escapeHtml(label)}</span>` +
      (count != null ? `<span class="pc-labelchip__count">${count}</span>` : '');
    return chip;
  }

  function renderLibrary() {
    const total = lib.entries.length;
    const labels = collectLabels(lib.entries);
    // A filter on a label that no longer exists would show an empty list with no way out.
    if (lib.label && !labels.some(l => l.label.toLowerCase() === lib.label.toLowerCase())) lib.label = '';
    const shown = filterLibrary(lib.entries, { query: lib.query, label: lib.label });

    const count = shown.length === total ? String(total) : `${shown.length} of ${total}`;
    libEl.summary.textContent = total === 0
      ? 'Nothing saved yet.'
      : `${count} saved prompt${total === 1 ? '' : 's'}`;

    libEl.labels.innerHTML = '';
    if (labels.length) {
      libEl.labels.appendChild(labelChip({ label: 'All', count: total, pressed: !lib.label, filter: '' }));
      for (const { label, count: n } of labels) {
        libEl.labels.appendChild(labelChip({
          label, count: n, filter: label, pressed: lib.label.toLowerCase() === label.toLowerCase()
        }));
      }
    }

    libEl.list.innerHTML = '';
    if (shown.length === 0) {
      libEl.list.innerHTML = total === 0
        ? '<div class="pc-library__empty"><strong>No saved prompts</strong>Press Save under an optimized prompt in the popup or the in-page optimizer, or use New prompt.</div>'
        : '<div class="pc-library__empty"><strong>No prompts match</strong>Try a different search or label.</div>';
      return;
    }

    for (const entry of shown) {
      const meta = [
        formatDate(entry.updatedAt),
        lib.frameworkNames.get(entry.framework) || entry.framework,
        ENGINE_LABELS[entry.engine] || entry.engine
      ].filter(Boolean).join(' · ');

      const card = document.createElement('article');
      card.className = 'pc-saved';
      card.innerHTML = `
        <div class="pc-saved__head">
          <div>
            <h3 class="pc-saved__title">${escapeHtml(entry.title)}</h3>
            <span class="pc-saved__meta">${escapeHtml(meta)}</span>
          </div>
          <div class="pc-saved__actions">
            <button type="button" class="pc-icon-btn" data-action="copy" title="Copy"
                    aria-label="Copy ${escapeHtml(entry.title)}">${icon('copy', { size: 14 })}</button>
            <button type="button" class="pc-icon-btn" data-action="edit" title="Edit"
                    aria-label="Edit ${escapeHtml(entry.title)}">${icon('edit', { size: 14 })}</button>
            <button type="button" class="pc-icon-btn" data-action="delete" title="Delete"
                    aria-label="Delete ${escapeHtml(entry.title)}">${icon('trash', { size: 14 })}</button>
          </div>
        </div>
        ${entry.labels.length ? `<div class="pc-saved__labels">${entry.labels.map(l => `<span class="pc-labelchip">${escapeHtml(l)}</span>`).join('')}</div>` : ''}
        <p class="pc-saved__text">${escapeHtml(entry.text)}</p>
      `;

      card.querySelector('[data-action="copy"]').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(entry.text);
          toast('Copied to clipboard');
        } catch {
          toast('Could not copy', 'danger');
        }
      });
      card.querySelector('[data-action="edit"]').addEventListener('click', () => openPromptModal(entry));
      card.querySelector('[data-action="delete"]').addEventListener('click', async e => {
        if (!confirmByClick(e.currentTarget, `Click delete again to remove "${entry.title}"`)) return;
        await writeUserData('deleteLibraryEntry', entry.id);
        toast(`Deleted "${entry.title}"`);
        await refreshLibrary();
      });

      libEl.list.appendChild(card);
    }
  }

  async function refreshLibrary() {
    const [entries, frameworks] = await Promise.all([getLibrary(), getFrameworks()]);
    lib.entries = entries;
    lib.frameworkNames = new Map(frameworks.map(f => [f.id, f.name]));
    frameworkNames = lib.frameworkNames;
    renderLibrary();
  }

  el.exportLibraryBtn.addEventListener('click', async () => {
    const entries = await getLibrary();
    downloadJson('promptoptimizer-library.json', { version: 1, entries });
    toast(`Exported ${entries.length} saved prompt${entries.length === 1 ? '' : 's'}`);
  });

  el.importLibraryBtn.addEventListener('click', () => {
    el.importLibraryFile.value = '';
    el.importLibraryFile.click();
  });

  el.importLibraryFile.addEventListener('change', async () => {
    const file = el.importLibraryFile.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rawList = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(rawList)) throw new Error('Expected a JSON array or { entries: [...] }.');

      const existing = await getLibrary();
      const seen = new Set(existing.map(e => `${e.title}\0${e.text}`));
      let added = 0;
      let skipped = 0;
      let stoppedBy = '';

      for (const item of rawList) {
        if (existing.length + added >= LIMITS.entries) {
          stoppedBy = `The library is full (${LIMITS.entries} prompts).`;
          break;
        }
        if (!item || typeof item !== 'object') continue;
        const text = String(item.text || '').trim();
        if (!text || text.length > LIMITS.text) {
          skipped++;
          continue;
        }
        const title = (String(item.title || '').trim() || deriveTitle(text)).slice(0, LIMITS.title);
        const key = `${title}\0${text}`;
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        try {
          await writeUserData('saveToLibrary', {
            title,
            text,
            original: String(item.original || '').trim(),
            labels: item.labels,
            framework: String(item.framework || ''),
            engine: String(item.engine || '')
          });
        } catch (err) {
          // Keep what was imported so far and say why the rest was not.
          stoppedBy = err.message;
          break;
        }
        added++;
      }

      await refreshLibrary();
      if (!added && !skipped && !stoppedBy) throw new Error('No valid prompts found in file.');
      const summary = added
        ? `Imported ${added} prompt${added === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}`
        : `No new prompts imported${skipped ? ` (${skipped} duplicate or invalid)` : ''}`;
      toast(stoppedBy ? `${summary}. Stopped: ${stoppedBy}` : summary, stoppedBy ? 'danger' : added ? 'success' : 'neutral');
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'danger');
    }
  });

  libEl.search.addEventListener('input', () => {
    lib.query = libEl.search.value;
    renderLibrary();
  });

  libEl.labels.addEventListener('click', e => {
    const chip = e.target.closest('.pc-labelchip');
    if (!chip) return;
    lib.label = chip.dataset.label;
    renderLibrary();
  });

  /* Editor ----------------------------------------------------------------- */
  function syncModalChips() {
    const active = new Set(normalizeLabels(libEl.labelsInput.value).map(l => l.toLowerCase()));
    libEl.chips.querySelectorAll('.pc-labelchip').forEach(chip => {
      chip.setAttribute('aria-pressed', String(active.has(chip.dataset.label.toLowerCase())));
    });
  }

  function renderModalChips() {
    const labels = collectLabels(lib.entries).slice(0, 16);
    libEl.chips.innerHTML = '';
    libEl.chips.hidden = labels.length === 0;
    for (const { label } of labels) {
      libEl.chips.appendChild(labelChip({ label, pressed: false, filter: label }));
    }
    syncModalChips();
  }

  libEl.chips.addEventListener('click', e => {
    const chip = e.target.closest('.pc-labelchip');
    if (!chip) return;
    const label = chip.dataset.label;
    const current = normalizeLabels(libEl.labelsInput.value);
    const has = current.some(l => l.toLowerCase() === label.toLowerCase());
    libEl.labelsInput.value = (has
      ? current.filter(l => l.toLowerCase() !== label.toLowerCase())
      : [...current, label]).join(', ');
    syncModalChips();
  });
  libEl.labelsInput.addEventListener('input', syncModalChips);

  function openPromptModal(entry = null) {
    libEl.modalTitle.textContent = entry ? 'Edit saved prompt' : 'New saved prompt';
    libEl.id.value = entry?.id || '';
    libEl.title.value = entry?.title || '';
    libEl.labelsInput.value = (entry?.labels || []).join(', ');
    libEl.text.value = entry?.text || '';

    const original = (entry?.original || '').replace(/\s+/g, ' ').trim();
    libEl.originalHint.hidden = !original;
    libEl.originalHint.textContent = original
      ? `Saved from the draft: "${original.length > 90 ? `${original.slice(0, 90)}…` : original}"`
      : '';

    renderModalChips();
    libEl.backdrop.hidden = false;
    libEl.title.focus();
  }

  function closePromptModal() {
    libEl.backdrop.hidden = true;
  }

  libEl.addBtn.addEventListener('click', () => openPromptModal(null));
  libEl.closeBtn.addEventListener('click', closePromptModal);
  libEl.cancelBtn.addEventListener('click', closePromptModal);
  libEl.backdrop.addEventListener('click', e => {
    if (e.target === libEl.backdrop) closePromptModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !libEl.backdrop.hidden) closePromptModal();
  });

  libEl.saveBtn.addEventListener('click', async () => {
    const id = libEl.id.value;
    const fields = {
      title: libEl.title.value.trim(),
      text: libEl.text.value,
      labels: libEl.labelsInput.value
    };

    libEl.saveBtn.disabled = true;
    try {
      if (id) await writeUserData('updateLibraryEntry', { id, patch: fields });
      else await writeUserData('saveToLibrary', fields);
      closePromptModal();
      toast(id ? 'Prompt updated' : 'Prompt saved');
      await refreshLibrary();
    } catch (err) {
      toast(err.message, 'danger');
      if (/empty|too long/i.test(err.message)) libEl.text.focus();
    } finally {
      libEl.saveBtn.disabled = false;
    }
  });

  /* -------------------------------------------------------------- History */
  let historyEntries = [];
  let historyQuery = '';

  const formatTimestamp = ts => {
    if (!ts) return '';
    return new Date(ts).toLocaleString([], {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  };

  function renderHistorySection() {
    const total = historyEntries.length;
    const q = historyQuery.trim().toLowerCase();
    const shown = q
      ? historyEntries.filter(entry => {
          const fwLabel = frameworkNames.get(entry.framework) || entry.framework || '';
          const engLabel = ENGINE_LABELS[entry.engine] || entry.engine || '';
          return (entry.original || '').toLowerCase().includes(q)
            || (entry.optimized || '').toLowerCase().includes(q)
            || fwLabel.toLowerCase().includes(q)
            || (entry.framework || '').toLowerCase().includes(q)
            || engLabel.toLowerCase().includes(q)
            || (entry.engine || '').toLowerCase().includes(q);
        })
      : historyEntries;

    const countText = shown.length === total ? String(total) : `${shown.length} of ${total}`;
    el.historySummary.textContent = total === 0
      ? 'No optimizations recorded yet.'
      : `${countText} recent optimization${total === 1 ? '' : 's'}`;
    el.clearHistoryBtn.disabled = total === 0;

    el.historyList.innerHTML = '';
    if (shown.length === 0) {
      el.historyList.innerHTML = total === 0
        ? '<div class="pc-library__empty"><strong>No optimization history</strong>Optimize a prompt from the popup or any supported chat page and entries will appear here.</div>'
        : '<div class="pc-library__empty"><strong>No matching history entries</strong>Try a different search term.</div>';
      return;
    }

    for (const entry of shown) {
      const fwLabel = frameworkNames.get(entry.framework) || entry.framework || 'Optimizer';
      const engLabel = ENGINE_LABELS[entry.engine] || entry.engine || 'Unknown';
      const meta = [formatTimestamp(entry.timestamp), fwLabel, engLabel].filter(Boolean).join(' · ');

      const card = document.createElement('article');
      card.className = 'pc-saved pc-history-entry';
      card.innerHTML = `
        <div class="pc-saved__head">
          <div>
            <h3 class="pc-saved__title">${escapeHtml(deriveTitle(entry.original || entry.optimized))}</h3>
            <div class="pc-history-entry__meta">
              <span class="pc-saved__meta">${escapeHtml(meta)}</span>
              ${entry.degraded ? '<span class="pc-badge pc-badge--warning">Fallback</span>' : ''}
            </div>
          </div>
          <div class="pc-saved__actions">
            <button type="button" class="pc-icon-btn" data-action="copy" title="Copy optimized prompt"
                    aria-label="Copy optimized prompt">${icon('copy', { size: 14 })}</button>
            <button type="button" class="pc-icon-btn" data-action="save-library" title="Save to library"
                    aria-label="Save to library">${icon('bookmark', { size: 14 })}</button>
            <button type="button" class="pc-icon-btn" data-action="delete" title="Delete entry"
                    aria-label="Delete history entry">${icon('trash', { size: 14 })}</button>
          </div>
        </div>
        <div class="pc-history-entry__grid">
          <div class="pc-history-entry__pane">
            <span class="pc-history-entry__label">Original draft</span>
            <p class="pc-saved__text">${escapeHtml(entry.original || '')}</p>
          </div>
          <div class="pc-history-entry__pane">
            <span class="pc-history-entry__label">Optimized prompt</span>
            <p class="pc-saved__text">${escapeHtml(entry.optimized || '')}</p>
          </div>
        </div>
      `;

      card.querySelector('[data-action="copy"]').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(entry.optimized || '');
          toast('Copied to clipboard');
        } catch {
          toast('Could not copy', 'danger');
        }
      });

      card.querySelector('[data-action="save-library"]').addEventListener('click', async () => {
        try {
          await writeUserData('saveToLibrary', {
            title: deriveTitle(entry.optimized || entry.original),
            text: entry.optimized || '',
            original: entry.original || '',
            framework: entry.framework || '',
            engine: entry.engine || ''
          });
          await refreshLibrary();
          toast('Saved to library');
        } catch (err) {
          toast(err.message, 'danger');
        }
      });

      card.querySelector('[data-action="delete"]').addEventListener('click', async e => {
        if (!confirmByClick(e.currentTarget, 'Click delete again to remove this entry')) return;
        await writeUserData('removeHistoryEntry', entry.id);
        toast('History entry deleted');
        await refreshHistory();
      });

      el.historyList.appendChild(card);
    }
  }

  async function refreshHistory() {
    historyEntries = await getHistory();
    renderHistorySection();
  }

  el.historySearch.addEventListener('input', () => {
    historyQuery = el.historySearch.value;
    renderHistorySection();
  });

  el.clearHistoryBtn.addEventListener('click', async () => {
    if (!historyEntries.length) return;
    if (!confirmByClick(el.clearHistoryBtn, 'Click Clear all again to delete all history on this device')) return;
    await writeUserData('clearHistory');
    await refreshHistory();
    toast('History cleared');
  });

  // Live sync across tabs/popup/content
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[LIBRARY_KEY]) refreshLibrary();
    if (changes[HISTORY_KEY]) refreshHistory();
    if (changes[FRAMEWORKS_KEY]) {
      refreshFrameworks().then(() => {
        renderHistorySection();
      });
    }
  });

  await Promise.all([refreshLibrary(), refreshHistory()]);

  /* ------------------------------------------------------- Nano status */
  function setNanoTone(tone) {
    el.nanoBanner.classList.remove('pc-callout--accent', 'pc-callout--warning', 'pc-callout--success', 'pc-callout--danger');
    if (tone) el.nanoBanner.classList.add(`pc-callout--${tone}`);
  }

  function initNanoBanner() {
    if (typeof globalThis.LanguageModel === 'undefined') {
      setNanoTone('warning');
      el.nanoText.textContent = 'Unavailable (not exposed in this browser). Enable the Chrome flags below if using Chrome, or configure another engine above.';
      el.nanoActions.hidden = false;
      el.nanoDownloadBtn.hidden = true;
      el.nanoHelp.hidden = false;
      return;
    }
    setNanoTone('accent');
    el.nanoText.textContent = 'Built-in Prompt API detected in this browser. Click Check status to verify model availability or start a download.';
    el.nanoActions.hidden = false;
    el.nanoDownloadBtn.hidden = true;
    el.nanoHelp.hidden = true;
  }

  async function refreshNanoStatus() {
    el.nanoCheckBtn.disabled = true;
    el.nanoCheckBtn.innerHTML = `<span class="pc-spinner"></span><span>Checking…</span>`;
    try {
      const nano = await checkBuiltInPromptApiStatus();
      if (nano.available) {
        setNanoTone('success');
        el.nanoText.textContent = 'Ready — on-device Gemini Nano is available in this browser.';
        el.nanoActions.hidden = false;
        el.nanoDownloadBtn.hidden = true;
        el.nanoHelp.hidden = true;
      } else if (nano.status === 'downloadable') {
        setNanoTone('warning');
        el.nanoText.textContent = 'The on-device model is ready to download. Start the download below, or check the flags if it fails.';
        el.nanoActions.hidden = false;
        el.nanoDownloadBtn.hidden = false;
        el.nanoHelp.hidden = false;
      } else if (nano.status === 'downloading') {
        setNanoTone('warning');
        el.nanoText.textContent = 'The on-device model is currently downloading. Check chrome://components, then check status again.';
        el.nanoActions.hidden = false;
        el.nanoDownloadBtn.hidden = true;
        el.nanoHelp.hidden = false;
      } else if (nano.status === 'error') {
        setNanoTone('warning');
        const detail = String(nano.error || '').trim();
        if (/feature flag|gating model execution/i.test(detail)) {
          el.nanoText.textContent =
            `Disabled by browser flag (${detail}). Enable both flags below in Chrome and relaunch, or choose OmniRoute / an API key above.`;
        } else {
          el.nanoText.textContent = detail
            ? `Unavailable (${detail}). Enable the flags below or choose another engine.`
            : 'Unavailable (error probing the Prompt API). Enable the flags below or choose another engine.';
        }
        el.nanoActions.hidden = false;
        el.nanoDownloadBtn.hidden = true;
        el.nanoHelp.hidden = false;
      } else {
        setNanoTone('warning');
        const reason = nano.status === 'unsupported' ? 'not exposed in this browser' : (nano.status || 'not detected');
        el.nanoText.textContent = `Unavailable (${reason}). Enable the flags below to use it, or choose another engine.`;
        el.nanoActions.hidden = false;
        el.nanoDownloadBtn.hidden = true;
        el.nanoHelp.hidden = false;
      }
    } catch (err) {
      setNanoTone('warning');
      el.nanoActions.hidden = false;
      el.nanoDownloadBtn.hidden = true;
      el.nanoText.textContent = `Could not probe the Prompt API: ${err.message}`;
      el.nanoHelp.hidden = false;
    } finally {
      el.nanoCheckBtn.disabled = false;
      el.nanoCheckBtn.innerHTML = `${icon('refresh', { size: 13 })}<span>Check status</span>`;
    }
  }
  initNanoBanner();

  el.nanoCheckBtn.addEventListener('click', refreshNanoStatus);

  el.nanoDownloadBtn.addEventListener('click', async () => {
    const LM = globalThis.LanguageModel;
    if (!LM || typeof LM.create !== 'function') {
      toast('Built-in Prompt API is unavailable in this browser', 'danger');
      return;
    }
    el.nanoDownloadBtn.disabled = true;
    el.nanoCheckBtn.disabled = true;
    el.nanoDownloadBtn.innerHTML = `<span class="pc-spinner"></span><span>Starting download…</span>`;
    try {
      const session = await LM.create({
        ...NANO_SESSION_OPTIONS,
        monitor(m) {
          m.addEventListener('downloadprogress', ev => {
            const loaded = Number(ev?.loaded ?? 0);
            const total = Number(ev?.total ?? 0);
            const pct = total > 0 ? Math.round((loaded / total) * 100) : Math.round(loaded * 100);
            const clamped = Math.max(0, Math.min(100, pct));
            el.nanoText.textContent = `Downloading on-device Gemini Nano (${clamped}%)…`;
          });
        }
      });
      try { session?.destroy?.(); } catch {}
      await refreshNanoStatus();
      toast('On-device Gemini Nano is ready');
    } catch (err) {
      const msg = err?.message || String(err);
      const isFlagDisabled = /feature flag|gating model execution/i.test(msg);
      toast(
        isFlagDisabled ? 'Browser model execution flag is disabled — see instructions' : `Download failed: ${msg}`,
        'danger'
      );
      setNanoTone('warning');
      el.nanoActions.hidden = false;
      el.nanoDownloadBtn.hidden = true;
      el.nanoText.textContent = isFlagDisabled
        ? `Disabled by browser flag (${msg}). Enable both flags below and relaunch Chrome, or use another engine.`
        : `Download failed: ${msg}`;
      el.nanoHelp.hidden = false;
    } finally {
      el.nanoDownloadBtn.disabled = false;
      el.nanoCheckBtn.disabled = false;
      el.nanoDownloadBtn.innerHTML = `${icon('cpu', { size: 13 })}<span>Download on-device model</span>`;
    }
  });

  /* --------------------------------------------------------- Navigation */
  const navItems = Array.from(document.querySelectorAll('.pc-nav__item'));
  const sections = navItems
    .map(a => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);

  navItems.forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const target = document.querySelector(a.getAttribute('href'));
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        navItems.forEach(a => {
          a.classList.toggle('is-active', a.getAttribute('href') === `#${entry.target.id}`);
        });
      });
    }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });
    sections.forEach(s => observer.observe(s));
  }

  /* --------------------------------------------------------------- Save */
  el.saveBtn.addEventListener('click', async () => {
    if (el.saveBtn.disabled) return;
    const submitted = getFormState();
    const patch = Object.fromEntries(Object.entries(submitted).filter(([key, value]) => savedSnapshot[key] !== value));
    if (!Object.keys(patch).length) return;

    el.saveBtn.disabled = true;
    el.saveBtn.innerHTML = '<span class="pc-spinner"></span><span>Saving…</span>';
    try {
      const gatewayChanged = ['preferredEngine', 'fallback1Engine', 'fallback2Engine', 'omnirouteEnabled', 'omnirouteBaseUrl']
        .some(key => key in patch);
      const gatewaySelected = [submitted.preferredEngine, submitted.fallback1Engine, submitted.fallback2Engine].includes('omniroute');
      if (gatewayChanged && (gatewaySelected || submitted.omnirouteEnabled || (patch.omnirouteBaseUrl && patch.omnirouteBaseUrl !== PROVIDER_DEFAULTS.omniroute.baseUrl))) {
        const normalized = await ensureOriginPermission(submitted.omnirouteBaseUrl || PROVIDER_DEFAULTS.omniroute.baseUrl);
        if ('omnirouteBaseUrl' in patch) patch.omnirouteBaseUrl = normalized;
      }
      if ('maxHistoryItems' in patch) patch.maxHistoryItems = clampMaxHistory(patch.maxHistoryItems, 20);
      for (const engine of ['gemini', 'openai', 'anthropic', 'openrouter', 'omniroute']) {
        const field = engine + 'Model';
        if (patch[field] === '') patch[field] = PROVIDER_DEFAULTS[engine].model;
      }
      const saved = await writeUserData('saveSettings', patch);
      const current = getFormState();
      for (const [key, control] of Object.entries(getSettingControls())) {
        const value = saved[key];
        savedSnapshot[key] = key === 'maxHistoryItems' ? String(value) : value;
        if (current[key] !== submitted[key]) continue;
        if (control.setValue) control.setValue(value, { silent: true });
        else if (control.type === 'checkbox') control.checked = Boolean(value);
        else control.value = value;
      }
      geminiPreset.syncFromInput();
      openaiPreset.syncFromInput();
      anthropicPreset.syncFromInput();
      omniPreset.syncFromInput();
      refreshOpenRouterOptions();
      refreshFallbackSlots();
      syncDirtyState();
      toast('Settings saved');
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'danger');
    } finally {
      el.saveBtn.disabled = false;
      el.saveBtn.innerHTML = `${icon('save', { size: 14 })}<span>Save changes</span>`;
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && el.modalBackdrop.hidden && libEl.backdrop.hidden) {
      e.preventDefault();
      if (!el.saveBtn.disabled) el.saveBtn.click();
    }
  });

  /* ------------------------------------------------- Connection testing */
  /* One request builder for the real optimizer and the Test buttons, so a green
     Test means the same call will work, and a failure carries the provider's
     own message rather than a bare status code. */
  const KEY_FIELDS = {
    gemini: 'gemini-api-key',
    openai: 'openai-api-key',
    anthropic: 'anthropic-api-key',
    openrouter: 'openrouter-api-key',
    omniroute: 'omniroute-api-key'
  };
  const PROVIDER_NAMES = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    openrouter: 'OpenRouter',
    omniroute: 'OmniRoute'
  };

  document.querySelectorAll('[data-api]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.api;
      try {
        if (provider === 'omniroute') {
          const baseUrl = await ensureOriginPermission(el.omniBaseUrl.value);
          el.omniBaseUrl.value = baseUrl;
          const apiKey = $(KEY_FIELDS.omniroute).value.trim();
          btn.disabled = true;
          btn.innerHTML = `<span class="pc-spinner"></span>`;
          await verifyProvider('omniroute', {
            apiKey,
            baseUrl,
            model: MODEL_FIELDS.omniroute.value.trim()
          });
          if (!el.omniEnabled.checked) {
            el.omniEnabled.checked = true;
            syncDirtyState();
          }
          toast('OmniRoute connection verified');
        } else {
          const apiKey = $(KEY_FIELDS[provider]).value.trim();
          if (!apiKey) throw new Error(`Enter a ${PROVIDER_NAMES[provider]} key first`);
          btn.disabled = true;
          btn.innerHTML = `<span class="pc-spinner"></span>`;
          await verifyProvider(provider, { apiKey, model: MODEL_FIELDS[provider].value.trim() });
          toast(`${PROVIDER_NAMES[provider]} connection verified`);
        }
      } catch (err) {
        toast(err.message, 'danger');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
      }
    });
  });
});
