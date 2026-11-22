(() => {
  if (window.__promptOptimizerGmail) return;
  window.__promptOptimizerGmail = true;

  const editorSelector = '[contenteditable="true"][role="textbox"][g_editable="true"], .editable[contenteditable="true"][role="textbox"]';
  const messageSelector = '.adn .a3s';
  const protectedSelector = '.gmail_quote, .gmail_signature, [data-smartmail="gmail_signature"]';
  const origin = location.origin;
  const mounts = new Map();
  const url = file => chrome.runtime.getURL(file);
  let enabled = false;
  let frame = 0;

  function readingPane(editor) {
    return editor.closest('[role="dialog"]') ? null : editor.closest('[role="main"]');
  }

  function isVisible(node) {
    return node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
  }

  function extractThread(pane, limit) {
    const messages = [...pane.querySelectorAll(messageSelector)].filter(isVisible).slice(-4);
    let available = limit;
    const excerpts = [];
    for (const message of messages.reverse()) {
      const copy = message.cloneNode(true);
      copy.querySelectorAll('.gmail_quote, blockquote, [hidden], [aria-hidden="true"]').forEach(node => node.remove());
      copy.querySelectorAll('br, p, div, li').forEach(node => node.append('\n'));
      const text = copy.textContent.trim();
      if (!text || available <= 0) continue;
      const excerpt = text.slice(0, available);
      excerpts.unshift(excerpt);
      available -= excerpt.length + 2;
    }
    return excerpts.join('\n\n');
  }

  function editableRange(editor) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const protectedBlock = editor.querySelector(protectedSelector);
    if (protectedBlock) range.setEndBefore(protectedBlock);
    return { range, protectedBlock };
  }

  const modules = () => Promise.all([
    import(url('shared/run-client.js')),
    import(url('shared/assist.js')),
    import(url('shared/engines.js')),
    import(url('shared/email-draft.js'))
  ]);

  function mount(editor) {
    const host = document.createElement('div');
    host.dataset.promptoptimizerGmail = '';
    const shadow = host.attachShadow({ mode: 'open' });
    for (const file of ['theme.css', 'base.css', 'components.css']) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url('shared/' + file);
      shadow.append(link);
    }
    const style = document.createElement('style');
    style.textContent = [
      '.gmail-reply { margin: 4px 0; font-family: var(--font-sans); }',
      '.gmail-reply__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.gmail-reply__button { font: inherit; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 999px; padding: 4px 10px; cursor: pointer; }',
      '.gmail-reply__status { color: var(--text-primary); background: var(--bg-surface); border-radius: 4px; font-size: 12px; padding: 3px 6px; }',
      '.gmail-reply__status:empty { display: none; }'
    ].join('\n');
    shadow.append(style);
    const wrapper = document.createElement('div');
    wrapper.className = 'gmail-reply';
    wrapper.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const row = document.createElement('div');
    row.className = 'gmail-reply__row';
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'gmail-reply__button';
    star.textContent = '✦ Draft reply';
    star.title = 'Draft a reply with PromptOptimizer';
    const status = document.createElement('span');
    status.className = 'gmail-reply__status';
    status.setAttribute('role', 'status');
    row.append(star, status);
    wrapper.append(row);
    shadow.append(wrapper);
    editor.before(host);

    let run;
    let notice;
    let preparing = false;
    const abort = () => {
      notice?.hide();
      run?.cancel();
    };
    mounts.set(editor, { host, abort });

    star.addEventListener('click', async event => {
      if (!event.isTrusted) return;
      if (run) { abort(); return; }
      if (preparing) return;
      preparing = true;
      const snapshot = editor.innerHTML;
      const route = location.href;
      const stillCurrent = () => enabled && host.isConnected && editor.isConnected &&
        location.href === route && editor.innerHTML === snapshot;
      try {
        const [{ startRun }, { createSendNotice }, { ENGINE_LABELS }, { EMAIL_LIMITS }] = await modules();
        if (!stillCurrent()) return;
        const pane = readingPane(editor);
        const email = pane && extractThread(pane, EMAIL_LIMITS.email);
        if (!email) { status.textContent = 'Open a message and click Reply first.'; return; }
        const notes = editableRange(editor).range.cloneContents().textContent.trim();
        if (notes.length > EMAIL_LIMITS.notes) { status.textContent = 'Shorten the text in the reply box and try again.'; return; }
        notice ??= createSendNotice({ labelForEngine: name => ENGINE_LABELS[name] });
        wrapper.append(notice.element);
        star.textContent = 'Cancel';
        status.textContent = 'Preparing your reply…';
        run = startRun({ action: 'draft-gmail', email, notes }, {
          onStart: engine => { status.textContent = 'Drafting with ' + ENGINE_LABELS[engine] + '…'; },
          async onApproval(details) {
            if (!stillCurrent() || extractThread(pane, EMAIL_LIMITS.email) !== email) return false;
            status.textContent = 'Waiting for approval.';
            return (await notice.ask(details)) && stillCurrent() && extractThread(pane, EMAIL_LIMITS.email) === email;
          }
        });
        const reply = await run.promise;
        if (!reply) { status.textContent = 'Drafting cancelled.'; return; }
        if (!stillCurrent() || extractThread(pane, EMAIL_LIMITS.email) !== email) {
          status.textContent = 'The conversation or reply changed. Your edit was kept.';
          return;
        }
        const { range, protectedBlock } = editableRange(editor);
        editor.focus({ preventScroll: true });
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const text = protectedBlock ? reply.draft + '\n\n' : reply.draft;
        const inserted = document.execCommand('insertText', false, text);
        if (!inserted) {
          status.textContent = 'Gmail could not insert the reply.';
        } else {
          status.textContent = reply.truncated ? 'The draft was cut off. Review it before sending.' : 'Reply drafted. Review it before sending.';
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        run = null;
        preparing = false;
        notice?.hide();
        star.textContent = '✦ Draft reply';
      }
    });
  }

  function scan() {
    frame = 0;
    if (!enabled) return;
    for (const [editor, entry] of mounts) {
      if (!editor.isConnected || !entry.host.isConnected) {
        entry.abort();
        entry.host.remove();
        mounts.delete(editor);
      }
    }
    for (const editor of document.querySelectorAll(editorSelector)) {
      if (!mounts.has(editor) && readingPane(editor) && isVisible(editor)) mount(editor);
    }
  }

  const observer = new MutationObserver(() => { frame ||= requestAnimationFrame(scan); });
  function setEnabled(active) {
    enabled = active;
    if (active) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable', 'style', 'hidden'] });
      scan();
    } else {
      observer.disconnect();
      cancelAnimationFrame(frame);
      frame = 0;
      for (const { host, abort } of mounts.values()) { abort(); host.remove(); }
      mounts.clear();
    }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'OPTIMIZER_SITE_DISABLED' && message.origin === origin) setEnabled(false);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.promptcraft_sites) {
      setEnabled((changes.promptcraft_sites.newValue || []).includes(origin));
    }
  });
  chrome.storage.local.get('promptcraft_sites').then(data => setEnabled((data.promptcraft_sites || []).includes(origin)));
})();
