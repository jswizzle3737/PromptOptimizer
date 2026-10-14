/**
 * PromptOptimizer In-Page Content Script
 *
 * Injects a floating trigger pill and a Shadow DOM optimizer modal into AI chat
 * platforms (ChatGPT, Claude, Gemini, Perplexity, …).
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

    .pc-trigger-pill {
      position: fixed;
      pointer-events: auto;
      display: none;
      align-items: center;
      gap: 7px;
      height: 28px;
      padding: 0 12px;
      background: var(--bg-raised);
      color: var(--text-primary);
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-full);
      box-shadow: var(--shadow-2);
      cursor: pointer;
      user-select: none;
      z-index: 2147483646;
      transition:
        background-color var(--dur-fast) var(--ease-standard),
        border-color var(--dur-fast) var(--ease-standard),
        transform var(--dur-fast) var(--ease-standard),
        box-shadow var(--dur-fast) var(--ease-standard);
    }
    .pc-trigger-pill:hover {
      background: var(--bg-hover);
      border-color: var(--accent-border);
      transform: translateY(-1px);
      box-shadow: var(--shadow-accent);
    }
    .pc-trigger-pill:active { transform: translateY(0); }
    .pc-trigger-pill svg { color: var(--accent-fg); }

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
      const [icons, select, themePicker, engines, saveSheet, library, runClient, assist, secrets, clarify] = await Promise.all([
        import(SHARED + 'icons.js'),
        import(SHARED + 'select.js'),
        import(SHARED + 'theme-picker.js'),
        import(SHARED + 'engines.js'),
        import(SHARED + 'save-sheet.js'),
        import(SHARED + 'library.js'),
        import(SHARED + 'run-client.js'),
        import(SHARED + 'assist.js'),
        import(SHARED + 'secrets.js'),
        import(SHARED + 'clarify.js')
      ]);
      return { icons, select, themePicker, engines, saveSheet, library, runClient, assist, secrets, clarify };
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
    <button type="button" class="pc-trigger-pill" id="pc-trigger">
      <span data-icon="wand" data-icon-size="13"></span>
      <span>Optimize</span>
    </button>

    <div class="pc-backdrop" id="pc-backdrop">
      <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-modal-title">
        <header class="pc-modal__header">
          <div class="pc-modal__brand">
            <img class="pc-modal__logo" src="${LOGO_URL}" alt="">
            <div>
              <div class="pc-modal__title" id="pc-modal-title">PromptOptimizer</div>
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
              </div>
            </div>
            <div class="pc-modal__outbox">
              <div class="pc-empty" id="pc-placeholder">
                <span class="pc-empty__icon" data-icon="wand" data-icon-size="16"></span>
                <span class="pc-empty__title">No output yet</span>
                <span class="pc-empty__desc">Choose a framework, then press Optimize.</span>
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

    const trigger = $('#pc-trigger');
    const backdrop = $('#pc-backdrop');
    const modal = $('.pc-modal');
    const closeBtn = $('#pc-close-btn');
    const tabsContainer = $('#pc-tabs');
    const themeSlot = $('#pc-theme-slot');
    const engineSlot = $('#pc-engine-slot');
    const rawInput = $('#pc-raw-input');
    const charCount = $('#pc-char-count');
    const optimizeBtn = $('#pc-optimize-btn');
    const resultText = $('#pc-result-text');
    const placeholder = $('#pc-placeholder');
    const engineBadge = $('#pc-engine-badge');
    const degradedNotice = $('#pc-degraded');
    const degradedTitle = $('#pc-degraded-title');
    const degradedReason = $('#pc-degraded-reason');
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

    let activeFramework = 'smart-expand';
    let latest = '';
    let busy = false;
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

    /* Fields the pill and the modal may attach to or read from. Anything that
       can hold a credential is excluded: the modal copies a field's value into
       a box that can be sent to a cloud engine. */
    const SENSITIVE_HINT = /(^|[^a-z])(pass(word|wd)?|otp|cvv|cvc|ccnum|ssn)([^a-z]|$)/i;
    const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|current-password|new-password|one-time-code)(\s|$)/i;
    const FIELD_SELECTOR = 'textarea, input, [contenteditable]:not([contenteditable="false"])';

    function isEligibleField(el) {
      if (!el || el.nodeType !== 1 || el === host || host.contains(el)) return false;
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
    }

    const ICON = (name, size = 14) => (ds?.icons ? ds.icons.icon(name, { size }) : '');

    /* Toast ------------------------------------------------------------ */
    let toastTimer;
    function toast(msg, tone = 'neutral') {
      const glyph = { success: 'check', danger: 'alert', neutral: 'info' }[tone] || 'info';
      toastEl.innerHTML = `${ICON(glyph, 13)}<span>${escapeHtml(msg)}</span>`;
      toastEl.classList.add('is-visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2400);
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
      sel.addEventListener('change', () => { engine = sel.value; });
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
      getSettings().then(s => setVariantCount(s.variantCount)).catch(() => {});
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
    async function renderFrameworkTabs() {
      let frameworks = FALLBACK_FRAMEWORKS;
      let settings = {};
      try {
        const stored = await chrome.storage.local.get(['promptcraft_frameworks', 'promptcraft_settings']);
        if (Array.isArray(stored.promptcraft_frameworks) && stored.promptcraft_frameworks.length) {
          frameworks = stored.promptcraft_frameworks;
        }
        settings = stored.promptcraft_settings || {};
      } catch {}

      if (!frameworks.some(f => f.id === activeFramework)) {
        activeFramework = settings.preferredFramework || frameworks[0]?.id || 'smart-expand';
      }
      if (!frameworks.some(f => f.id === activeFramework)) {
        activeFramework = frameworks[0]?.id;
      }

      tabsContainer.innerHTML = '';
      frameworks.forEach(fw => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'pc-segmented__item';
        tab.setAttribute('role', 'tab');
        tab.dataset.framework = fw.id;
        tab.setAttribute('aria-selected', String(fw.id === activeFramework));
        tab.title = fw.tagline || fw.name;
        tab.innerHTML =
          `<span class="pc-segmented__icon">${ICON(fw.icon, 13)}</span>` +
          `<span>${escapeHtml(fw.name)}</span>`;
        tabsContainer.appendChild(tab);
      });
    }

    tabsContainer.addEventListener('click', e => {
      const tab = e.target.closest('.pc-segmented__item');
      if (!tab) return;
      tabsContainer.querySelectorAll('.pc-segmented__item')
        .forEach(t => t.setAttribute('aria-selected', 'false'));
      tab.setAttribute('aria-selected', 'true');
      activeFramework = tab.dataset.framework;
      if (rawInput.value.trim() && latest) runOptimization();
    });

    /* Open / close ----------------------------------------------------- */
    async function openModal(initialText = '', autoRun = false, { fromContextMenu = false } = {}) {
      // Capture where focus was before the modal takes it, to hand it back on close.
      const active = document.activeElement;
      returnFocusTo = (isFieldLike(active) ? active : null) || currentTargetElement || active;

      isModalOpen = true;
      backdrop.classList.add('is-open');
      trigger.style.display = 'none';

      const settings = await getSettings();
      setTheme(settings.theme || 'dark');
      setEngine(settings.preferredEngine || DEFAULT_ENGINE);
      await renderFrameworkTabs();

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

    function closeModal() {
      saveSheet?.close();
      libraryPicker?.close();
      isModalOpen = false;
      backdrop.classList.remove('is-open');
      if (returnFocusTo?.isConnected) returnFocusTo.focus?.({ preventScroll: true });
      returnFocusTo = null;
    }

    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) closeModal();
    });

    /* Keyboard inside the dialog: Escape closes, Tab stays within it. Handled on
       the dialog rather than the window so the page never sees these keys. */
    const FOCUSABLE = 'button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
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

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      openModal(window.getSelection().toString().trim());
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
      resultActions?.update({ ...actionState(), busy: next });
    }

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
          latest = variant.text;
          resultText.textContent = latest;
          renderVariantChips();
          renderQualityChip({ before: scoreBefore(), after: variant.score, method: 'rules' }, lastOriginal);
        });
        variantChips.appendChild(btn);
      });
      variantChips.hidden = false;
    }

    /* The "before" half of the quality chip; kept across variant switches. */
    function scoreBefore() {
      const m = qualityChip.textContent.match(/Quality (\d+)/);
      return m ? parseInt(m[1], 10) : null;
    }

    /* Refine / Continue under the result. Only for model output: a template
       of a rewrite is not a refinement. */
    function actionState() {
      return {
        visible: Boolean(latest && lastData),
        truncated: Boolean(lastData?.truncated),
        canRefine: Boolean(lastData && lastData.engine !== 'offline')
      };
    }

    const resultActions = ds?.assist && ds?.runClient
      ? ds.assist.createResultActions({
        onRefine: kind => runRequest({ action: 'refine', kind, previous: latest, text: lastOriginal }),
        onContinue: () => runRequest(
          { action: 'refine', kind: 'continue', previous: latest, text: lastOriginal },
          { base: latest }
        )
      })
      : null;
    if (resultActions) actionsSlot.appendChild(resultActions.element);

    function applyResult(data, original) {
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
        degradedTitle.textContent = `${requested} unavailable — offline template used`;
        degradedReason.textContent = data.degradedReason
          ? `${data.degradedReason} The output below is a local template, not a model response. Add an API key in the toolbar popup or Options for real rewrites.`
          : 'The output below is a local template, not a model response.';
        degradedNotice.hidden = false;
        setStatus('Offline fallback', 'warning');
        toast('Fell back to the offline template', 'danger');
      } else if (data.fallbackReason) {
        /* Another configured provider answered for the chosen one. */
        const requested = ENGINE_LABELS[data.requestedEngine] || data.requestedEngine;
        const used = ENGINE_LABELS[data.engine] || data.engine;
        engineBadge.title = `${requested} failed: ${data.fallbackReason}`;
        setStatus(`Used ${used}`, 'warning');
        toast(`${requested} unavailable, used ${used}`, 'neutral');
      } else if (data.truncated) {
        engineBadge.title = '';
        setStatus('Cut off', 'warning');
        toast('The output was cut off. Press Continue to finish it.', 'neutral');
      } else {
        engineBadge.title = '';
        setStatus('Done', 'success');
        toast(data.refinement ? 'Prompt refined' : 'Prompt optimized', 'success');
      }
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
      const previous = { latest, data: lastData };
      setBusy(true);
      saveSheet?.close(); // the result it was about is being replaced
      clarifySheet?.close();
      secretNotice?.hide();
      setStatus(isOptimize ? 'Optimizing…' : 'Refining…', 'neutral');
      degradedNotice.hidden = true;
      techChips.hidden = true;
      qualityChip.hidden = true;
      variantChips.hidden = true;
      resultActions?.update({ visible: false });
      if (isOptimize) {
        currentVariants = [];
        if (!base) { resultText.hidden = true; placeholder.hidden = false; }
      }

      let streamed = base;
      const paint = text => {
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
            onStart: name => {
              streamed = base;
              setStatus(`${ENGINE_LABELS[name] || name}…`, 'neutral');
              if (base) paint(base);
            },
            onToken: delta => {
              streamed += delta;
              paint(streamed);
            }
          });
          data = await currentRun.promise;
        } else {
          data = await sendOnce(full);
        }

        if (!data) {
          // Cancelled: put back whatever was on screen before.
          latest = previous.latest;
          lastData = previous.data;
          if (latest) { resultText.textContent = latest; resultText.hidden = false; placeholder.hidden = true; }
          else { resultText.hidden = true; placeholder.hidden = false; }
          setStatus('Cancelled', 'neutral');
          return;
        }
        applyResult(data, isOptimize ? payload.text : lastOriginal);
      } catch (err) {
        if (isOptimize) {
          degradedNotice.hidden = true;
          resultText.hidden = true;
          placeholder.hidden = false;
          placeholder.innerHTML = `
            <span class="pc-empty__icon">${ICON('alert', 16)}</span>
            <span class="pc-empty__title">Optimization failed</span>
            <span class="pc-empty__desc">${escapeHtml(err.message)}</span>`;
        } else if (previous.latest) {
          // A failed refinement leaves the result it was refining untouched.
          resultText.textContent = previous.latest;
          resultText.hidden = false;
        }
        setStatus('Failed', 'danger');
        toast(err.message, 'danger');
      } finally {
        resultText.classList.remove('is-streaming');
        currentRun = null;
        setBusy(false);
        resultActions?.update(actionState());
      }
    }

    /** Title, address (no query string) and any selection other than the draft. */
    function pageContext(draft) {
      if (!contextToggle.checked) return '';
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
    getSettings().then(s => { contextToggle.checked = Boolean(s.includePageContext); }).catch(() => {});
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
      const valid = currentTargetElement?.isConnected && isEligibleField(currentTargetElement)
        ? currentTargetElement
        : null;

      if (insertTextIntoElement(valid, latest)) {
        insertBtn.innerHTML = `${ICON('check', 13)}<span>Inserted</span>`;
        toast('Inserted into chat', 'success');
        setTimeout(() => {
          closeModal();
          insertBtn.innerHTML = `${ICON('insert', 13)}<span>Insert</span>`;
        }, 350);
      } else {
        navigator.clipboard.writeText(latest);
        toast('Could not insert — copied instead', 'danger');
      }
    });

    /* Element helpers -------------------------------------------------- */
    function getElementValue(el) {
      if (!isEligibleField(el)) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
      if (el.isContentEditable) return el.innerText || el.textContent;
      return '';
    }

    function insertTextIntoElement(el, text) {
      if (!isEligibleField(el)) el = findChatInput();
      if (!el) return false;

      el.focus();

      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        try {
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
        } catch {}
        el.value = text;
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
        // execCommand is tracked by ProseMirror / Lexical / Quill undo stacks.
        const ok = document.execCommand('insertText', false, text);
        if (!ok) {
          el.innerText = text;
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertReplacementText'
          }));
        }
        return true;
      }

      return false;
    }

    /* Trigger positioning ---------------------------------------------- */
    function positionTrigger(targetEl) {
      if (!targetEl || isModalOpen) return;
      // Nothing shows while focus sits in a field we must not serve (a password
      // box, say) — including when a delayed re-scan fires with it focused.
      const active = document.activeElement;
      if (!widgetEnabled || (isFieldLike(active) && !isEligibleField(active))) {
        trigger.style.display = 'none';
        return;
      }
      const rect = targetEl.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const top = Math.max(10, rect.top - 36);
      const left = Math.min(window.innerWidth - 140, Math.max(10, rect.right - 132));

      requestAnimationFrame(() => {
        trigger.style.top = `${top}px`;
        trigger.style.left = `${left}px`;
        trigger.style.display = 'flex';
      });
    }

    /** The field the user most plausibly means: the focused one, else the first chat-like box. */
    function findChatInput() {
      const focused = fieldFrom(document.activeElement);
      if (focused) return focused;
      for (const selector of ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea']) {
        const el = document.querySelector(selector);
        if (isEligibleField(el)) return el;
      }
      return null;
    }

    function autoDetectAndPosition() {
      const input = findChatInput();
      if (input) {
        currentTargetElement = input;
        positionTrigger(input);
      }
    }

    /* Pages mutate constantly. Re-scan at most every 400 ms, and only when the
       field we were tracking is gone. */
    let scanTimer = 0;
    function scheduleScan() {
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = 0;
        ensureHost();
        if (!currentTargetElement?.isConnected) autoDetectAndPosition();
      }, 400);
    }

    try {
      new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    } catch {}

    document.addEventListener('focusin', e => {
      const el = fieldFrom(e.target);
      if (el) {
        currentTargetElement = el;
        positionTrigger(el);
      } else if (isFieldLike(e.target)) {
        // Focus moved into a field we do not serve (a password box): the pill
        // must not stay pointing at the previous one.
        trigger.style.display = 'none';
      }
    }, true);

    document.addEventListener('click', e => {
      const el = fieldFrom(e.target);
      if (el) {
        currentTargetElement = el;
        positionTrigger(el);
      }
    }, true);

    /* Remember which field a right-click landed on, so the context menu can open
       the modal on it even when nothing is selected. */
    document.addEventListener('contextmenu', e => {
      lastContextTarget = fieldFrom(e.target);
    }, true);

    const reposition = () => {
      if (currentTargetElement && !isModalOpen) positionTrigger(currentTargetElement);
    };
    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition, { passive: true });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.promptcraft_frameworks || changes.promptcraft_settings) renderFrameworkTabs();

      const next = changes.promptcraft_settings?.newValue;
      if (next?.theme) setTheme(next.theme);
      if (next?.preferredEngine) setEngine(next.preferredEngine);
      if (next && (next.enableFloatingWidget !== false) !== widgetEnabled) {
        widgetEnabled = next.enableFloatingWidget !== false;
        if (widgetEnabled) autoDetectAndPosition();
        else trigger.style.display = 'none';
      }
    });

    /* Initial state ----------------------------------------------------- */
    (async () => {
      const settings = await getSettings();
      widgetEnabled = settings.enableFloatingWidget !== false;
      setTheme(settings.theme || 'dark');
      setEngine(settings.preferredEngine || DEFAULT_ENGINE);
      if (settings.preferredFramework) activeFramework = settings.preferredFramework;
      await renderFrameworkTabs();

      if (widgetEnabled) {
        autoDetectAndPosition();
        setTimeout(autoDetectAndPosition, 800);
        setTimeout(autoDetectAndPosition, 2000);
      }
    })();
  }
})();
