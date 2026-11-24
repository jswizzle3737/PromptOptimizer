/**
 * Reading, writing and finding text fields on the host page, for the in-page
 * panel and star button. Stateless apart from the panel host it must skip.
 *
 * @param {object} cfg
 * @param {HTMLElement} cfg.host        the panel's Shadow DOM host (never a target)
 * @param {ShadowRoot} cfg.shadow
 * @param {object} cfg.targetProfiles  shared/target-profiles.js
 */
export function createEditorDom({ host, shadow, targetProfiles }) {
  const resolveSiteProfile = () => targetProfiles.getTargetProfile(location.hostname);

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

  const normalizeInsertedText = targetProfiles.normalizeEditableText;
  const textsMatchSemantically = targetProfiles.editableTextsMatch;

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
    const selectors = targetProfiles.getChatInputSelectors(profile);
    const lightMatch = findMatchingInputInRoot(document, selectors);
    if (lightMatch) return lightMatch;
    for (const sr of getOpenShadowRoots()) {
      const shadowMatch = findMatchingInputInRoot(sr, selectors);
      if (shadowMatch) return shadowMatch;
    }
    return null;
  }

  return {
    getDeepActiveElement,
    getDeepEventTarget,
    isEligibleField,
    fieldFrom,
    isFieldLike,
    getElementValue,
    normalizeInsertedText,
    textsMatchSemantically,
    insertTextIntoElement,
    isVisibleElement,
    getParentAcrossShadow,
    closestAcrossShadow,
    findChatInput
  };
}
