import {
  getSettings, saveSettings, OPENROUTER_FREE_MODELS, PROVIDER_DEFAULTS,
  PROVIDER_MODEL_PRESETS, clampMaxHistory, normalizeBaseUrl,
  getHistory, removeHistoryEntry, clearHistory
} from '../shared/storage.js';
import { checkBuiltInPromptApiStatus, verifyProvider } from '../shared/optimizer-engine.js';
import { engineOptions, DEFAULT_ENGINE, ENGINE_LABELS } from '../shared/engines.js';
import {
  LIBRARY_KEY, LIMITS, getLibrary, saveToLibrary, updateLibraryEntry, deleteLibraryEntry,
  collectLabels, filterLibrary, normalizeLabels, deriveTitle
} from '../shared/library.js';
import {
  getFrameworks, saveFrameworks, upsertFramework, deleteFramework, resetFrameworksToDefault
} from '../shared/frameworks.js';
import { createSelect, escapeHtml } from '../shared/select.js';
import { createThemePicker, applyTheme, watchTheme, getTheme } from '../shared/theme-picker.js';
import { icon, hydrateIcons, ICON_NAMES, hasIcon } from '../shared/icons.js';

const CUSTOM_MODEL = '__custom__';
const HISTORY_KEY = 'promptcraft_history';
const FRAMEWORKS_KEY = 'promptcraft_frameworks';

document.addEventListener('DOMContentLoaded', async () => {
  hydrateIcons(document);

  const $ = id => document.getElementById(id);

  const el = {
    themeSlot: $('theme-picker-slot'),
    engineSlot: $('preferred-engine-slot'),
    frameworkSlot: $('preferred-framework-slot'),
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
    fwIconSlot: $('fw-icon-slot'),
    fwName: $('fw-name'),
    fwTagline: $('fw-tagline'),
    fwSystemPrompt: $('fw-system-prompt'),
    fwTemplate: $('fw-template'),
    maxHistory: $('max-history'),
    widgetToggle: $('enable-floating-widget'),
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

  /* ----------------------------------------------------------- Dirty state */
  function getFormState() {
    return {
      preferredEngine: engineSelect.getValue(),
      preferredFramework: frameworkSelect.getValue(),
      allowCloudFallback: el.allowCloudFallback.checked,
      geminiApiKey: el.geminiApiKey.value.trim(),
      geminiModel: el.geminiModel.value.trim(),
      openaiApiKey: el.openaiApiKey.value.trim(),
      openaiModel: el.openaiModel.value.trim(),
      anthropicApiKey: el.anthropicApiKey.value.trim(),
      anthropicModel: el.anthropicModel.value.trim(),
      openrouterApiKey: el.orApiKey.value.trim(),
      openrouterModel: el.orModelInput.value.trim(),
      omnirouteEnabled: el.omniEnabled.checked,
      omnirouteBaseUrl: el.omniBaseUrl.value.trim(),
      omnirouteApiKey: el.omniApiKey.value.trim(),
      omnirouteModel: el.omniModelInput.value.trim(),
      customSystemPrompt: el.customPrompt.value.trim(),
      enableFloatingWidget: el.widgetToggle.checked,
      maxHistoryItems: el.maxHistory.value.trim()
    };
  }

  function syncDirtyState() {
    if (savedSnapshot === null) return;
    isDirty = JSON.stringify(getFormState()) !== savedSnapshot;
    el.saveStatus.classList.toggle('is-dirty', isDirty);
    el.saveStatusDot.classList.toggle('pc-status-dot--warning', isDirty);
    el.saveStatusDot.classList.toggle('pc-status-dot--success', !isDirty);
    el.saveStatusText.textContent = isDirty ? 'Unsaved changes' : 'Saved locally';
  }

  function markClean() {
    savedSnapshot = JSON.stringify(getFormState());
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
      await saveSettings({ theme: id });
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
  const engineSelect = createSelect({
    options: engineOptions({ full: true }),
    value: settings.preferredEngine || DEFAULT_ENGINE,
    label: 'Default engine',
    onChange: () => syncDirtyState()
  });
  el.engineSlot.appendChild(engineSelect.element);

  const frameworkSelect = createSelect({
    options: [],
    value: settings.preferredFramework || 'smart-expand',
    label: 'Default framework',
    onChange: () => syncDirtyState()
  });
  el.frameworkSlot.appendChild(frameworkSelect.element);

  /* The icon is chosen from the design-system set rather than typed as an emoji.
     Emoji render at inconsistent optical weight and size across platforms, and
     sit badly beside stroke icons. */
  const fwIconSelect = createSelect({
    options: ICON_NAMES.map(n => ({ value: n, label: n, icon: n })),
    value: 'wand',
    label: 'Framework icon',
    placement: 'up',
    onChange: () => {}
  });
  el.fwIconSlot.appendChild(fwIconSelect.element);

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
  let orRawCatalog = null;
  let orShowAll = false;
  let orFilterQuery = '';
  let orModels = OPENROUTER_FREE_MODELS.slice();

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
        toast('Gateway answered; using default auto routes', 'neutral');
      } else {
        omniPreset.setModels([...PROVIDER_MODEL_PRESETS.omniroute, ...discovered]);
        toast(`Loaded ${discovered.length} OmniRoute route${discovered.length === 1 ? '' : 's'}`);
      }
      if (!el.omniEnabled.checked) {
        el.omniEnabled.checked = true;
      }
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

  const MODEL_FIELDS = {
    gemini: el.geminiModel,
    openai: el.openaiModel,
    anthropic: el.anthropicModel,
    openrouter: el.orModelInput,
    omniroute: el.omniModelInput
  };
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
  el.maxHistory.value = String(clampMaxHistory(settings.maxHistoryItems, 20));

  geminiPreset.syncFromInput();
  openaiPreset.syncFromInput();
  anthropicPreset.syncFromInput();
  omniPreset.syncFromInput();
  refreshOpenRouterOptions();

  el.maxHistory.addEventListener('change', () => {
    el.maxHistory.value = String(clampMaxHistory(el.maxHistory.value, 20));
    syncDirtyState();
  });
  el.maxHistory.addEventListener('blur', () => {
    el.maxHistory.value = String(clampMaxHistory(el.maxHistory.value, 20));
    syncDirtyState();
  });

  const watchedTextInputs = [
    el.orApiKey, el.orModelInput,
    el.omniBaseUrl, el.omniApiKey, el.omniModelInput,
    el.geminiApiKey, el.geminiModel,
    el.openaiApiKey, el.openaiModel,
    el.anthropicApiKey, el.anthropicModel,
    el.customPrompt, el.maxHistory
  ];
  watchedTextInputs.forEach(input => input.addEventListener('input', syncDirtyState));
  [el.allowCloudFallback, el.omniEnabled, el.widgetToggle].forEach(cb => {
    cb.addEventListener('change', syncDirtyState);
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
      icon: hasIcon(fw.icon) ? fw.icon : 'wand'
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
        <span class="pc-framework__glyph">${icon(hasIcon(fw.icon) ? fw.icon : 'wand', { size: 16 })}</span>
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
          if (!confirm(`Delete the "${fw.name}" optimizer type?`)) return;
          await deleteFramework(fw.id);
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
          icon: hasIcon(item.icon) ? item.icon : 'wand',
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
      await saveFrameworks(merged);
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
      fwIconSelect.setValue(hasIcon(fw.icon) ? fw.icon : 'wand', { silent: true });
      el.fwName.value = fw.name || '';
      el.fwTagline.value = fw.tagline || '';
      el.fwSystemPrompt.value = fw.systemPrompt || '';
      el.fwTemplate.value = fw.template || '';
    } else {
      el.modalTitle.textContent = 'New optimizer type';
      el.fwId.value = '';
      fwIconSelect.setValue('wand', { silent: true });
      el.fwName.value = '';
      el.fwTagline.value = '';
      el.fwSystemPrompt.value = '';
      el.fwTemplate.value = '';
    }
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
    if (!confirm('Reset all optimizer types to the factory defaults? Custom edits will be lost.')) return;
    await resetFrameworksToDefault();
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
    const id = el.fwId.value.trim() ||
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') ||
      `custom-${Date.now()}`;

    await upsertFramework({
      id,
      name,
      icon: fwIconSelect.getValue() || 'wand',
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
        <div class="pc-saved__labels">
          ${entry.labels.map(l => `<span class="pc-labelchip">${escapeHtml(l)}</span>`).join('')}
        </div>
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
      card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!confirm(`Delete "${entry.title}" from your library?`)) return;
        await deleteLibraryEntry(entry.id);
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

      for (const item of rawList) {
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
        await saveToLibrary({
          title,
          text,
          original: String(item.original || '').trim(),
          labels: item.labels,
          framework: String(item.framework || ''),
          engine: String(item.engine || '')
        });
        added++;
      }

      if (!added && !skipped) throw new Error('No valid prompts found in file.');
      await refreshLibrary();
      toast(added
        ? `Imported ${added} prompt${added === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}`
        : `No new prompts imported (${skipped} duplicate or invalid)`, added ? 'success' : 'neutral');
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
      if (id) await updateLibraryEntry(id, fields);
      else await saveToLibrary(fields);
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
          await saveToLibrary({
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

      card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!confirm('Delete this history entry?')) return;
        await removeHistoryEntry(entry.id);
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
    if (!confirm('Clear all recorded optimization history from this device?')) return;
    await clearHistory();
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
  async function refreshNanoStatus() {
    try {
      const nano = await checkBuiltInPromptApiStatus();
      if (nano.available) {
        el.nanoBanner.classList.remove('pc-callout--warning');
        el.nanoBanner.classList.add('pc-callout--success');
        el.nanoText.textContent = 'Ready — on-device Gemini Nano is available in this browser.';
        el.nanoActions.hidden = true;
        el.nanoHelp.hidden = true;
      } else if (nano.status === 'downloadable') {
        el.nanoBanner.classList.remove('pc-callout--success');
        el.nanoBanner.classList.add('pc-callout--warning');
        el.nanoText.textContent = 'The on-device model is ready to download. Start the download below, or check the flags if it fails.';
        el.nanoActions.hidden = false;
        el.nanoHelp.hidden = false;
      } else if (nano.status === 'downloading') {
        el.nanoBanner.classList.remove('pc-callout--success');
        el.nanoBanner.classList.add('pc-callout--warning');
        el.nanoText.textContent = 'The on-device model is currently downloading. Check chrome://components, then reload this page.';
        el.nanoActions.hidden = true;
        el.nanoHelp.hidden = false;
      } else {
        el.nanoBanner.classList.remove('pc-callout--success');
        el.nanoBanner.classList.add('pc-callout--warning');
        el.nanoText.textContent = `Unavailable (${nano.status || 'not detected'}). Enable the flags below to use it.`;
        el.nanoActions.hidden = true;
        el.nanoHelp.hidden = false;
      }
    } catch (err) {
      el.nanoActions.hidden = true;
      el.nanoText.textContent = `Could not probe the Prompt API: ${err.message}`;
      el.nanoHelp.hidden = false;
    }
  }
  await refreshNanoStatus();

  el.nanoDownloadBtn.addEventListener('click', async () => {
    const LM = globalThis.LanguageModel;
    if (!LM || typeof LM.create !== 'function') {
      toast('Built-in Prompt API is unavailable in this browser', 'danger');
      return;
    }
    el.nanoDownloadBtn.disabled = true;
    el.nanoDownloadBtn.innerHTML = `<span class="pc-spinner"></span><span>Starting download…</span>`;
    try {
      const session = await LM.create({
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
      toast(`Download failed: ${err.message}`, 'danger');
      await refreshNanoStatus();
    } finally {
      el.nanoDownloadBtn.disabled = false;
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
    const chosenEngine = engineSelect.getValue();
    const rawOmniUrl = el.omniBaseUrl.value.trim();
    const needsOmniPermission = chosenEngine === 'omniroute'
      || el.omniEnabled.checked
      || (Boolean(rawOmniUrl) && normalizeBaseUrl(rawOmniUrl) !== PROVIDER_DEFAULTS.omniroute.baseUrl);

    try {
      if (needsOmniPermission) {
        el.omniBaseUrl.value = await ensureOriginPermission(rawOmniUrl || PROVIDER_DEFAULTS.omniroute.baseUrl);
      } else if (rawOmniUrl && !normalizeBaseUrl(rawOmniUrl)) {
        throw new Error('Enter a valid http:// or https:// OmniRoute Base URL.');
      }
    } catch (err) {
      toast(err.message, 'danger');
      return;
    }

    el.saveBtn.disabled = true;
    el.saveBtn.innerHTML = `<span class="pc-spinner"></span><span>Saving…</span>`;

    try {
      const clampedHistory = clampMaxHistory(el.maxHistory.value, 20);
      const saved = await saveSettings({
        preferredEngine: chosenEngine,
        preferredFramework: frameworkSelect.getValue(),
        allowCloudFallback: el.allowCloudFallback.checked,
        theme,
        geminiApiKey: el.geminiApiKey.value.trim(),
        geminiModel: el.geminiModel.value.trim() || PROVIDER_DEFAULTS.gemini.model,
        openaiApiKey: el.openaiApiKey.value.trim(),
        openaiModel: el.openaiModel.value.trim() || PROVIDER_DEFAULTS.openai.model,
        anthropicApiKey: el.anthropicApiKey.value.trim(),
        anthropicModel: el.anthropicModel.value.trim() || PROVIDER_DEFAULTS.anthropic.model,
        openrouterApiKey: el.orApiKey.value.trim(),
        openrouterModel: el.orModelInput.value.trim() || PROVIDER_DEFAULTS.openrouter.model,
        omnirouteEnabled: el.omniEnabled.checked,
        omnirouteBaseUrl: normalizeBaseUrl(el.omniBaseUrl.value) || PROVIDER_DEFAULTS.omniroute.baseUrl,
        omnirouteApiKey: el.omniApiKey.value.trim(),
        omnirouteModel: el.omniModelInput.value.trim() || PROVIDER_DEFAULTS.omniroute.model,
        customSystemPrompt: el.customPrompt.value.trim(),
        enableFloatingWidget: el.widgetToggle.checked,
        maxHistoryItems: clampedHistory
      });

      el.geminiModel.value = saved.geminiModel;
      el.openaiModel.value = saved.openaiModel;
      el.anthropicModel.value = saved.anthropicModel;
      el.orModelInput.value = saved.openrouterModel;
      el.omniBaseUrl.value = saved.omnirouteBaseUrl;
      el.omniModelInput.value = saved.omnirouteModel;
      el.omniEnabled.checked = Boolean(saved.omnirouteEnabled);
      el.maxHistory.value = String(saved.maxHistoryItems);

      geminiPreset.syncFromInput();
      openaiPreset.syncFromInput();
      anthropicPreset.syncFromInput();
      omniPreset.syncFromInput();
      refreshOpenRouterOptions();
      markClean();
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
