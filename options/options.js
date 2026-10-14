import { getSettings, saveSettings, OPENROUTER_FREE_MODELS, PROVIDER_DEFAULTS } from '../shared/storage.js';
import { checkBuiltInPromptApiStatus, verifyProvider } from '../shared/optimizer-engine.js';
import { engineOptions, DEFAULT_ENGINE, ENGINE_LABELS } from '../shared/engines.js';
import {
  LIBRARY_KEY, getLibrary, saveToLibrary, updateLibraryEntry, deleteLibraryEntry,
  collectLabels, filterLibrary, normalizeLabels
} from '../shared/library.js';
import { getFrameworks, upsertFramework, deleteFramework, resetFrameworksToDefault } from '../shared/frameworks.js';
import { createSelect, escapeHtml } from '../shared/select.js';
import { createThemePicker, applyTheme, watchTheme, getTheme } from '../shared/theme-picker.js';
import { icon, hydrateIcons, ICON_NAMES, hasIcon } from '../shared/icons.js';

const CUSTOM_MODEL = '__custom__';

document.addEventListener('DOMContentLoaded', async () => {
  hydrateIcons(document);

  const $ = id => document.getElementById(id);

  const el = {
    themeSlot: $('theme-picker-slot'),
    engineSlot: $('preferred-engine-slot'),
    frameworkSlot: $('preferred-framework-slot'),
    orModelSlot: $('openrouter-model-slot'),
    orModelInput: $('openrouter-model'),
    fetchModelsBtn: $('fetch-openrouter-free-models-btn'),
    saveBtn: $('save-btn'),
    toast: $('toast'),
    nanoText: $('nano-status-text'),
    nanoHelp: $('nano-instructions'),
    nanoBanner: $('nano-status-banner'),
    frameworksList: $('frameworks-list'),
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
    customPrompt: $('custom-system-prompt')
  };

  const settings = await getSettings();
  let theme = settings.theme || 'dark';
  let frameworkOptions = [];

  /* ---------------------------------------------------------------- Toast */
  let toastTimer;
  function toast(msg, tone = 'success') {
    const toneIcon = { success: 'check', danger: 'alert', neutral: 'info' }[tone] || 'info';
    el.toast.innerHTML = `${icon(toneIcon, { size: 13 })}<span>${escapeHtml(msg)}</span>`;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2600);
  }

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
    onChange: () => {}
  });
  el.engineSlot.appendChild(engineSelect.element);

  const frameworkSelect = createSelect({
    options: [],
    value: settings.preferredFramework || 'smart-expand',
    label: 'Default framework',
    onChange: () => {}
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

  let orModels = OPENROUTER_FREE_MODELS.slice();

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
      }
    }
  });
  el.orModelSlot.appendChild(orModelSelect.element);

  el.orModelInput.addEventListener('input', () => {
    const match = orModels.some(m => m.id === el.orModelInput.value);
    const want = match ? el.orModelInput.value : CUSTOM_MODEL;
    if (orModelSelect.getValue() !== want) orModelSelect.setValue(want, { silent: true });
  });

  el.fetchModelsBtn.addEventListener('click', async () => {
    const btn = el.fetchModelsBtn;
    btn.disabled = true;
    btn.innerHTML = `<span class="pc-spinner"></span> Fetching…`;
    try {
      const key = $('openrouter-api-key').value.trim();
      const headers = key ? { Authorization: `Bearer ${key}` } : {};
      const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const free = (data.data || [])
        .filter(m => m.id.endsWith(':free') || m.id === 'openrouter/free' ||
                     (m.pricing && m.pricing.prompt === '0' && m.pricing.completion === '0'))
        .map(m => ({ id: m.id, name: m.name }));

      if (!free.length) throw new Error('No free models returned');

      orModels = free;
      orModelSelect.setOptions(buildOrOptions(free));
      if (orModelSelect.getValue() !== CUSTOM_MODEL) {
        orModelSelect.setValue(orModelSelect.getValue(), { silent: true });
      }
      toast(`Loaded ${free.length} free models`);
    } catch (err) {
      toast(`Fetch failed: ${err.message}`, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('refresh', { size: 12 })} Fetch live models`;
    }
  });

  /* ------------------------------------------------------------ Populate */
  const preferredEngine = settings.preferredEngine || DEFAULT_ENGINE;
  engineSelect.setValue(preferredEngine, { silent: true });

  const MODEL_FIELDS = {
    gemini: $('gemini-model'),
    openai: $('openai-model'),
    anthropic: $('anthropic-model'),
    openrouter: el.orModelInput
  };
  for (const [provider, input] of Object.entries(MODEL_FIELDS)) {
    input.placeholder = PROVIDER_DEFAULTS[provider].model;
    input.value = settings[`${provider}Model`] || PROVIDER_DEFAULTS[provider].model;
  }

  $('gemini-api-key').value = settings.geminiApiKey || '';
  $('openai-api-key').value = settings.openaiApiKey || '';
  $('anthropic-api-key').value = settings.anthropicApiKey || '';
  $('openrouter-api-key').value = settings.openrouterApiKey || '';
  el.customPrompt.value = settings.customSystemPrompt || '';
  el.widgetToggle.checked = settings.enableFloatingWidget !== false;
  el.maxHistory.value = settings.maxHistoryItems || 20;

  /* ---------------------------------------------------------- Frameworks */
  async function refreshFrameworks() {
    const frameworks = await getFrameworks();
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
        });
      }

      el.frameworksList.appendChild(card);
    });
  }

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
  });

  await refreshFrameworks();

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
    renderLibrary();
  }

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

  // A prompt saved from the popup or the in-page modal appears here without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LIBRARY_KEY]) refreshLibrary();
  });

  await refreshLibrary();

  /* ------------------------------------------------------- Nano status */
  try {
    const nano = await checkBuiltInPromptApiStatus();
    if (nano.available) {
      el.nanoBanner.classList.remove('pc-callout--warning');
      el.nanoBanner.classList.add('pc-callout--success');
      el.nanoText.textContent = 'Ready — on-device Gemini Nano is available in this browser.';
      el.nanoHelp.hidden = true;
    } else if (nano.status === 'downloadable' || nano.status === 'downloading') {
      el.nanoText.textContent = nano.status === 'downloading'
        ? 'The on-device model is still downloading. Check chrome://components, then reload this page.'
        : 'The on-device model is not downloaded yet. Use the steps below to fetch it, then reload this page.';
      el.nanoHelp.hidden = false;
    } else {
      el.nanoText.textContent = `Unavailable (${nano.status || 'not detected'}). Enable the flags below to use it.`;
      el.nanoHelp.hidden = false;
    }
  } catch (err) {
    el.nanoText.textContent = `Could not probe the Prompt API: ${err.message}`;
    el.nanoHelp.hidden = false;
  }

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
    el.saveBtn.disabled = true;
    el.saveBtn.innerHTML = `<span class="pc-spinner"></span><span>Saving…</span>`;

    try {
      await saveSettings({
        preferredEngine: engineSelect.getValue(),
        preferredFramework: frameworkSelect.getValue(),
        theme,
        geminiApiKey: $('gemini-api-key').value.trim(),
        geminiModel: $('gemini-model').value.trim(),
        openaiApiKey: $('openai-api-key').value.trim(),
        openaiModel: $('openai-model').value.trim(),
        anthropicApiKey: $('anthropic-api-key').value.trim(),
        anthropicModel: $('anthropic-model').value.trim(),
        openrouterApiKey: $('openrouter-api-key').value.trim(),
        openrouterModel: el.orModelInput.value.trim(),
        customSystemPrompt: el.customPrompt.value.trim(),
        enableFloatingWidget: el.widgetToggle.checked,
        maxHistoryItems: parseInt(el.maxHistory.value, 10) || 20
      });
      toast('Settings saved');
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'danger');
    } finally {
      el.saveBtn.disabled = false;
      el.saveBtn.innerHTML = `${icon('save', { size: 14 })}<span>Save changes</span>`;
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
    openrouter: 'openrouter-api-key'
  };
  const PROVIDER_NAMES = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter' };

  document.querySelectorAll('[data-api]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.api;
      try {
        const apiKey = $(KEY_FIELDS[provider]).value.trim();
        if (!apiKey) throw new Error(`Enter a ${PROVIDER_NAMES[provider]} key first`);
        btn.disabled = true;
        btn.innerHTML = `<span class="pc-spinner"></span>`;
        await verifyProvider(provider, { apiKey, model: MODEL_FIELDS[provider].value.trim() });
        toast(`${PROVIDER_NAMES[provider]} connection verified`);
      } catch (err) {
        toast(err.message, 'danger');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
      }
    });
  });
});
