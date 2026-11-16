/**
 * PromptOptimizer In-Page Content Script
 *
 * Injects a floating quick-enhance star button and a Shadow DOM optimizer modal
 * into AI chat platforms (ChatGPT, Claude, Gemini, Perplexity, …).
 *
 * Styling comes from the shared design system (shared/theme.css, base.css,
 * components.css) so the in-page surface is visually identical to the popup and
 * the options console.
 */

(() => {
  if (window.__promptcraft_loaded) return;
  window.__promptcraft_loaded = true;
  if (!document.body) return; // XML documents and similar have nothing to attach to

  const SHARED = chrome.runtime.getURL('shared/');
  const LOGO_URL = chrome.runtime.getURL('assets/logo.png');

  /* The service worker injects this script on demand (context menu, keyboard
     command) and messages it immediately, before the UI below has finished
     loading. Register the listener synchronously and queue the request. */
  let handleOpen = null;
  let queuedOpen = null;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'OPEN_OPTIMIZER_MODAL') return;
    if (handleOpen) handleOpen(message.payload || {});
    else queuedOpen = message.payload || {};
  });

  const FALLBACK_FRAMEWORKS = [
    { id: 'smart-expand', name: 'Smart Expand', icon: 'wand' },
    { id: 'rtf', name: 'RTF', icon: 'ruler' },
    { id: 'create', name: 'CREATE', icon: 'layers' },
    { id: 'chain-of-thought', name: 'Reasoning', icon: 'brain' },
    { id: 'concise', name: 'Concise', icon: 'minimize' }
  ];

  /* Surface-specific layout only — all color comes from tokens. */
  const SURFACE_CSS = `
    /* Isolates the widget from host-page typography. Shadow DOM blocks
       page selectors, but inherited properties still cascade from the host. */
    .pc-root {
      font-family: var(--font-sans);
      font-size: var(--text-base);
      line-height: var(--leading-normal);
      color: var(--text-primary);
      letter-spacing: var(--tracking-normal);
      -webkit-font-smoothing: antialiased;
    }
    .pc-root *, .pc-root *::before, .pc-root *::after { box-sizing: border-box; }

    .pc-star-btn {
      position: fixed;
      pointer-events: auto;
      display: none;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
      background: var(--bg-raised);
      color: var(--accent-fg);
      border: 1px solid var(--accent-border);
      border-radius: var(--radius-full);
      box-shadow: var(--shadow-2);
      cursor: pointer;
      user-select: none;
      z-index: 2147483646;
      transition:
        background-color var(--dur-fast) var(--ease-standard),
        border-color var(--dur-fast) var(--ease-standard),
        color var(--dur-fast) var(--ease-standard),
        transform var(--dur-fast) var(--ease-standard),
        box-shadow var(--dur-fast) var(--ease-standard);
    }
    .pc-star-btn:hover {
      background: var(--accent-soft);
      border-color: var(--accent);
      transform: translateY(-1px) scale(1.04);
      box-shadow: var(--shadow-accent);
    }
    .pc-star-btn:active { transform: translateY(0) scale(0.98); }
    .pc-star-btn:focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }
    .pc-star-btn.is-busy {
      background: var(--accent-soft);
      border-color: var(--accent);
      box-shadow: var(--shadow-accent);
    }
    .pc-star-btn.is-busy .pc-spinner {
      width: 15px;
      height: 15px;
    }
    .pc-star-btn.is-busy svg {
      animation: pc-star-pulse 1.1s var(--ease-standard) infinite;
    }
    .pc-star-btn.is-revert {
      background: var(--success-soft);
      border-color: var(--success);
      color: var(--success-fg);
    }
    .pc-star-btn.is-revert:hover {
      background: var(--success-soft);
      border-color: var(--success);
      color: var(--success-fg);
      box-shadow: var(--shadow-2);
    }
    @keyframes pc-star-pulse {
      0%, 100% { transform: scale(1) rotate(0deg); opacity: 1; }
      50% { transform: scale(0.84) rotate(22deg); opacity: 0.65; }
    }

    .pc-toast { z-index: 2147483647; }
    .pc-toast.has-action { pointer-events: auto; }
    .pc-toast__action {
      margin-left: var(--space-1);
      padding: 2px var(--space-2);
      border-radius: var(--radius-full);
      border: 1px solid var(--accent-border);
      background: var(--accent-soft);
      color: var(--accent-fg);
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      cursor: pointer;
      transition: background-color var(--dur-fast) var(--ease-standard);
    }
    .pc-toast__action:hover { background: var(--accent-soft-hover); }

    .pc-backdrop {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      display: none;
      align-items: center;
      justify-content: center;
      padding: var(--space-6);
      z-index: 2147483647;
      background: var(--bg-overlay);
    }
    .pc-backdrop.is-open { display: flex; }

    .pc-modal {
      display: flex;
      flex-direction: column;
      width: 640px;
      max-width: 100%;
      /* A definite height, so the output box can fill down to the footer instead
         of stopping at whatever height its text happens to need. */
      height: min(720px, calc(100vh - var(--space-10)));
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-3);
      overflow: hidden;
      animation: pc-modal-in var(--dur-base) var(--ease-decelerate);
    }

    .pc-modal__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      flex-shrink: 0;
      height: 52px;
      padding: 0 var(--space-4) 0 var(--space-5);
      border-bottom: 1px solid var(--border-subtle);
    }

    .pc-modal__brand { display: flex; align-items: center; gap: var(--space-3); }

    .pc-modal__logo {
      display: block;
      height: 26px;
      width: auto;
      filter: var(--logo-filter);
    }

    .pc-modal__title-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .pc-modal__title {
      font-size: var(--text-md);
      font-weight: var(--weight-semibold);
      letter-spacing: var(--tracking-tight);
      color: var(--text-primary);
    }

    .pc-modal__subtitle {
      display: block;
      font-size: var(--text-xs);
      color: var(--text-tertiary);
      font-weight: var(--weight-normal);
    }

    .pc-modal__actions { display: flex; align-items: center; gap: var(--space-2); }
    .pc-modal__theme .pc-select__trigger { height: 28px; font-size: var(--text-xs); }
    .pc-modal__theme .pc-swatch { width: 14px; height: 14px; }

    .pc-modal__tabs {
      flex-shrink: 0;
      padding: var(--space-3) var(--space-5);
      background: var(--bg-canvas);
      border-bottom: 1px solid var(--border-subtle);
    }
    .pc-modal__tabs .pc-segmented { width: 100%; }

    .pc-modal__body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      padding: var(--space-5);
    }

    .pc-modal__controls { display: flex; align-items: stretch; gap: var(--space-2); }
    .pc-modal__controls .pc-select { flex: 1; min-width: 0; }
    .pc-modal__controls .pc-btn { flex-shrink: 0; }

    /* Callout inner stack — components.css owns the frame itself. */
    .pc-callout__body {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-1);
      min-width: 0;
    }
    .pc-callout__text {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      line-height: var(--leading-normal);
      overflow-wrap: anywhere;
    }

    /* The output box shows the whole result and runs down the modal; the body
       scrolls to reach the end of it. It used to stop at a fixed 240px. */
    .pc-modal__output { flex: 1 1 auto; }

    /* Holds the save sheet only; as contents it adds no gap while the sheet is closed. */
    #pc-save-slot { display: contents; }

    .pc-modal__outbox {
      flex: 1 0 auto;
      min-height: 140px;
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-3);
    }

    .pc-modal__outtext {
      font-size: var(--text-sm);
      line-height: var(--leading-relaxed);
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .pc-modal__footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      flex-shrink: 0;
      padding: var(--space-3) var(--space-5);
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-canvas);
    }

    .pc-modal__status {
      display: flex; align-items: center; gap: var(--space-2);
      font-size: var(--text-xs); color: var(--text-secondary);
      min-width: 0;
    }

    .pc-modal__footer-actions { display: flex; align-items: center; gap: var(--space-2); }

    .pc-meter {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    .pc-native-select {
      height: 34px;
      padding: 0 var(--space-3);
      background: var(--bg-sunken);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: var(--text-sm);
      appearance: none;
      -webkit-appearance: none;
      cursor: pointer;
    }

    @media (prefers-reduced-motion: reduce) {
      .pc-modal { animation: none; }
      .pc-star-btn.is-busy svg,
      .pc-star-btn.is-busy .pc-spinner { animation: none; }
    }
  `;

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                           */
  /* ------------------------------------------------------------------ */

  const host = document.createElement('div');
  host.id = 'promptcraft-root-host';
  const shadow = host.attachShadow({ mode: 'open' });

  let currentTargetElement = null;
  let isModalOpen = false;

  async function loadSharedCss() {
    const names = ['theme.css', 'base.css', 'components.css'];
    const parts = await Promise.all(
      names.map(n => fetch(SHARED + n).then(r => {
        if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
        return r.text();
      }))
    );
    return parts.join('\n');
  }

  async function loadModules() {
    try {
      const [icons, select, themePicker, engines, saveSheet, library, runClient, assist, secrets, clarify, scorer, targetProfiles] = await Promise.all([
        import(SHARED + 'icons.js'),
        import(SHARED + 'select.js'),
        import(SHARED + 'theme-picker.js'),
        import(SHARED + 'engines.js'),
        import(SHARED + 'save-sheet.js'),
        import(SHARED + 'library.js'),
        import(SHARED + 'run-client.js'),
        import(SHARED + 'assist.js'),
        import(SHARED + 'secrets.js'),
        import(SHARED + 'clarify.js'),
        import(SHARED + 'scorer.js'),
        import(SHARED + 'target-profiles.js')
      ]);
      return { icons, select, themePicker, engines, saveSheet, library, runClient, assist, secrets, clarify, scorer, targetProfiles };
    } catch (err) {
      console.warn('[PromptOptimizer] enhanced controls unavailable, falling back:', err);
      return null;
    }
  }

  init();

  async function init() {
    let css = '';
    try {
      css = await loadSharedCss();
    } catch (err) {
      console.warn('[PromptOptimizer] could not load shared stylesheet:', err);
    }

    const styleEl = document.createElement('style');
    styleEl.textContent = css + '\n' + SURFACE_CSS;
    shadow.appendChild(styleEl);

    const root = document.createElement('div');
    root.className = 'pc-root';
    root.setAttribute('data-theme', 'dark');
    root.innerHTML = TEMPLATE;
    shadow.appendChild(root);

    document.body.appendChild(host);

    const ds = await loadModules();
    wire({ root, ds });
  }

  /* SPAs sometimes replace the whole body; put the host back if that happens. */
  function ensureHost() {
    if (!host.isConnected && document.body) document.body.appendChild(host);
  }

  const TEMPLATE = `
    <button type="button" class="pc-star-btn" id="pc-star-btn" data-state="idle"
            aria-label="Auto-enhance prompt" title="Auto-enhance draft using your preconfigured setup (Alt+click to fix typos only)">
      <span data-icon="star" data-icon-size="15"></span>
    </button>

    <div class="pc-backdrop" id="pc-backdrop">
      <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-modal-title">
        <header class="pc-modal__header">
          <div class="pc-modal__brand">
            <img class="pc-modal__logo" src="${LOGO_URL}" alt="">
            <div>
              <div class="pc-modal__title-row">
                <div class="pc-modal__title" id="pc-modal-title">PromptOptimizer</div>
                <span class="pc-badge pc-badge--accent pc-badge--mono" id="pc-target-badge" hidden></span>
              </div>
              <span class="pc-modal__subtitle">yourlegalaid</span>
            </div>
          </div>
          <div class="pc-modal__actions">
            <button type="button" class="pc-icon-btn" id="pc-library-btn" aria-pressed="false"
                    title="Saved prompts" aria-label="Saved prompts">
              <span data-icon="bookmark"></span>
            </button>
            <div class="pc-modal__theme" id="pc-theme-slot"></div>
            <button type="button" class="pc-icon-btn" id="pc-close-btn" aria-label="Close">
              <span data-icon="close"></span>
            </button>
          </div>
        </header>

        <div class="pc-modal__tabs">
          <div class="pc-segmented" id="pc-tabs" role="tablist" aria-label="Optimizer framework"></div>
        </div>

        <div class="pc-modal__body">
          <div id="pc-library-slot"></div>
          <div class="pc-field">
            <div class="pc-field__row">
              <span class="pc-label">Raw prompt</span>
              <span class="pc-meter" id="pc-char-count">0</span>
            </div>
            <textarea id="pc-raw-input" class="pc-textarea" rows="4"
              placeholder="Type or paste the prompt you want to elevate…"></textarea>
          </div>

          <div class="pc-assist-row" id="pc-assist-row">
            <label class="pc-switch pc-context-toggle" title="Adds this page's title, address and selected text to the request, so the rewrite can be specific to it">
              <input type="checkbox" id="pc-context-toggle">
              <span class="pc-switch__track"><span class="pc-switch__thumb"></span></span>
              <span class="pc-switch__label">Use page context</span>
            </label>
            <button type="button" class="pc-btn pc-btn--ghost pc-btn--sm" id="pc-ask-btn"
                    title="Answer up to three questions before the rewrite">
              <span data-icon="brain" data-icon-size="13"></span><span>Ask me first</span>
            </button>
          </div>
          <div id="pc-secret-slot"></div>
          <div id="pc-clarify-slot"></div>

          <div class="pc-modal__controls">
            <div id="pc-engine-slot"></div>
            <div id="pc-variant-slot"></div>
            <button type="button" id="pc-optimize-btn" class="pc-btn pc-btn--primary pc-btn--md"
                    title="Optimize prompt (Ctrl+Enter)">
              <span data-icon="wand" data-icon-size="14"></span>
              <span>Optimize</span>
            </button>
          </div>

          <div class="pc-field pc-modal__output">
            <div class="pc-field__row">
              <span class="pc-label">Optimized prompt</span>
              <span class="pc-badge pc-badge--mono" id="pc-quality-chip" hidden></span>
              <span class="pc-badge pc-badge--accent pc-badge--mono" id="pc-engine-badge" hidden></span>
            </div>
            <div class="pc-callout pc-callout--warning" id="pc-degraded" hidden role="status">
              <span class="pc-callout__icon" data-icon="alert" data-icon-size="15"></span>
              <div class="pc-callout__body">
                <span class="pc-callout__title" id="pc-degraded-title">Offline template used</span>
                <span class="pc-callout__text" id="pc-degraded-reason"></span>
                <button type="button" class="pc-btn pc-btn--secondary pc-btn--sm" id="pc-degraded-settings-btn">
                  <span data-icon="settings" data-icon-size="13"></span><span>Open settings</span>
                </button>
              </div>
            </div>
            <div class="pc-modal__outbox">
              <div class="pc-empty" id="pc-placeholder">
                <span class="pc-empty__icon" data-icon="wand" data-icon-size="16"></span>
                <span class="pc-empty__title">No output yet</span>
                <span class="pc-empty__desc">Choose a framework, then press Optimize.</span>
              </div>
              <div class="pc-loading-state" id="pc-loading-state" hidden role="status" aria-live="polite">
                <span class="pc-spinner"></span>
                <span id="pc-loading-label">Preparing optimization…</span>
              </div>
              <pre class="pc-modal__outtext" id="pc-result-text" hidden></pre>
            </div>
            <div class="pc-variants" id="pc-variant-chips" hidden></div>
            <div id="pc-actions-slot"></div>
            <div class="pc-chips" id="pc-tech-chips" hidden></div>
          </div>

          <div id="pc-save-slot"></div>
        </div>

        <footer class="pc-modal__footer">
          <span class="pc-modal__status">
            <span class="pc-status-dot pc-status-dot--success" id="pc-status-dot"></span>
            <span id="pc-footer-status">Ready</span>
          </span>
          <div class="pc-modal__footer-actions">
            <button type="button" id="pc-save-btn" class="pc-btn pc-btn--secondary pc-btn--sm">
              <span data-icon="bookmark" data-icon-size="13"></span><span>Save</span>
            </button>
            <button type="button" id="pc-copy-btn" class="pc-btn pc-btn--secondary pc-btn--sm">
              <span data-icon="copy" data-icon-size="13"></span><span>Copy</span>
            </button>
            <button type="button" id="pc-insert-btn" class="pc-btn pc-btn--primary pc-btn--sm">
              <span data-icon="insert" data-icon-size="13"></span><span>Insert</span>
            </button>
          </div>
        </footer>
      </div>
    </div>

    <div class="pc-toast" id="pc-toast" role="status" aria-live="polite"></div>
  `;

  /* ------------------------------------------------------------------ */
  /* Wiring                                                             */
  /* ------------------------------------------------------------------ */

  function wire({ root, ds }) {
    const $ = sel => root.querySelector(sel);

    const starBtn = $('#pc-star-btn');
    const backdrop = $('#pc-backdrop');
    const modal = $('.pc-modal');
    const targetBadge = $('#pc-target-badge');
    const closeBtn = $('#pc-close-btn');
    const tabsContainer = $('#pc-tabs');
    const themeSlot = $('#pc-theme-slot');
    const engineSlot = $('#pc-engine-slot');
    const rawInput = $('#pc-raw-input');
    const charCount = $('#pc-char-count');
    const optimizeBtn = $('#pc-optimize-btn');
    const resultText = $('#pc-result-text');
    const placeholder = $('#pc-placeholder');
    const loadingState = $('#pc-loading-state');
    const loadingLabel = $('#pc-loading-label');
    const engineBadge = $('#pc-engine-badge');
    const degradedNotice = $('#pc-degraded');
    const degradedTitle = $('#pc-degraded-title');
    const degradedReason = $('#pc-degraded-reason');
    const degradedSettingsBtn = $('#pc-degraded-settings-btn');
    const techChips = $('#pc-tech-chips');
    const qualityChip = $('#pc-quality-chip');
    const variantChips = $('#pc-variant-chips');
    const variantSlot = $('#pc-variant-slot');
    const footerStatus = $('#pc-footer-status');
    const statusDot = $('#pc-status-dot');
    const copyBtn = $('#pc-copy-btn');
    const insertBtn = $('#pc-insert-btn');
    const toastEl = $('#pc-toast');
    const saveBtn = $('#pc-save-btn');
    const saveSlot = $('#pc-save-slot');
    const libraryBtn = $('#pc-library-btn');
    const librarySlot = $('#pc-library-slot');
    const assistRow = $('#pc-assist-row');
    const contextToggle = $('#pc-context-toggle');
    const askBtn = $('#pc-ask-btn');
    const secretSlot = $('#pc-secret-slot');
    const clarifySlot = $('#pc-clarify-slot');
    const actionsSlot = $('#pc-actions-slot');

    /* Kept in sync with shared/select.js `escapeHtml`. This copy exists so the
       in-page surface still escapes correctly when the shared modules fail to
       load; everywhere the shared module is available, prefer that one. */
    const escapeHtml = s => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const QUICK_MAX_CHARS = 8000;
    const QUICK_REPAIR_MAX_CHARS = 2000;
    const hasStructuredPromptTokens = s =>
      /(?:^|[\s(])@file:\S+/i.test(s) ||
      /(?:^|[\s(])@[A-Za-z][A-Za-z0-9_.-]*(?:\/[^\s,;:!?)\]]+)*(?=$|[\s.,;:!?)\]])/.test(s) ||
      /(?:^|[\s(])\/[A-Za-z][A-Za-z0-9_:-]{0,31}(?=$|[\s.,;:!?)\]])/.test(s);

    let activeFramework = 'smart-expand';
    let latest = '';
    let busy = false;
    let quickRun = null;
    let quickRunSeq = 0;
    let isQuickWriting = false;
    let quickRepairCached = true;
    let quickEngineCached = null;
    const quickState = {
      mode: 'idle', // 'idle' | 'repairing' | 'enhancing' | 'repaired' | 'enhanced'
      target: null,
      originalBackup: null,
      lastWritten: null,
      hasAppliedStep1: false,
      routeKey: location.href
    };
    const isQuickBusy = () => quickState.mode === 'repairing' || quickState.mode === 'enhancing';
    /* What the result on screen came from, so a saved prompt records it. */
    let lastOriginal = '';
    let lastEngine = '';
    let lastFramework = '';
    /* The full result on screen (null for a saved prompt), and the run in flight. */
    let lastData = null;
    let currentRun = null;
    /* Draft the user chose to send despite the credential warning. */
    let secretAllowedFor = '';

    /* Off until settings have loaded, so a disabled widget never flashes. */
    let widgetEnabled = false;
    let returnFocusTo = null;
    let lastContextTarget = null;

    const ENGINE_LABELS = ds?.engines?.ENGINE_LABELS || {};
    const DEFAULT_ENGINE = ds?.engines?.DEFAULT_ENGINE || 'nano';

    const FALLBACK_PROFILES = [
      { id: 'claude', name: 'Claude', hosts: ['claude.ai'] },
      { id: 'openai', name: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'] },
      { id: 'gemini', name: 'Gemini', hosts: ['gemini.google.com', 'aistudio.google.com'] },
      { id: 'perplexity', name: 'Perplexity', hosts: ['perplexity.ai'] },
      { id: 'deepseek', name: 'DeepSeek', hosts: ['chat.deepseek.com'] },
      { id: 'grok', name: 'Grok', hosts: ['grok.com'] },
      { id: 'copilot', name: 'Copilot', hosts: ['copilot.microsoft.com'] },
      { id: 'mistral', name: 'Mistral', hosts: ['chat.mistral.ai'] }
    ];

    function resolveSiteProfile() {
      if (ds?.targetProfiles?.getTargetProfile) {
        return ds.targetProfiles.getTargetProfile(location.hostname);
      }
      const cleanHost = String(location.hostname || '').trim().toLowerCase().replace(/^www\./, '');
      return FALLBACK_PROFILES.find(p => p.hosts.some(h => cleanHost === h || cleanHost.endsWith('.' + h))) || null;
    }

    function refreshPlatformIdentity() {
      const profile = resolveSiteProfile();
      if (profile) {
        targetBadge.textContent = `For ${profile.name}`;
        targetBadge.title = `Recognized ${profile.name} (${location.hostname}) — enhancements are tailored for this AI`;
        targetBadge.hidden = false;
      } else {
        targetBadge.hidden = true;
        targetBadge.textContent = '';
        targetBadge.title = '';
      }
      if (!isQuickBusy() && quickState.mode === 'idle') {
        const label = profile
          ? `Auto-enhance draft for ${profile.name} using your preconfigured setup (Alt+click to fix typos only)`
          : 'Auto-enhance draft using your preconfigured setup (Alt+click to fix typos only)';
        starBtn.title = label;
        starBtn.setAttribute('aria-label', label);
      }
      return profile;
    }

    /* Fields the floating star button and modal may attach to or read from.
       Anything that can hold a credential is excluded: the modal copies a
       field's value into a box that can be sent to a cloud engine. */
    const SENSITIVE_HINT = /(^|[^a-z])(pass(word|wd)?|otp|cvv|cvc|ccnum|ssn)([^a-z]|$)/i;
    const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\s|$)/i;
    const FIELD_SELECTOR = 'textarea, input, [contenteditable]:not([contenteditable="false"])';

    function getDeepActiveElement() {
      let active = document.activeElement;
      while (active && active !== host && active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    }

    function getDeepEventTarget(e) {
      const path = typeof e?.composedPath === 'function' ? e.composedPath() : null;
      return (path && path.length > 0 ? path[0] : null) || e?.target || null;
    }

    function isEligibleField(el) {
      if (!el || el.nodeType !== 1 || el === host || host.contains(el) || el.getRootNode?.() === shadow) return false;
      if (el.disabled || el.readOnly) return false;

      const auto = el.getAttribute('autocomplete') || '';
      if (SENSITIVE_AUTOCOMPLETE.test(auto)) return false;
      if (SENSITIVE_HINT.test(`${el.name || ''} ${el.id || ''}`)) return false;

      if (el.tagName === 'TEXTAREA') return true;
      if (el.tagName === 'INPUT') return (el.getAttribute('type') || 'text').toLowerCase() === 'text';
      return el.isContentEditable === true;
    }

    /** The eligible field a node belongs to, or null. */
    function fieldFrom(node) {
      const el = node instanceof Element ? node.closest(FIELD_SELECTOR) : null;
      return isEligibleField(el) ? el : null;
    }

    /** A field of any kind, eligible or not — used to avoid guessing past a sensitive one. */
    function isFieldLike(el) {
      return el instanceof Element && el.matches(FIELD_SELECTOR);
    }

    /* Icons ------------------------------------------------------------ */
    if (ds?.icons) {
      ds.icons.hydrateIcons(root);
    } else {
      // No module: strip the placeholders so no raw text leaks into the UI.
      root.querySelectorAll('[data-icon]').forEach(el => el.remove());
      optimizeBtn.querySelector('span:last-child').textContent = 'Optimize';
      if (starBtn && !starBtn.querySelector('svg')) starBtn.textContent = '★';
    }

    const ICON = (name, size = 14) => (ds?.icons ? ds.icons.icon(name, { size }) : '');

    /* Toast ------------------------------------------------------------ */
    let toastTimer;
    function toast(msg, tone = 'neutral', { actionLabel = '', onAction = null, duration = 2400 } = {}) {
      const glyph = { success: 'check', danger: 'alert', neutral: 'info' }[tone] || 'info';
      toastEl.innerHTML = `${ICON(glyph, 13)}<span>${escapeHtml(msg)}</span>`;
      if (actionLabel && typeof onAction === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pc-toast__action';
        btn.textContent = actionLabel;
        btn.addEventListener('mousedown', ev => ev.preventDefault());
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          clearTimeout(toastTimer);
          toastEl.classList.remove('is-visible', 'has-action');
          onAction();
        });
        toastEl.appendChild(btn);
        toastEl.classList.add('has-action');
      } else {
        toastEl.classList.remove('has-action');
      }
      toastEl.classList.add('is-visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl.classList.remove('is-visible', 'has-action');
      }, duration);
    }

    function setStatus(text, tone = 'neutral') {
      footerStatus.textContent = text;
      statusDot.className = 'pc-status-dot' +
        (tone === 'success' ? ' pc-status-dot--success'
          : tone === 'warning' ? ' pc-status-dot--warning'
            : tone === 'danger' ? ' pc-status-dot--danger' : '');
    }

    /* Theme ------------------------------------------------------------ */
    let theme = 'dark';
    let themeMenu = null;

    /* The in-page surface has no :root to fall back on, so a stale or retired
       stored id must resolve to a real design before it reaches the DOM. The
       list of designs lives in theme-picker.js; if that module could not be
       loaded only dark and light are known here. */
    const normalizeTheme = id => ds?.themePicker
      ? ds.themePicker.migrateTheme(id)
      : (id === 'light' ? 'light' : 'dark');

    if (ds?.themePicker) {
      themeMenu = ds.themePicker.createThemeMenu({
        value: theme,
        onChange: async id => {
          theme = id;
          applyThemeTo(root, id);
          await saveTheme(id);
          toast(`${ds.themePicker.getTheme(id).name} design`, 'success');
        }
      });
      themeSlot.appendChild(themeMenu.element);
    } else {
      // No module available — a plain labelled button, so the control is still
      // reachable rather than rendering as an empty square.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pc-btn pc-btn--secondary pc-btn--sm';
      const label = () => { btn.textContent = theme === 'dark' ? 'Light' : 'Dark'; };
      btn.addEventListener('click', async () => {
        theme = theme === 'dark' ? 'light' : 'dark';
        applyThemeTo(root, theme);
        label();
        await saveTheme(theme);
        toast('Theme applied', 'success');
      });
      themeSlot.appendChild(btn);
      label();
    }

    function applyThemeTo(el, id) {
      el.setAttribute('data-theme', normalizeTheme(id));
    }

    function setTheme(id) {
      theme = normalizeTheme(id);
      applyThemeTo(root, theme);
      if (themeMenu) themeMenu.setValue(theme, { silent: true });
    }

    /* Engine ----------------------------------------------------------- */
    let engineSelect = null;
    let nativeEngine = null;
    let engine = DEFAULT_ENGINE;

    /* The engine list comes from shared/engines.js. If the shared modules could
       not be loaded there is no list to offer, so the control is omitted and the
       engine chosen in Options is used as-is. */
    const engineList = ds?.engines?.engineOptions() || [];

    if (ds?.select && engineList.length) {
      engineSelect = ds.select.createSelect({
        options: engineList,
        value: engine,
        placement: 'up',
        label: 'Engine',
        /* Persisted through the service worker (SET_ENGINE), like the design:
           a page never writes settings directly. The engine picked here is the
           one the popup and every other page use. */
        onChange: v => {
          engine = v;
          Promise.resolve(chrome.runtime.sendMessage({ type: 'SET_ENGINE', payload: { engine: v } }))
            .catch(err => console.warn('[PromptOptimizer] could not persist the engine:', err));
        }
      });
      engineSlot.appendChild(engineSelect.element);
    } else if (engineList.length) {
      const sel = document.createElement('select');
      sel.className = 'pc-native-select';
      sel.style.width = '100%';
      sel.innerHTML = engineList
        .map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)} · ${escapeHtml(o.desc)}</option>`).join('');
      sel.addEventListener('change', () => {
        engine = sel.value;
        Promise.resolve(chrome.runtime.sendMessage({ type: 'SET_ENGINE', payload: { engine } }))
          .catch(err => console.warn('[PromptOptimizer] could not persist the engine:', err));
      });
      engineSlot.appendChild(sel);
      nativeEngine = sel;
    }

    function setEngine(v) {
      if (!v || (engineList.length && !engineList.some(o => o.value === v))) return;
      engine = v;
      if (engineSelect) engineSelect.setValue(v, { silent: true });
      if (nativeEngine) nativeEngine.value = v;
    }

    /* Variants ---------------------------------------------------------- */
    /* How many alternative rewrites each optimization produces. Persisted
       through the service worker (SET_VARIANTS), like the design: a page never
       writes settings directly. */
    let variantSelect = null;
    let variantCount = 1;
    let currentVariants = [];

    function setVariantCount(n) {
      variantCount = Math.max(1, Math.min(3, parseInt(n, 10) || 1));
      if (variantSelect) variantSelect.setValue(String(variantCount), { silent: true });
    }

    if (ds?.select) {
      variantSelect = ds.select.createSelect({
        options: [
          { value: '1', label: 'Single' },
          { value: '2', label: 'Two' },
          { value: '3', label: 'Three' }
        ],
        value: '1',
        placement: 'up',
        label: 'Rewrite variants',
        onChange: v => {
          variantCount = parseInt(v, 10) || 1;
          Promise.resolve(chrome.runtime.sendMessage({ type: 'SET_VARIANTS', payload: { count: variantCount } }))
            .catch(err => console.warn('[PromptOptimizer] could not persist variants:', err));
        }
      });
      variantSlot.appendChild(variantSelect.element);
    }

    /* Storage helpers -------------------------------------------------- */
    async function getSettings() {
      try {
        const stored = await chrome.storage.local.get('promptcraft_settings');
        return stored.promptcraft_settings || {};
      } catch {
        return {};
      }
    }

    async function getFrameworksList() {
      try {
        const stored = await chrome.storage.local.get('promptcraft_frameworks');
        if (Array.isArray(stored.promptcraft_frameworks) && stored.promptcraft_frameworks.length) {
          return stored.promptcraft_frameworks;
        }
      } catch {}
      return FALLBACK_FRAMEWORKS;
    }

    /* Only the design is written from a page. The service worker owns the write,
       so a page never rewrites the whole settings object (API keys included). */
    async function saveTheme(id) {
      try {
        await chrome.runtime.sendMessage({ type: 'SET_THEME', payload: { theme: id } });
      } catch (err) {
        console.warn('[PromptOptimizer] could not persist the design:', err);
      }
    }

    /* Frameworks ------------------------------------------------------- */
    async function renderFrameworkTabs(preloaded) {
      let frameworks = FALLBACK_FRAMEWORKS;
      let settings = {};
      if (preloaded) {
        if (Array.isArray(preloaded.frameworks) && preloaded.frameworks.length) {
          frameworks = preloaded.frameworks;
        }
        settings = preloaded.settings || {};
      } else {
        try {
          const stored = await chrome.storage.local.get(['promptcraft_frameworks', 'promptcraft_settings']);
          if (Array.isArray(stored.promptcraft_frameworks) && stored.promptcraft_frameworks.length) {
            frameworks = stored.promptcraft_frameworks;
          }
          settings = stored.promptcraft_settings || {};
        } catch {}
      }

      if (!frameworks.some(f => f.id === activeFramework)) {
        activeFramework = settings.preferredFramework || frameworks[0]?.id || 'smart-expand';
      }
      if (!frameworks.some(f => f.id === activeFramework)) {
        activeFramework = frameworks[0]?.id;
      }

      tabsContainer.innerHTML = '';
      frameworks.forEach(fw => {
        const selected = fw.id === activeFramework;
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'pc-segmented__item';
        tab.setAttribute('role', 'tab');
        tab.dataset.framework = fw.id;
        tab.setAttribute('aria-selected', String(selected));
        tab.setAttribute('tabindex', selected ? '0' : '-1');
        tab.title = fw.tagline || fw.name;
        tab.innerHTML =
          `<span class="pc-segmented__icon">${ICON(fw.icon, 13)}</span>` +
          `<span>${escapeHtml(fw.name)}</span>`;
        tabsContainer.appendChild(tab);
      });
    }

    function selectFrameworkTab(id, { focus = false } = {}) {
      const tabs = [...tabsContainer.querySelectorAll('.pc-segmented__item')];
      const target = tabs.find(t => t.dataset.framework === id);
      if (!target) return;
      tabs.forEach(t => {
        const selected = t === target;
        t.setAttribute('aria-selected', String(selected));
        t.setAttribute('tabindex', selected ? '0' : '-1');
      });
      activeFramework = id;
      if (focus) target.focus();
      if (!busy && latest && lastFramework && activeFramework !== lastFramework) {
        setStatus(`Switched to ${target.textContent.trim()} — click Optimize to rewrite`, 'neutral');
      }
    }

    tabsContainer.addEventListener('click', e => {
      const tab = e.target.closest('.pc-segmented__item');
      if (tab) selectFrameworkTab(tab.dataset.framework);
    });

    tabsContainer.addEventListener('keydown', e => {
      const tabs = [...tabsContainer.querySelectorAll('.pc-segmented__item')];
      if (!tabs.length) return;
      const idx = tabs.indexOf(shadow.activeElement);
      if (idx === -1) return;
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabs.length - 1;
      if (nextIdx === -1) return;
      e.preventDefault();
      selectFrameworkTab(tabs[nextIdx].dataset.framework, { focus: true });
    });

    /* Open / close ----------------------------------------------------- */
    let insertCloseTimer = null;
    let waitTimer = null;

    function stopWaitTimer() {
      clearInterval(waitTimer);
      waitTimer = null;
      loadingState.hidden = true;
    }

    function startWaitTimer(label, tone = 'neutral') {
      stopWaitTimer();
      let sec = 0;
      loadingLabel.textContent = label;
      loadingState.hidden = false;
      waitTimer = setInterval(() => {
        sec += 1;
        const text = `${label} (${sec}s)`;
        loadingLabel.textContent = text;
        if (busy) setStatus(text, tone);
      }, 1000);
    }

    async function openModal(initialText = '', autoRun = false, { fromContextMenu = false } = {}) {
      // Capture where focus was before the modal takes it, to hand it back on close.
      const active = getDeepActiveElement();
      returnFocusTo = (isFieldLike(active) ? active : null) || currentTargetElement || active;

      if (isQuickBusy()) {
        cancelQuickRun({ preserveRevert: Boolean(quickState.hasAppliedStep1) });
      }
      isModalOpen = true;
      backdrop.classList.add('is-open');
      hideFloatingControls();
      refreshPlatformIdentity();

      let stored = {};
      try {
        stored = await chrome.storage.local.get(['promptcraft_settings', 'promptcraft_frameworks']);
      } catch {}
      const settings = stored.promptcraft_settings || {};
      setTheme(settings.theme || 'dark');
      setEngine(settings.preferredEngine || DEFAULT_ENGINE);
      setVariantCount(settings.variantCount);
      contextToggle.checked = Boolean(settings.includePageContext);
      await renderFrameworkTabs({ frameworks: stored.promptcraft_frameworks, settings });

      if (initialText) {
        rawInput.value = initialText;
      } else if (isFieldLike(active) && !isEligibleField(active)) {
        // Focus is in a field we must not read (a password box, say). Leave the
        // modal empty rather than guessing at some other field on the page.
        rawInput.value = '';
      } else {
        const target = (fromContextMenu && lastContextTarget?.isConnected ? lastContextTarget : null)
          || fieldFrom(active)
          || (currentTargetElement?.isConnected ? currentTargetElement : null)
          || findChatInput();
        if (target) {
          currentTargetElement = target;
          const extracted = getElementValue(target);
          if (extracted) rawInput.value = extracted;
        }
      }

      updateCharCount();
      rawInput.focus();
      if (autoRun && rawInput.value.trim()) runOptimization();
    }

    function closeModal({ insertedTarget = null } = {}) {
      clearTimeout(insertCloseTimer);
      insertCloseTimer = null;
      stopWaitTimer();
      insertBtn.innerHTML = `${ICON('insert', 13)}<span>Insert</span>`;
      saveSheet?.close();
      libraryPicker?.close();
      clarifySheet?.close();
      isModalOpen = false;
      backdrop.classList.remove('is-open');
      const focusTarget = (insertedTarget?.isConnected && insertedTarget)
        || (returnFocusTo?.isConnected && returnFocusTo)
        || null;
      if (focusTarget) {
        focusTarget.focus?.({ preventScroll: true });
        if (insertedTarget && insertedTarget.isContentEditable) {
          try {
            const sel = window.getSelection();
            const endRange = document.createRange();
            endRange.selectNodeContents(insertedTarget);
            endRange.collapse(false);
            sel.removeAllRanges();
            sel.addRange(endRange);
          } catch {}
        }
      }
      returnFocusTo = null;
      if (widgetEnabled) {
        if (currentTargetElement?.isConnected && isEligibleField(currentTargetElement)) {
          positionStarBtn(currentTargetElement);
        } else {
          autoDetectAndPosition();
        }
      }
    }

    closeBtn.addEventListener('click', () => closeModal());
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) closeModal();
    });

    /* Keyboard inside the dialog: Escape closes, Tab stays within it. Handled on
       the dialog rather than the window so the page never sees these keys. */
    const FOCUSABLE = 'button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [contenteditable="plaintext-only"], [tabindex]:not([tabindex="-1"])';
    backdrop.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = Array.from(modal.querySelectorAll(FOCUSABLE))
        .filter(el => !el.closest('[hidden]') && el.getClientRects().length > 0);
      if (!items.length) return;

      const first = items[0];
      const last = items[items.length - 1];
      const current = shadow.activeElement;
      if (e.shiftKey && (current === first || !modal.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !modal.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    });

    /* Typing in the modal must not trigger the host page's single-key hotkeys.
       Runs after the handlers above (bubble phase, on the shadow host). */
    ['keydown', 'keyup', 'keypress'].forEach(type => {
      host.addEventListener(type, e => e.stopPropagation());
    });

    starBtn.addEventListener('mousedown', e => e.preventDefault());
    starBtn.addEventListener('click', e => {
      e.stopPropagation();
      autoEnhanceChatInput({ altKey: Boolean(e.altKey) });
    });

    /* Requests from the service worker: the keyboard command and the context menu. */
    handleOpen = payload => {
      if (payload.fromShortcut) {
        // Selected text is optimized straight away; otherwise the focused field is read.
        const selection = window.getSelection().toString().trim();
        return openModal(selection, Boolean(selection));
      }
      const text = (payload.text || '').trim();
      return openModal(text, payload.autoRun && Boolean(text), { fromContextMenu: Boolean(payload.fromContextMenu) });
    };
    if (queuedOpen) {
      const queued = queuedOpen;
      queuedOpen = null;
      handleOpen(queued);
    }

    /* Optimize --------------------------------------------------------- */
    function updateCharCount() {
      charCount.textContent = String(rawInput.value.length);
    }
    rawInput.addEventListener('input', updateCharCount);

    /* While a request runs, Optimize becomes Cancel (streaming builds only). */
    function setBusy(next) {
      busy = next;
      const canCancel = Boolean(ds?.runClient);
      optimizeBtn.disabled = next && !canCancel;
      optimizeBtn.innerHTML = next
        ? (canCancel ? `${ICON('close', 14)}<span>Cancel</span>` : `<span class="pc-spinner"></span><span>Optimizing…</span>`)
        : `${ICON('wand', 14)}<span>Optimize</span>`;
      optimizeBtn.title = next && canCancel ? 'Stop this request' : 'Optimize prompt (Ctrl+Enter)';
      askBtn.disabled = next;
      editableCtrl?.setEditable(Boolean(latest && !next));
      resultActions?.update({ ...actionState(), busy: next });
    }

    degradedSettingsBtn.addEventListener('click', async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
        if (res && res.success === false) throw new Error(res.error || 'Could not open settings.');
      } catch {
        toast('Open the extension Options page to configure providers', 'neutral');
      }
    });

    /* Technique chips: what the optimizer added and why. textContent, not
       innerHTML — chip labels come from the result payload over messaging. */
    function renderTechChips(chips) {
      techChips.innerHTML = '';
      if (!Array.isArray(chips) || chips.length === 0) {
        techChips.hidden = true;
        return;
      }
      for (const chip of chips) {
        const el = document.createElement('span');
        el.className = 'pc-badge pc-badge--mono';
        el.textContent = String(chip?.label ?? '');
        if (chip?.detail) el.title = String(chip.detail);
        techChips.appendChild(el);
      }
      techChips.hidden = false;
    }

    /* Quality chip: rule rubric before → after, optionally refined on-device.
       Advisory only — it never blocks or downgrades a result. */
    function renderQualityChip(score, rawText) {
      const after = score?.after;
      if (typeof after !== 'number') {
        qualityChip.hidden = true;
        return;
      }
      const before = typeof score?.before === 'number' ? score.before : null;
      qualityChip.textContent = before != null ? `Quality ${before}→${after}` : `Quality ${after}/100`;
      const bits = [];
      if (score.method === 'nano+rules') bits.push(`on-device judge ${score.judgeScore} + rules ${score.ruleScore}`);
      else if (score.method === 'nano') bits.push('judged on-device');
      else bits.push('rule-based check');
      if (Array.isArray(score.missed) && score.missed.length) {
        bits.push(`not shown: ${score.missed.map(t => t.label).join(', ')}`);
      }
      if (rawText) bits.push(`draft: ${rawText.slice(0, 120)}`);
      qualityChip.title = bits.join(' · ');
      qualityChip.className = 'pc-badge pc-badge--mono ' +
        (after >= 80 ? 'pc-badge--success' : after >= 55 ? 'pc-badge--accent' : 'pc-badge--warning');
      qualityChip.hidden = false;
    }

    /* The "before" half of the quality chip; kept across variant switches and manual edits. */
    function scoreBefore() {
      const m = qualityChip.textContent.match(/Quality (\d+)/);
      return m ? parseInt(m[1], 10) : null;
    }

    /* Undo history + inline editable result ------------------------------ */
    const undoStack = ds?.assist?.createUndoStack?.(25) || null;

    function currentSnapshot() {
      if (!latest) return null;
      return {
        text: latest,
        original: lastOriginal,
        engine: lastEngine,
        framework: lastFramework,
        data: lastData,
        variants: currentVariants.slice(),
        scoreBefore: scoreBefore()
      };
    }

    function pushUndoSnapshot(snap = currentSnapshot()) {
      if (snap && undoStack?.push(snap)) {
        resultActions?.update({ ...actionState(), busy });
      }
    }

    function restoreSnapshot(snap, { statusText = 'Reverted change' } = {}) {
      if (!snap) return;
      lastData = snap.data || null;
      latest = snap.text || '';
      lastOriginal = snap.original || '';
      lastEngine = snap.engine || '';
      lastFramework = snap.framework || activeFramework;
      currentVariants = Array.isArray(snap.variants) ? snap.variants.slice() : [];
      loadingState.hidden = true;
      resultText.textContent = latest;
      resultText.hidden = !latest;
      placeholder.hidden = Boolean(latest);
      degradedNotice.hidden = !(lastData?.degraded);
      if (lastEngine && lastData) {
        engineBadge.textContent = ENGINE_LABELS[lastEngine] || lastEngine;
        engineBadge.className = 'pc-badge pc-badge--mono ' +
          (lastData.degraded ? 'pc-badge--warning' : 'pc-badge--accent');
        if (lastData.fallbackReason) {
          const requested = ENGINE_LABELS[lastData.requestedEngine] || lastData.requestedEngine;
          const sameProvider = lastData.engine === lastData.requestedEngine;
          engineBadge.title = sameProvider && lastData.requestedModel
            ? `${requested} (${lastData.requestedModel}) failed: ${lastData.fallbackReason}`
            : `${requested} failed: ${lastData.fallbackReason}`;
        } else {
          engineBadge.title = lastData.model
            ? `${ENGINE_LABELS[lastEngine] || lastEngine} (${lastData.model})`
            : '';
        }
        engineBadge.hidden = false;
      } else {
        engineBadge.title = '';
        engineBadge.hidden = true;
      }
      renderVariantChips();
      renderTechChips(lastData?.techniques);
      if (lastData?.score) renderQualityChip(lastData.score, lastOriginal);
      else if (latest && ds?.scorer) {
        const rule = ds.scorer.scorePrompt(latest, { traitIds: ds.scorer.contractTraitIds(lastFramework || activeFramework) });
        renderQualityChip({ before: snap.scoreBefore ?? null, after: rule.score, missed: rule.missed, method: 'rules' }, lastOriginal);
      } else {
        qualityChip.hidden = true;
      }
      editableCtrl?.setEditable(Boolean(latest && !busy));
      resultActions?.update({ ...actionState(), busy });
      if (statusText) setStatus(statusText, 'neutral');
    }

    const editableCtrl = ds?.assist?.bindEditableResult
      ? ds.assist.bindEditableResult({
        element: resultText,
        onSnapshot: () => pushUndoSnapshot(),
        onEdit: editedText => {
          latest = editedText;
          if (lastData) lastData = { ...lastData, optimized: editedText };
          if (ds?.scorer) {
            const rule = ds.scorer.scorePrompt(editedText, {
              traitIds: ds.scorer.contractTraitIds(lastFramework || activeFramework)
            });
            renderQualityChip({ before: scoreBefore(), after: rule.score, missed: rule.missed, method: 'rules' }, lastOriginal);
          }
          renderVariantChips();
          resultActions?.update({ ...actionState(), busy });
          setStatus('Edited', 'neutral');
        }
      })
      : null;

    /* Variant chips: ranked alternatives; clicking swaps the result on screen
       (and with it everything downstream: copy, save, insert). */
    function renderVariantChips() {
      variantChips.innerHTML = '';
      if (currentVariants.length < 2) {
        variantChips.hidden = true;
        return;
      }
      currentVariants.forEach((variant, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const active = variant.text === latest;
        btn.className = 'pc-badge pc-badge--mono pc-variant-chip' + (active ? ' pc-badge--accent' : '');
        btn.textContent = `${String.fromCharCode(65 + index)} · ${variant.label || `Variant ${index + 1}`} ${variant.score ?? '·'}`;
        btn.title = `Use this variant (quality ${variant.score ?? 'n/a'}/100)`;
        btn.setAttribute('aria-pressed', String(active));
        btn.addEventListener('click', () => {
          if (variant.text === latest) return;
          pushUndoSnapshot();
          latest = variant.text;
          if (lastData) lastData = { ...lastData, optimized: latest };
          resultText.textContent = latest;
          renderVariantChips();
          renderQualityChip({ before: scoreBefore(), after: variant.score, method: 'rules' }, lastOriginal);
          resultActions?.update({ ...actionState(), busy });
        });
        variantChips.appendChild(btn);
      });
      variantChips.hidden = false;
    }

    /* Refine / Continue / Undo under the result. Only model output supports
       refinement; undo restores the previous snapshot whenever available. */
    function actionState() {
      const hasUndo = Boolean(undoStack?.canUndo());
      return {
        visible: Boolean(latest && (lastData || hasUndo)),
        truncated: Boolean(lastData?.truncated),
        canRefine: Boolean(latest && lastData && lastData.engine !== 'offline'),
        canUndo: hasUndo
      };
    }

    const resultActions = ds?.assist && ds?.runClient
      ? ds.assist.createResultActions({
        onRefine: kind => runRequest({ action: 'refine', kind, previous: latest, text: lastOriginal }),
        onCustomRefine: instruction => runRequest({
          action: 'refine', kind: 'custom', instruction, previous: latest, text: lastOriginal
        }),
        onContinue: () => runRequest(
          { action: 'refine', kind: 'continue', previous: latest, text: lastOriginal },
          { base: latest }
        ),
        onUndo: () => {
          const prev = undoStack?.pop();
          if (prev) restoreSnapshot(prev);
        }
      })
      : null;
    if (resultActions) actionsSlot.appendChild(resultActions.element);

    function applyResult(data, original) {
      stopWaitTimer();
      lastData = data;
      latest = data.optimized;
      lastOriginal = original;
      lastEngine = data.engine || '';
      lastFramework = data.framework || activeFramework;
      resultText.textContent = latest;
      resultText.hidden = false;
      placeholder.hidden = true;

      engineBadge.textContent = ENGINE_LABELS[data.engine] || data.engine || '';
      engineBadge.className = 'pc-badge pc-badge--mono ' +
        (data.degraded ? 'pc-badge--warning' : 'pc-badge--accent');
      engineBadge.hidden = !data.engine;
      renderQualityChip(data.score, original);
      currentVariants = Array.isArray(data.variants) ? data.variants : [];
      renderVariantChips();
      renderTechChips(data.techniques);

      /* A failed engine still yields a usable result, but it must not be
         presented as the engine the user chose. */
      if (data.degraded) {
        const requested = ENGINE_LABELS[data.requestedEngine] || data.requestedEngine || 'That engine';
        engineBadge.title = '';
        degradedTitle.textContent = `${requested} unavailable — offline template used`;
        degradedReason.textContent = data.degradedReason
          ? `${data.degradedReason} The output below is a local template, not a model response.`
          : 'The output below is a local template, not a model response.';
        degradedNotice.hidden = false;
        setStatus('Offline fallback', 'warning');
        toast('Fell back to the offline template', 'danger');
      } else if (data.fallbackReason) {
        /* Another configured provider or fallback model answered for the chosen one. */
        const requested = ENGINE_LABELS[data.requestedEngine] || data.requestedEngine;
        const used = ENGINE_LABELS[data.engine] || data.engine;
        const sameProvider = data.engine === data.requestedEngine;
        if (sameProvider) {
          engineBadge.title = data.requestedModel && data.model
            ? `${requested} (${data.requestedModel}) failed: ${data.fallbackReason}`
            : `${requested} failed: ${data.fallbackReason}`;
          setStatus(data.model ? `Used ${data.model}` : `Used ${used}`, 'warning');
          toast(
            data.model
              ? `${data.requestedModel || requested} failed, used ${data.model}`
              : `${requested} fallback used`,
            'neutral'
          );
        } else {
          engineBadge.title = `${requested} failed: ${data.fallbackReason}`;
          setStatus(`Used ${used}`, 'warning');
          toast(
            `${requested} unavailable, used ${used}${data.model ? ` (${data.model})` : ''}`,
            'neutral'
          );
        }
      } else if (data.truncated) {
        engineBadge.title = data.model ? `${ENGINE_LABELS[data.engine] || data.engine} (${data.model})` : '';
        setStatus('Cut off', 'warning');
        toast('The output was cut off. Press Continue to finish it.', 'neutral');
      } else {
        engineBadge.title = data.model ? `${ENGINE_LABELS[data.engine] || data.engine} (${data.model})` : '';
        setStatus('Done', 'success');
        toast(data.refinement ? 'Prompt refined' : 'Prompt optimized', 'success');
      }
      editableCtrl?.setEditable(Boolean(latest && !busy));
      resultActions?.update(actionState());
    }

    /** Without the shared modules: one request, no streaming, no cancel. */
    async function sendOnce(payload) {
      const response = await chrome.runtime.sendMessage({ type: 'OPTIMIZE_PROMPT', payload });
      if (!response?.success) throw new Error(response?.error || 'Optimization failed.');
      return response.data;
    }

    /**
     * One request, streamed when the shared modules loaded. `base` is the text
     * a Continue appends to; it stays on screen while the remainder streams in.
     */
    async function runRequest(payload, { base = '' } = {}) {
      if (busy) return;
      const isOptimize = !payload.action || payload.action === 'optimize';
      const preRunSnapshot = currentSnapshot();
      setBusy(true);
      saveSheet?.close(); // the result it was about is being replaced
      clarifySheet?.close();
      secretNotice?.hide();
      const waitLabel = isOptimize && variantCount > 1
        ? `Generating ${variantCount} variants…`
        : (isOptimize ? 'Optimizing…' : 'Refining…');
      setStatus(waitLabel, 'neutral');
      degradedNotice.hidden = true;
      techChips.hidden = true;
      qualityChip.hidden = true;
      variantChips.hidden = true;
      resultActions?.update({ visible: false });
      if (isOptimize) {
        currentVariants = [];
        if (!base) {
          resultText.hidden = true;
          placeholder.hidden = true;
          startWaitTimer(waitLabel);
        }
      } else if (!base) {
        startWaitTimer(waitLabel);
      }

      let streamed = base;
      const paint = text => {
        stopWaitTimer();
        placeholder.hidden = true;
        resultText.hidden = false;
        resultText.textContent = text;
        resultText.classList.add('is-streaming');
      };
      if (base) paint(base);

      const full = { ...payload, engine, frameworkId: activeFramework, host: location.hostname };
      try {
        let data;
        if (ds?.runClient) {
          currentRun = ds.runClient.startRun(full, {
            onStart: (name, model) => {
              streamed = base;
              const label = ENGINE_LABELS[name] || name;
              const withModel = model ? `${label} (${model})` : label;
              const engineWait = isOptimize && variantCount > 1
                ? `${withModel} (${variantCount} variants)…`
                : `${withModel}…`;
              if (base) {
                setStatus(engineWait, 'neutral');
                paint(base);
              } else {
                setStatus(engineWait, 'neutral');
                startWaitTimer(engineWait);
              }
            },
            onToken: delta => {
              streamed += delta;
              paint(streamed);
            },
            onStatus: info => {
              if (!busy) return;
              const waitSec = info?.delayMs ? `${Math.max(1, Math.round(info.delayMs / 1000))}s` : '';
              const why = info?.status === 429 ? 'Rate limited (429)' : (info?.reason || 'Retrying');
              const msg = `${why}${waitSec ? `, retrying in ${waitSec}…` : ', retrying…'}`;
              setStatus(msg, 'warning');
              if (!streamed) startWaitTimer(msg, 'warning');
            }
          });
          data = await currentRun.promise;
        } else {
          data = await sendOnce(full);
        }

        if (!data) {
          stopWaitTimer();
          if (preRunSnapshot) {
            restoreSnapshot(preRunSnapshot, { statusText: 'Cancelled' });
          } else {
            resultText.hidden = true;
            placeholder.hidden = false;
            setStatus('Cancelled', 'neutral');
          }
          return;
        }
        if (preRunSnapshot) pushUndoSnapshot(preRunSnapshot);
        if (payload.kind === 'custom') resultActions?.clearCustomInput?.();
        applyResult(data, isOptimize ? payload.text : lastOriginal);
      } catch (err) {
        stopWaitTimer();
        if (isOptimize) {
          degradedNotice.hidden = true;
          resultText.hidden = true;
          placeholder.hidden = false;
          placeholder.innerHTML = `
            <span class="pc-empty__icon">${ICON('alert', 16)}</span>
            <span class="pc-empty__title">Optimization failed</span>
            <span class="pc-empty__desc">${escapeHtml(err.message)}</span>`;
        } else if (preRunSnapshot) {
          // A failed refinement leaves the result it was refining untouched.
          restoreSnapshot(preRunSnapshot, { statusText: '' });
        }
        setStatus('Failed', 'danger');
        toast(err.message, 'danger');
      } finally {
        stopWaitTimer();
        resultText.classList.remove('is-streaming');
        currentRun = null;
        setBusy(false);
        resultActions?.update(actionState());
      }
    }

    /** Title, address (no query string) and any selection other than the draft. */
    function pageContext(draft, enabled = contextToggle.checked) {
      if (!enabled) return '';
      const selection = window.getSelection().toString().trim();
      const lines = [`Page title: ${document.title}`, `URL: ${location.origin}${location.pathname}`];
      if (selection && selection !== draft.trim()) lines.push(`Selected text:\n${selection.slice(0, 2000)}`);
      return lines.join('\n');
    }

    /** A credential in the draft stops the run until the user says so. */
    async function blockedBySecret(text) {
      if (!ds?.secrets || !secretNotice) return false;
      const warning = ds.secrets.secretWarning(text, engine, await getSettings());
      if (!warning || secretAllowedFor === text) return false;
      secretNotice.show(warning);
      return true;
    }

    async function runOptimization() {
      if (busy) { currentRun?.cancel(); return; }
      const text = rawInput.value.trim();
      if (!text) {
        toast('Type a prompt first', 'danger');
        rawInput.focus();
        return;
      }
      if (await blockedBySecret(text)) return;
      await runRequest({ action: 'optimize', text, variantCount, context: pageContext(text) });
    }

    optimizeBtn.addEventListener('click', runOptimization);

    rawInput.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runOptimization();
      }
    });

    function setStarVisual(mode, statusHint = '') {
      quickState.mode = mode;
      const busyNow = mode === 'repairing' || mode === 'enhancing';
      const revertNow = mode === 'repaired' || mode === 'enhanced';
      starBtn.dataset.state = mode;
      starBtn.classList.toggle('is-busy', busyNow);
      starBtn.classList.toggle('is-revert', revertNow);
      starBtn.setAttribute('aria-busy', String(busyNow));

      if (busyNow) {
        starBtn.innerHTML = '<span class="pc-spinner" aria-hidden="true"></span>';
        const msg = statusHint || (mode === 'repairing' ? 'Checking typos…' : 'Enhancing draft…');
        starBtn.title = `${msg} (click to cancel)`;
        starBtn.setAttribute('aria-label', `${msg} (click to cancel)`);
      } else if (revertNow) {
        starBtn.innerHTML = ICON('undo', 15) || '<span aria-hidden="true">↩</span>';
        const msg = statusHint || (mode === 'repaired'
          ? 'Typos repaired — click to revert'
          : 'Prompt enhanced — click to revert to original');
        starBtn.title = msg;
        starBtn.setAttribute('aria-label', msg);
      } else {
        starBtn.innerHTML = ICON('star', 15) || '<span aria-hidden="true">★</span>';
        refreshPlatformIdentity();
      }
    }

    function resetQuickState() {
      quickState.target = null;
      quickState.originalBackup = null;
      quickState.lastWritten = null;
      quickState.hasAppliedStep1 = false;
      quickState.routeKey = location.href;
      setStarVisual('idle');
    }

    function writeQuickText(el, text) {
      if (!el?.isConnected || !isEligibleField(el)) return false;
      isQuickWriting = true;
      try {
        return insertTextIntoElement(el, text);
      } finally {
        isQuickWriting = false;
      }
    }

    function revertQuickDraft() {
      if (quickState.originalBackup == null) return false;
      const undoTarget = (quickState.target?.isConnected && isEligibleField(quickState.target) && quickState.target)
        || (currentTargetElement?.isConnected && isEligibleField(currentTargetElement) && currentTargetElement)
        || findChatInput();
      const backup = quickState.originalBackup;
      if (undoTarget && writeQuickText(undoTarget, backup)) {
        currentTargetElement = undoTarget;
        positionStarBtn(undoTarget);
        resetQuickState();
        toast('Restored original draft', 'neutral');
        return true;
      }
      toast('Could not restore original draft', 'danger');
      return false;
    }

    function cancelQuickRun({ preserveRevert = false } = {}) {
      quickRunSeq += 1;
      const activeRun = quickRun;
      quickRun = null;
      activeRun?.cancel?.();
      if (preserveRevert && quickState.hasAppliedStep1 && quickState.target?.isConnected && getElementValue(quickState.target).trim()) {
        setStarVisual('repaired', 'Typos repaired — click to revert');
      } else if (isQuickBusy()) {
        resetQuickState();
      }
    }

    async function runQuickWorker(payload, handlers) {
      if (ds?.runClient) {
        quickRun = ds.runClient.startRun(payload, handlers);
        return await quickRun.promise;
      }
      return await sendOnce(payload);
    }

    function composerChangedByUser(el, expectedNorm) {
      if (!el?.isConnected || !isEligibleField(el)) return true;
      return !textsMatchSemantically(getElementValue(el), expectedNorm);
    }

    function formatQuickRetry(info) {
      const waitSec = info?.delayMs ? `${Math.max(1, Math.round(info.delayMs / 1000))}s` : '';
      const why = info?.status === 429 ? 'Rate limited (429)' : (info?.reason || 'Retrying');
      return `${why}${waitSec ? `, retrying in ${waitSec}…` : ', retrying…'}`;
    }

    async function autoEnhanceChatInput({ altKey = false } = {}) {
      if (location.href !== quickState.routeKey) {
        cancelQuickRun({ preserveRevert: false });
        resetQuickState();
      }

      if (isQuickBusy()) {
        const keepRevert = Boolean(
          quickState.hasAppliedStep1 &&
          quickState.target?.isConnected &&
          getElementValue(quickState.target).trim()
        );
        cancelQuickRun({ preserveRevert: keepRevert });
        toast(keepRevert ? 'Enhancement cancelled — typo fixes kept' : 'Quick enhance cancelled', 'neutral');
        return;
      }

      if (quickState.mode === 'repaired' || quickState.mode === 'enhanced') {
        const activeTarget = quickState.target?.isConnected ? quickState.target : null;
        const switchedField = currentTargetElement && activeTarget && currentTargetElement !== activeTarget;
        const liveVal = activeTarget ? getElementValue(activeTarget) : '';
        if (!liveVal.trim() || switchedField) {
          resetQuickState();
        } else {
          revertQuickDraft();
          return;
        }
      }

      if (busy) return;

      const active = getDeepActiveElement();
      if (isFieldLike(active) && !isEligibleField(active)) {
        hideFloatingControls();
        return;
      }

      const target = (currentTargetElement?.isConnected && isEligibleField(currentTargetElement) && currentTargetElement)
        || fieldFrom(active)
        || findChatInput();
      if (!target) {
        toast('Open or focus a chat box first', 'danger');
        return;
      }

      const raw = getElementValue(target);
      const trimmed = raw.trim();
      if (!trimmed) {
        toast('Type a prompt in the chat box first', 'neutral');
        target.focus?.({ preventScroll: true });
        return;
      }

      if (trimmed.length > QUICK_MAX_CHARS) {
        toast(`Draft too long for quick enhance (${trimmed.length}/${QUICK_MAX_CHARS} chars) — use Optimize modal`, 'danger');
        return;
      }

      const profile = resolveSiteProfile();
      const targetHint = profile ? ` for ${profile.name}` : '';
      const seq = ++quickRunSeq;
      const snapshot0 = normalizeInsertedText(raw);

      quickState.target = target;
      quickState.originalBackup = raw;
      quickState.lastWritten = null;
      quickState.hasAppliedStep1 = false;
      quickState.routeKey = location.href;
      const likelyRepair = altKey || (
        quickRepairCached &&
        (quickEngineCached || DEFAULT_ENGINE) !== 'offline' &&
        trimmed.length <= QUICK_REPAIR_MAX_CHARS &&
        !hasStructuredPromptTokens(trimmed)
      );
      setStarVisual(likelyRepair ? 'repairing' : 'enhancing', likelyRepair ? 'Checking typos…' : `Enhancing draft${targetHint}…`);

      try {
        const [settings, frameworks] = await Promise.all([getSettings(), getFrameworksList()]);
        if (seq !== quickRunSeq) return;
        if (location.href !== quickState.routeKey) { resetQuickState(); return; }

        const preEngine = settings.preferredEngine || DEFAULT_ENGINE;
        quickEngineCached = preEngine;
        quickRepairCached = settings.quickRepairEnabled !== false;
        const preFramework = settings.preferredFramework && frameworks.some(f => f.id === settings.preferredFramework)
          ? settings.preferredFramework
          : (frameworks[0]?.id || 'smart-expand');

        if (ds?.secrets) {
          const warning = ds.secrets.secretWarning(trimmed, preEngine, settings);
          if (warning && secretAllowedFor !== trimmed) {
            resetQuickState();
            toast('Review secret warning before sending', 'danger');
            await openModal(trimmed);
            secretNotice?.show(warning);
            return;
          }
        }

        let draftForEnhance = trimmed;
        let currentExpectedNorm = snapshot0;

        if (altKey) {
          if (trimmed.length > QUICK_REPAIR_MAX_CHARS) {
            resetQuickState();
            toast(`Draft exceeds ${QUICK_REPAIR_MAX_CHARS} chars for typo repair`, 'neutral');
            return;
          }
          if (preEngine === 'offline') {
            resetQuickState();
            toast('Typo repair needs an AI engine in Options', 'neutral');
            return;
          }
          setStarVisual('repairing', 'Checking typos…');
          const rep = await runQuickWorker(
            { action: 'repair', text: trimmed, engine: preEngine, host: location.hostname },
            {
              onStart: (usedEngine, usedModel) => {
                if (seq !== quickRunSeq) return;
                const name = ENGINE_LABELS[usedEngine] || usedEngine;
                const via = usedModel ? `${name} (${usedModel})` : name;
                setStarVisual('repairing', `Checking typos via ${via}…`);
              },
              onStatus: info => {
                if (seq === quickRunSeq) setStarVisual('repairing', formatQuickRetry(info));
              }
            }
          );
          if (seq !== quickRunSeq) return;
          if (!rep || location.href !== quickState.routeKey) {
            resetQuickState();
            return;
          }
          if (rep.changed && rep.repaired) {
            const liveTarget = (target.isConnected && isEligibleField(target) && target) || findChatInput();
            if (!liveTarget || composerChangedByUser(liveTarget, snapshot0)) {
              resetQuickState();
              toast('Draft changed while checking typos — skipped update', 'neutral');
              return;
            }
            if (writeQuickText(liveTarget, rep.repaired)) {
              quickState.target = liveTarget;
              quickState.lastWritten = normalizeInsertedText(getElementValue(liveTarget));
              quickState.hasAppliedStep1 = true;
              currentTargetElement = liveTarget;
              positionStarBtn(liveTarget);
              setStarVisual('repaired', 'Typos repaired — click to revert');
              toast('Typos repaired', 'success', {
                actionLabel: 'Undo',
                duration: 6000,
                onAction: revertQuickDraft
              });
            } else {
              resetQuickState();
              try { await navigator.clipboard.writeText(rep.repaired); } catch {}
              toast('Could not update chat box — copied instead', 'danger');
            }
          } else {
            resetQuickState();
            const reasonMsg = rep.skipped === 'structured_tokens'
              ? 'Skipped typo repair for @mention or /command prompt'
              : rep.skipped === 'error'
                ? 'Could not run typo repair right now'
                : 'No typos needed fixing';
            toast(reasonMsg, 'neutral');
          }
          return;
        }

        const shouldRepair = settings.quickRepairEnabled !== false &&
          preEngine !== 'offline' &&
          trimmed.length <= QUICK_REPAIR_MAX_CHARS &&
          !hasStructuredPromptTokens(trimmed);

        if (shouldRepair) {
          setStarVisual('repairing', 'Checking typos…');
          try {
            const rep = await runQuickWorker(
              { action: 'repair', text: trimmed, engine: preEngine, host: location.hostname },
              {
                onStart: (usedEngine, usedModel) => {
                  if (seq !== quickRunSeq) return;
                  const name = ENGINE_LABELS[usedEngine] || usedEngine;
                  const via = usedModel ? `${name} (${usedModel})` : name;
                  setStarVisual('repairing', `Checking typos via ${via}…`);
                },
                onStatus: info => {
                  if (seq === quickRunSeq) setStarVisual('repairing', formatQuickRetry(info));
                }
              }
            );
            if (seq !== quickRunSeq) return;
            if (!rep || location.href !== quickState.routeKey) {
              resetQuickState();
              return;
            }
            if (rep.changed && rep.repaired) {
              const step1Target = (target.isConnected && isEligibleField(target) && target) || findChatInput();
              if (!step1Target || composerChangedByUser(step1Target, snapshot0)) {
                resetQuickState();
                toast('Draft changed while checking typos — cancelled', 'neutral');
                return;
              }
              if (writeQuickText(step1Target, rep.repaired)) {
                quickState.target = step1Target;
                currentExpectedNorm = normalizeInsertedText(getElementValue(step1Target));
                quickState.lastWritten = currentExpectedNorm;
                quickState.hasAppliedStep1 = true;
                draftForEnhance = rep.repaired;
                currentTargetElement = step1Target;
                positionStarBtn(step1Target);
              }
            }
          } catch {
            // Silent non-blocking fallback so Step 2 still runs unless cancelled or navigated away
            if (seq !== quickRunSeq) return;
            if (location.href !== quickState.routeKey) { resetQuickState(); return; }
          } finally {
            if (seq === quickRunSeq) quickRun = null;
          }
        }

        setStarVisual('enhancing', `Enhancing draft${targetHint}…`);
        const payload = {
          action: 'optimize',
          text: draftForEnhance,
          engine: preEngine,
          frameworkId: preFramework,
          variantCount: 1,
          context: pageContext(draftForEnhance, Boolean(settings.includePageContext)),
          host: location.hostname
        };

        const data = await runQuickWorker(payload, {
          onStart: (usedEngine, usedModel) => {
            if (seq !== quickRunSeq) return;
            const name = ENGINE_LABELS[usedEngine] || usedEngine;
            const via = usedModel ? `${name} (${usedModel})` : name;
            setStarVisual('enhancing', `Enhancing${targetHint} via ${via}…`);
          },
          onStatus: info => {
            if (seq === quickRunSeq) setStarVisual('enhancing', formatQuickRetry(info));
          }
        });

        if (seq !== quickRunSeq) return;
        if (location.href !== quickState.routeKey) {
          resetQuickState();
          return;
        }
        if (!data?.optimized) {
          if (quickState.hasAppliedStep1 && quickState.target?.isConnected && getElementValue(quickState.target).trim()) {
            setStarVisual('repaired', 'Typos repaired — click to revert');
          } else {
            resetQuickState();
          }
          return;
        }

        const writeTarget = (quickState.target?.isConnected && isEligibleField(quickState.target) && quickState.target)
          || (target.isConnected && isEligibleField(target) && target)
          || findChatInput();

        if (!writeTarget || composerChangedByUser(writeTarget, currentExpectedNorm)) {
          resetQuickState();
          toast('Draft changed while enhancing — kept your edit', 'neutral');
          return;
        }

        if (writeQuickText(writeTarget, data.optimized)) {
          quickState.target = writeTarget;
          quickState.lastWritten = normalizeInsertedText(getElementValue(writeTarget));
          currentTargetElement = writeTarget;
          positionStarBtn(writeTarget);
          setStarVisual('enhanced', 'Prompt enhanced — click to revert to original');

          const engineLabel = ENGINE_LABELS[data.engine] || data.engine || '';
          const msg = data.degraded
            ? (profile ? `Enhanced for ${profile.name} (offline fallback)` : 'Enhanced with offline fallback')
            : (profile
              ? `Enhanced for ${profile.name}${engineLabel ? ` · ${engineLabel}` : ''}`
              : `Prompt enhanced${engineLabel ? ` · ${engineLabel}` : ''}`);
          toast(msg, data.degraded ? 'neutral' : 'success', {
            actionLabel: 'Undo',
            duration: 6000,
            onAction: revertQuickDraft
          });
        } else {
          if (quickState.hasAppliedStep1 && quickState.target?.isConnected && getElementValue(quickState.target).trim()) {
            setStarVisual('repaired', 'Typos repaired — click to revert');
          } else {
            resetQuickState();
          }
          try { await navigator.clipboard.writeText(data.optimized); } catch {}
          toast('Could not update chat box — copied instead', 'danger');
        }
      } catch (err) {
        if (seq === quickRunSeq) {
          if (quickState.hasAppliedStep1 && quickState.target?.isConnected && getElementValue(quickState.target).trim()) {
            setStarVisual('repaired', 'Typos repaired — click to revert');
          } else {
            resetQuickState();
          }
          toast(err?.message || 'Quick enhance failed', 'danger');
        }
      } finally {
        if (seq === quickRunSeq) {
          quickRun = null;
        }
      }
    }

    /* Secret warning, Ask me first, page context ------------------------ */
    const secretNotice = ds?.assist
      ? ds.assist.createSecretNotice({
        onSendAnyway: () => {
          secretAllowedFor = rawInput.value.trim();
          runOptimization();
        }
      })
      : null;
    if (secretNotice) {
      secretSlot.appendChild(secretNotice.element);
      rawInput.addEventListener('input', () => secretNotice.hide());
    }

    const clarifySheet = ds?.assist && ds?.clarify && ds?.runClient
      ? ds.assist.createClarifySheet({
        idPrefix: 'pc-clarify',
        onSubmit: answers => {
          rawInput.value = ds.clarify.withAnswers(rawInput.value, answers);
          updateCharCount();
          runOptimization();
        },
        onCancel: () => rawInput.focus()
      })
      : null;

    if (clarifySheet) {
      clarifySlot.appendChild(clarifySheet.element);
      askBtn.addEventListener('click', async () => {
        const text = rawInput.value.trim();
        if (!text) {
          toast('Type a prompt first', 'danger');
          rawInput.focus();
          return;
        }
        if (busy || await blockedBySecret(text)) return;
        askBtn.disabled = true;
        setStatus('Thinking of questions…', 'neutral');
        try {
          const res = await ds.runClient.startRun({ action: 'clarify', text, engine }).promise;
          if (!res) return;
          clarifySheet.open(res.questions, res.degraded
            ? 'General questions: no AI engine was reachable to tailor them.'
            : '');
          setStatus('Ready', 'neutral');
        } catch (err) {
          setStatus('Failed', 'danger');
          toast(err.message, 'danger');
        } finally {
          askBtn.disabled = busy;
        }
      });
    } else {
      assistRow.remove();
    }

    /* Page context is opt-in and remembered; the worker owns the write. */
    contextToggle.addEventListener('change', () => {
      Promise.resolve(chrome.runtime.sendMessage({
        type: 'SET_PAGE_CONTEXT', payload: { enabled: contextToggle.checked }
      })).catch(err => console.warn('[PromptOptimizer] could not persist page context:', err));
    });

    /* Saved prompts ------------------------------------------------------ */
    /* A saved prompt, with its {{variables}} filled in, becomes the result on
       screen, ready to Insert into the chat box. */
    const libraryPicker = ds?.assist && ds?.library
      ? ds.assist.createLibraryPicker({
        idPrefix: 'pc-lib',
        getEntries: ds.library.getLibrary,
        onClose: () => libraryBtn.setAttribute('aria-pressed', 'false'),
        onUse: (text, entry) => {
          setLibraryOpen(false);
          pushUndoSnapshot();
          stopWaitTimer();
          lastData = null;
          latest = text;
          lastOriginal = entry.original || '';
          lastEngine = entry.engine || '';
          lastFramework = entry.framework || '';
          currentVariants = [];
          degradedNotice.hidden = true;
          engineBadge.hidden = true;
          qualityChip.hidden = true;
          variantChips.hidden = true;
          techChips.hidden = true;
          resultText.textContent = text;
          resultText.hidden = false;
          placeholder.hidden = true;
          editableCtrl?.setEditable(Boolean(latest && !busy));
          resultActions?.update(actionState());
          setStatus(`Loaded "${entry.title}"`, 'neutral');
          toast('Saved prompt ready to insert', 'success');
        }
      })
      : null;

    function setLibraryOpen(open) {
      if (!libraryPicker) return;
      if (!open) { libraryPicker.close(); return; }
      libraryPicker.open();
      libraryBtn.setAttribute('aria-pressed', 'true');
    }

    if (libraryPicker) {
      librarySlot.appendChild(libraryPicker.element);
      libraryBtn.addEventListener('click', () => setLibraryOpen(!libraryPicker.isOpen()));
    } else {
      libraryBtn.remove();
    }

    /* Save ------------------------------------------------------------- */
    /* Saving goes through the service worker: the content script holds no
       route to the library of its own. Without the shared modules there is no
       sheet to show, so the button is removed rather than left dead. */
    const saveSheet = ds?.saveSheet
      ? ds.saveSheet.createSaveSheet({
        idPrefix: 'pc-save',
        getSuggestions: async () => {
          const res = await chrome.runtime.sendMessage({ type: 'LIBRARY_LABELS' });
          return res?.success ? res.labels : [];
        },
        onSave: async ({ title, labels }) => {
          const res = await chrome.runtime.sendMessage({
            type: 'SAVE_PROMPT',
            payload: {
              title, labels, text: latest, original: lastOriginal, framework: lastFramework, engine: lastEngine
            }
          });
          if (!res?.success) throw new Error(res?.error || 'Could not save this prompt.');
          toast('Saved to library', 'success');
        }
      })
      : null;

    if (saveSheet) saveSlot.appendChild(saveSheet.element);
    else saveBtn.remove();

    saveBtn.addEventListener('click', () => {
      if (!latest) {
        toast('Nothing to save yet', 'danger');
        return;
      }
      if (saveSheet.isOpen()) {
        saveSheet.close();
        return;
      }
      saveSheet.open({ title: ds.library.deriveTitle(latest) });
    });

    /* Copy / insert ---------------------------------------------------- */
    copyBtn.addEventListener('click', async () => {
      if (!latest) {
        toast('Nothing to copy yet', 'danger');
        return;
      }
      await navigator.clipboard.writeText(latest);
      copyBtn.innerHTML = `${ICON('check', 13)}<span>Copied</span>`;
      toast('Copied to clipboard', 'success');
      setTimeout(() => {
        copyBtn.innerHTML = `${ICON('copy', 13)}<span>Copy</span>`;
      }, 1800);
    });

    insertBtn.addEventListener('click', () => {
      if (!latest) {
        toast('Nothing to insert yet', 'danger');
        return;
      }
      const target = currentTargetElement?.isConnected && isEligibleField(currentTargetElement)
        ? currentTargetElement
        : findChatInput();

      if (insertTextIntoElement(target, latest)) {
        if (target) currentTargetElement = target;
        insertBtn.innerHTML = `${ICON('check', 13)}<span>Inserted</span>`;
        toast('Inserted into chat', 'success');
        clearTimeout(insertCloseTimer);
        insertCloseTimer = setTimeout(() => {
          insertCloseTimer = null;
          closeModal({ insertedTarget: target });
        }, 350);
      } else {
        navigator.clipboard.writeText(latest);
        toast('Could not insert — copied instead', 'danger');
      }
    });

    /* Element helpers -------------------------------------------------- */
    const BLOCK_TAGS = new Set([
      'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG',
      'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI',
      'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL'
    ]);
    const IGNORED_CONTENT_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE']);

    /* Reads rich contenteditable elements (Quill, ProseMirror, Lexical, plain
       div lines) without Chromium's innerText <p>-margin newline inflation. */
    function readBlockLines(container) {
      const childNodes = Array.from(container.childNodes);
      const hasBlockChildren = childNodes.some(n => n.nodeType === 1 && BLOCK_TAGS.has(n.tagName));
      const lines = [];
      let inlineBuf = '';
      let hasInline = false;
      let endedWithBr = false;

      const flushInline = () => {
        if (!hasInline) return;
        let line = inlineBuf;
        if (endedWithBr && line.endsWith('\n')) {
          line = line.slice(0, -1);
        }
        lines.push(line);
        inlineBuf = '';
        hasInline = false;
        endedWithBr = false;
      };

      const walkInline = node => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            const val = child.nodeValue || '';
            if (hasBlockChildren && !hasInline && /^[ \t]*[\r\n]+[ \t\r\n]*$/.test(val)) {
              continue;
            }
            inlineBuf += val;
            hasInline = true;
            endedWithBr = false;
          } else if (child.nodeType === 1) {
            if (IGNORED_CONTENT_TAGS.has(child.tagName) || child.hasAttribute('hidden')) continue;
            if (child.tagName === 'BR') {
              inlineBuf += '\n';
              hasInline = true;
              endedWithBr = true;
            } else if (BLOCK_TAGS.has(child.tagName)) {
              flushInline();
              if (child.tagName === 'HR') {
                lines.push('');
              } else {
                const sub = readBlockLines(child);
                if (sub.length) {
                  lines.push(...sub);
                } else {
                  lines.push('');
                }
              }
            } else {
              walkInline(child);
            }
          }
        }
      };

      walkInline(container);
      flushInline();
      return lines;
    }

    function readContentEditableText(el) {
      if (!el) return '';
      const raw = readBlockLines(el).join('\n');
      return raw.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    }

    function getElementValue(el) {
      if (!isEligibleField(el)) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
      if (el.isContentEditable) return readContentEditableText(el);
      return '';
    }

    function normalizeInsertedText(str) {
      if (ds?.targetProfiles?.normalizeEditableText) {
        return ds.targetProfiles.normalizeEditableText(str);
      }
      return String(str ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
    }

    function textsMatchSemantically(actual, expected) {
      if (ds?.targetProfiles?.editableTextsMatch) {
        return ds.targetProfiles.editableTextsMatch(actual, expected);
      }
      const a = normalizeInsertedText(actual);
      const b = normalizeInsertedText(expected);
      if (a === b) return true;
      if (b.includes('\n') && !a.includes('\n')) return false;
      const canonical = s => s
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
      return Boolean(b) && canonical(a) === canonical(b);
    }

    function syncQuillState(el, text) {
      if (!el?.classList?.contains('ql-editor')) return;
      const isBlank = !normalizeInsertedText(text);
      if (isBlank && el.children.length === 1 && el.firstElementChild?.tagName === 'P' &&
          !el.firstElementChild.textContent && !el.firstElementChild.querySelector('br')) {
        el.firstElementChild.appendChild(document.createElement('br'));
      }
      el.classList.toggle('ql-blank', isBlank);
    }

    function collapseSelectionToEnd(el, selection) {
      try {
        const endRange = document.createRange();
        const targetNode = el.lastElementChild?.tagName === 'P' ? el.lastElementChild : el;
        endRange.selectNodeContents(targetNode);
        endRange.collapse(false);
        selection.removeAllRanges();
        selection.addRange(endRange);
      } catch {}
    }

    function insertTextIntoElement(el, text) {
      if (!isEligibleField(el)) el = findChatInput();
      if (!el) return false;

      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }

      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        try {
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
        } catch {}
        if (el.value !== text) el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
      }

      if (el.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);

        // 1. execCommand preserves ProseMirror / Lexical / Quill undo stacks when accepted cleanly.
        let ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
        if (ok && textsMatchSemantically(getElementValue(el), text)) {
          syncQuillState(el, text);
          return true;
        }

        // 2. Synthetic plain-text paste handles rich editors that ignore execCommand.
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const pasteEvt = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt
          });
          const pasteRange = document.createRange();
          pasteRange.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(pasteRange);
          el.dispatchEvent(pasteEvt);
          if (textsMatchSemantically(getElementValue(el), text)) {
            syncQuillState(el, text);
            return true;
          }
        } catch {}

        // 3. Direct DOM fallback (Trusted Types safe: builds <p> blots without innerHTML).
        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertReplacementText',
            data: text
          }));
        } catch {}
        if (el.classList.contains('ql-editor') || el.classList.contains('ProseMirror')) {
          const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
          const frag = document.createDocumentFragment();
          for (const line of lines) {
            const p = document.createElement('p');
            if (line.length > 0) p.textContent = line;
            else p.appendChild(document.createElement('br'));
            frag.appendChild(p);
          }
          el.replaceChildren(frag);
          syncQuillState(el, text);
        } else {
          el.innerText = text;
        }
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertReplacementText',
          data: text
        }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        collapseSelectionToEnd(el, selection);
        return true;
      }

      return false;
    }

    /* Star button positioning ------------------------------------------ */
    const FALLBACK_INPUT_SELECTORS = [
      '#prompt-textarea',
      '[role="textbox"][contenteditable]:not([contenteditable="false"])',
      'div[contenteditable]:not([contenteditable="false"])',
      'textarea'
    ];
    const FALLBACK_COMPOSER_SELECTORS = [
      '[data-testid*="composer" i]',
      '[class*="composer" i]',
      '.input-area',
      '.text-input-field',
      'input-area-v2',
      'ms-prompt-input',
      '.prompt-input-wrapper',
      'fieldset',
      'form',
      '[data-testid*="chat-input" i]',
      'rich-textarea'
    ];

    function isVisibleElement(el) {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function getParentAcrossShadow(node) {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const rootNode = node.getRootNode?.();
      return typeof ShadowRoot === 'function' && rootNode instanceof ShadowRoot ? rootNode.host : null;
    }

    function closestAcrossShadow(startEl, selector) {
      let cur = startEl;
      while (cur) {
        try {
          const hit = cur.closest(selector);
          if (hit) return hit;
        } catch {}
        const rootNode = cur.getRootNode?.();
        cur = typeof ShadowRoot === 'function' && rootNode instanceof ShadowRoot ? rootNode.host : null;
      }
      return null;
    }

    function findComposerAnchor(targetEl) {
      if (!targetEl || !targetEl.isConnected) return targetEl;
      const tRect = targetEl.getBoundingClientRect();
      if (tRect.width === 0 && tRect.height === 0) return targetEl;

      const isReasonableContainer = el => {
        if (!el || el === document.body || el === document.documentElement || el.tagName === 'MAIN') return false;
        const cs = getComputedStyle(el);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40) {
          return false;
        }
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (r.height > Math.max(tRect.height + 200, 300)) return false;
        if (r.width > Math.max(tRect.width + 460, tRect.width * 2)) return false;
        return r.width >= tRect.width - 4 && r.height >= tRect.height - 4;
      };

      const anchorSelectors = ds?.targetProfiles?.COMPOSER_ANCHOR_SELECTORS || FALLBACK_COMPOSER_SELECTORS;
      for (const sel of anchorSelectors) {
        const matched = closestAcrossShadow(targetEl, sel);
        if (matched && matched !== targetEl && isReasonableContainer(matched)) {
          return matched;
        }
      }

      let best = targetEl;
      let cur = getParentAcrossShadow(targetEl);
      for (let depth = 0; cur && depth < 6; depth += 1, cur = getParentAcrossShadow(cur)) {
        if (cur === document.body || cur === document.documentElement || cur.tagName === 'MAIN') break;
        if (!isReasonableContainer(cur)) continue;
        const cs = getComputedStyle(cur);
        const hasChrome =
          parseFloat(cs.borderTopWidth) > 0 ||
          parseFloat(cs.borderRadius) >= 8 ||
          (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent');
        if (hasChrome) best = cur;
      }
      return best;
    }

    let targetResizeObserver = null;
    let observedTarget = null;
    let observedAnchor = null;
    let positionRafId = 0;
    let lastStarRender = null;

    function hideFloatingControls() {
      if (positionRafId) {
        cancelAnimationFrame(positionRafId);
        positionRafId = 0;
      }
      lastStarRender = null;
      starBtn.style.display = 'none';
    }

    const reposition = () => {
      if (currentTargetElement && !isModalOpen) positionStarBtn(currentTargetElement);
    };

    function observeTarget(targetEl, anchorEl) {
      const nextTarget = targetEl && targetEl.isConnected ? targetEl : null;
      const nextAnchor = anchorEl && anchorEl.isConnected && anchorEl !== nextTarget ? anchorEl : null;
      if (nextTarget === observedTarget && nextAnchor === observedAnchor) return;
      targetResizeObserver?.disconnect();
      observedTarget = nextTarget;
      observedAnchor = nextAnchor;
      if (!observedTarget || typeof ResizeObserver !== 'function') return;
      try {
        targetResizeObserver ??= new ResizeObserver(reposition);
        targetResizeObserver.observe(observedTarget);
        if (observedAnchor) targetResizeObserver.observe(observedAnchor);
      } catch {}
    }

    function collectControlRects(scanRoot, visRect) {
      if (!scanRoot?.querySelectorAll) return [];
      const rects = [];
      let nodes;
      try {
        nodes = scanRoot.querySelectorAll('button, [role="button"], [type="submit"]');
      } catch {
        return rects;
      }
      for (const el of nodes) {
        if (!isVisibleElement(el) || el === host || host.contains(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.height > 96 || r.width > Math.max(visRect.width * 0.7, 240)) continue;
        rects.push(r);
      }
      return rects;
    }

    function rectOverlapsAny(left, top, size, controlRects, pad = 4) {
      return controlRects.some(r =>
        left < r.right + pad &&
        left + size + pad > r.left &&
        top < r.bottom + pad &&
        top + size + pad > r.top
      );
    }

    function positionStarBtn(targetEl) {
      if (!targetEl || isModalOpen) return;
      // Nothing shows while focus sits in a field we must not serve (a password
      // box, say) — including when a delayed re-scan fires with it focused.
      const active = getDeepActiveElement();
      if (!widgetEnabled || !targetEl.isConnected || !isEligibleField(targetEl) || (isFieldLike(active) && !isEligibleField(active))) {
        hideFloatingControls();
        return;
      }
      const style = getComputedStyle(targetEl);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
        hideFloatingControls();
        return;
      }
      const rect = targetEl.getBoundingClientRect();
      if ((rect.width === 0 && rect.height === 0) ||
          rect.bottom <= 0 ||
          rect.top >= window.innerHeight ||
          rect.right <= 0 ||
          rect.left >= window.innerWidth) {
        hideFloatingControls();
        return;
      }

      const anchorEl = findComposerAnchor(targetEl);
      observeTarget(targetEl, anchorEl);
      const anchorRect = anchorEl && anchorEl !== targetEl && isVisibleElement(anchorEl)
        ? anchorEl.getBoundingClientRect()
        : null;
      const visRect = anchorRect &&
        anchorRect.bottom > 0 &&
        anchorRect.top < window.innerHeight &&
        anchorRect.right > 0 &&
        anchorRect.left < window.innerWidth
        ? anchorRect
        : rect;

      const starSize = 34;
      const clampX = x => Math.round(Math.max(8, Math.min(window.innerWidth - starSize - 8, x)));
      const clampY = y => Math.round(Math.max(8, Math.min(window.innerHeight - starSize - 8, y)));

      const centered = visRect.top + (visRect.height - starSize) / 2;
      const minTop = visRect.top + 4;
      const maxTop = Math.max(minTop, visRect.bottom - starSize - 4);
      const centeredTop = clampY(
        visRect.height <= starSize + 12 ? centered : Math.max(minTop, Math.min(maxTop, centered))
      );
      const insideTop = clampY(
        visRect.height >= 48 ? visRect.top + 8 : visRect.top + (visRect.height - starSize) / 2
      );

      const hasRoomRight = (window.innerWidth - visRect.right) >= starSize + 14;
      const fallbackLeft = hasRoomRight
        ? clampX(visRect.right + 10)
        : clampX(visRect.right - starSize - 8);
      const fallbackTop = hasRoomRight ? centeredTop : insideTop;

      const scanRoot = closestAcrossShadow(anchorEl || targetEl, 'input-area-v2, .input-area, ms-prompt-input, form, fieldset') ||
        anchorEl ||
        getParentAcrossShadow(targetEl);
      const controlRects = collectControlRects(scanRoot, visRect);

      const candidates = [];
      if (hasRoomRight) {
        const rightOutside = clampX(visRect.right + 10);
        candidates.push({ left: rightOutside, top: centeredTop });
        const blockingRight = controlRects.filter(r =>
          rightOutside < r.right + 4 && rightOutside + starSize + 4 > r.left &&
          centeredTop < r.bottom + 4 && centeredTop + starSize + 4 > r.top
        );
        if (blockingRight.length) {
          const clearedRight = Math.round(Math.max(...blockingRight.map(r => r.right)) + 10);
          if (clearedRight <= window.innerWidth - starSize - 8) {
            candidates.push({ left: clearedRight, top: centeredTop });
          }
        }
      }
      const insideRightLeft = clampX(visRect.right - starSize - 8);
      candidates.push({ left: insideRightLeft, top: insideTop });
      if (visRect.top >= starSize + 14) {
        candidates.push({
          left: clampX(visRect.right - starSize),
          top: clampY(visRect.top - starSize - 8)
        });
      }
      let shiftLeft = insideRightLeft;
      for (let i = 0; i < 4; i++) {
        const blocker = controlRects.find(r =>
          shiftLeft < r.right + 4 && shiftLeft + starSize + 4 > r.left &&
          insideTop < r.bottom + 4 && insideTop + starSize + 4 > r.top
        );
        if (!blocker) break;
        const nextLeft = Math.round(blocker.left - starSize - 8);
        if (nextLeft < visRect.left + 8 || nextLeft >= shiftLeft) break;
        shiftLeft = clampX(nextLeft);
        candidates.push({ left: shiftLeft, top: insideTop });
      }

      const chosen = candidates.find(c => !rectOverlapsAny(c.left, c.top, starSize, controlRects)) ||
        { left: fallbackLeft, top: fallbackTop };

      if (
        lastStarRender &&
        lastStarRender.target === targetEl &&
        lastStarRender.top === chosen.top &&
        lastStarRender.left === chosen.left &&
        lastStarRender.display === 'flex' &&
        starBtn.style.display === 'flex'
      ) {
        return;
      }

      if (positionRafId) cancelAnimationFrame(positionRafId);
      positionRafId = requestAnimationFrame(() => {
        positionRafId = 0;
        const activeNow = getDeepActiveElement();
        if (isModalOpen || !widgetEnabled || !targetEl.isConnected || (isFieldLike(activeNow) && !isEligibleField(activeNow))) {
          return;
        }
        starBtn.style.top = `${chosen.top}px`;
        starBtn.style.left = `${chosen.left}px`;
        starBtn.style.display = 'flex';
        lastStarRender = { target: targetEl, top: chosen.top, left: chosen.left, display: 'flex' };
      });
    }

    function getOpenShadowRoots() {
      const roots = [];
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          if (node !== host && node.shadowRoot) roots.push(node.shadowRoot);
        }
      } catch {}
      return roots;
    }

    function findMatchingInputInRoot(rootNode, selectors) {
      for (const selector of selectors) {
        let matches = [];
        try {
          matches = rootNode.querySelectorAll(selector);
        } catch {
          continue;
        }
        for (const el of matches) {
          if (isEligibleField(el) && isVisibleElement(el)) return el;
        }
      }
      return null;
    }

    /** The field the user most plausibly means: the focused one, else the first visible chat-like box. */
    function findChatInput() {
      const focused = fieldFrom(getDeepActiveElement());
      if (focused) return focused;
      const profile = resolveSiteProfile();
      const selectors = ds?.targetProfiles?.getChatInputSelectors
        ? ds.targetProfiles.getChatInputSelectors(profile)
        : FALLBACK_INPUT_SELECTORS;
      const lightMatch = findMatchingInputInRoot(document, selectors);
      if (lightMatch) return lightMatch;
      for (const sr of getOpenShadowRoots()) {
        const shadowMatch = findMatchingInputInRoot(sr, selectors);
        if (shadowMatch) return shadowMatch;
      }
      return null;
    }

    function autoDetectAndPosition() {
      const input = findChatInput();
      if (input) {
        currentTargetElement = input;
        positionStarBtn(input);
      } else {
        hideFloatingControls();
      }
    }

    function syncQuickResetWatchers() {
      if (location.href !== quickState.routeKey) {
        cancelQuickRun({ preserveRevert: false });
        if (quickState.mode !== 'idle') resetQuickState();
        else quickState.routeKey = location.href;
        return;
      }
      if (!isQuickBusy() && quickState.mode !== 'idle') {
        if (!quickState.target?.isConnected || !getElementValue(quickState.target).trim()) {
          resetQuickState();
        }
      }
    }

    function scheduleQuickSubmitResetCheck() {
      if (isQuickBusy() || quickState.mode === 'idle') return;
      const check = () => syncQuickResetWatchers();
      setTimeout(check, 80);
      setTimeout(check, 260);
    }

    /* Pages mutate constantly. Re-scan at most every 250 ms to discover new
       composers or keep the star aligned when SPAs shift layout. */
    let scanTimer = 0;
    function scheduleScan() {
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = 0;
        ensureHost();
        syncQuickResetWatchers();
        if (!currentTargetElement?.isConnected || !isEligibleField(currentTargetElement) || !isVisibleElement(currentTargetElement)) {
          autoDetectAndPosition();
          return;
        }
        if (widgetEnabled && !isModalOpen) {
          const active = getDeepActiveElement();
          const activeInsideCurrent = active === currentTargetElement ||
            (active instanceof Node && currentTargetElement.contains(active));
          if (!activeInsideCurrent) {
            const preferred = findChatInput();
            if (preferred && preferred !== currentTargetElement) {
              currentTargetElement = preferred;
            }
          }
          positionStarBtn(currentTargetElement);
        }
      }, 250);
    }

    try {
      new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    } catch {}

    document.addEventListener('input', e => {
      if (isQuickWriting || isQuickBusy() || quickState.mode === 'idle') return;
      const evtTarget = getDeepEventTarget(e);
      const t = quickState.target;
      if (t && (evtTarget === t || (evtTarget instanceof Element && t.contains(evtTarget)))) {
        if (!getElementValue(t).trim()) resetQuickState();
      }
    }, true);

    document.addEventListener('keydown', e => {
      if (e.isComposing || e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!isQuickBusy() && quickState.mode !== 'idle') {
        const evtTarget = getDeepEventTarget(e);
        const active = getDeepActiveElement();
        const t = quickState.target;
        if (t && (evtTarget === t || active === t || (evtTarget instanceof Element && t.contains(evtTarget)))) {
          scheduleQuickSubmitResetCheck();
        }
      }
    }, true);

    document.addEventListener('focusin', e => {
      syncQuickResetWatchers();
      const evtTarget = getDeepEventTarget(e);
      const el = fieldFrom(evtTarget);
      if (el) {
        if (!isQuickBusy() && quickState.target && el !== quickState.target) resetQuickState();
        currentTargetElement = el;
        positionStarBtn(el);
      } else if (isFieldLike(evtTarget)) {
        // Focus moved into a field we do not serve (a password box): floating
        // controls must not stay pointing at the previous one.
        hideFloatingControls();
      }
    }, true);

    document.addEventListener('click', e => {
      const evtTarget = getDeepEventTarget(e);
      if (evtTarget instanceof Element && !host.contains(evtTarget) && !isQuickBusy() && quickState.mode !== 'idle') {
        if (evtTarget.closest('button, [role="button"], [type="submit"]')) {
          scheduleQuickSubmitResetCheck();
        }
      }
      const el = fieldFrom(evtTarget);
      if (el) {
        if (!isQuickBusy() && quickState.target && el !== quickState.target) resetQuickState();
        currentTargetElement = el;
        positionStarBtn(el);
      }
    }, true);

    /* Remember which field a right-click landed on, so the context menu can open
       the modal on it even when nothing is selected. */
    document.addEventListener('contextmenu', e => {
      lastContextTarget = fieldFrom(getDeepEventTarget(e));
    }, true);

    document.addEventListener('transitionend', e => {
      const evtTarget = getDeepEventTarget(e);
      if (evtTarget instanceof Element && host.contains(evtTarget)) return;
      reposition();
    }, true);

    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('popstate', syncQuickResetWatchers);
    window.addEventListener('hashchange', syncQuickResetWatchers);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.promptcraft_frameworks || changes.promptcraft_settings) renderFrameworkTabs();

      const next = changes.promptcraft_settings?.newValue;
      if (next?.theme) setTheme(next.theme);
      if (next?.preferredEngine) {
        setEngine(next.preferredEngine);
        quickEngineCached = next.preferredEngine;
      }
      if (next && 'quickRepairEnabled' in next) {
        quickRepairCached = next.quickRepairEnabled !== false;
      }
      if (next?.variantCount != null) setVariantCount(next.variantCount);
      if (typeof next?.includePageContext === 'boolean') contextToggle.checked = next.includePageContext;
      if (next && (next.enableFloatingWidget !== false) !== widgetEnabled) {
        widgetEnabled = next.enableFloatingWidget !== false;
        if (widgetEnabled) {
          autoDetectAndPosition();
        } else {
          cancelQuickRun({ preserveRevert: false });
          resetQuickState();
          hideFloatingControls();
        }
      }
    });

    /* Initial state ----------------------------------------------------- */
    (async () => {
      let stored = {};
      try {
        stored = await chrome.storage.local.get(['promptcraft_settings', 'promptcraft_frameworks']);
      } catch {}
      const settings = stored.promptcraft_settings || {};
      widgetEnabled = settings.enableFloatingWidget !== false;
      quickRepairCached = settings.quickRepairEnabled !== false;
      quickEngineCached = settings.preferredEngine || DEFAULT_ENGINE;
      setTheme(settings.theme || 'dark');
      setEngine(quickEngineCached);
      setVariantCount(settings.variantCount);
      contextToggle.checked = Boolean(settings.includePageContext);
      if (settings.preferredFramework) activeFramework = settings.preferredFramework;
      refreshPlatformIdentity();
      await renderFrameworkTabs({ frameworks: stored.promptcraft_frameworks, settings });

      if (widgetEnabled) {
        autoDetectAndPosition();
        setTimeout(autoDetectAndPosition, 800);
        setTimeout(autoDetectAndPosition, 2000);
      }
    })();
  }
})();
