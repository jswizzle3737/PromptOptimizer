/** Markup of the in-page panel and star button, rendered into its Shadow DOM. */
export function panelTemplate(logoUrl) {
  return `
  <button type="button" class="pc-star-btn" id="pc-star-btn" data-state="idle"
          aria-label="Enhance this prompt (Alt+click: fix typos only)" title="Enhance this prompt (Alt+click: fix typos only)">
    <span data-icon="star" data-icon-size="15"></span>
  </button>

  <div class="pc-backdrop" id="pc-backdrop">
    <div class="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-modal-title">
      <header class="pc-modal__header">
        <div class="pc-modal__brand">
          <img class="pc-modal__logo" src="${logoUrl}" alt="">
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

        <div id="pc-advanced-slot"></div>
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
}
