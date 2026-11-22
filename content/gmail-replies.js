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

  function plainText(fragment) {
    fragment.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    fragment.querySelectorAll('p, div, li').forEach(node => node.append('\n'));
    return fragment.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractThread(pane, limit) {
    const messages = [...pane.querySelectorAll(messageSelector)].filter(isVisible).slice(-4);
    let available = limit;
    const excerpts = [];
    for (const message of messages.reverse()) {
      const copy = message.cloneNode(true);
      copy.querySelectorAll('.gmail_quote, blockquote, [hidden], [aria-hidden="true"]').forEach(node => node.remove());
      const text = plainText(copy);
      if (!text || available <= 0) continue;
      const sender = message.closest('.adn')?.querySelector('.gD')?.textContent.trim();
      const excerpt = (sender ? 'From: ' + sender + '\n' + text : text).slice(0, available);
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

    let notice;
    let job;
    function cancel(message) {
      if (!job || job.cancelled) return;
      job.cancelled = true;
      status.textContent = message;
      job.run?.cancel();
      notice?.hide();
    }
    const cancelIfChanged = () => {
      if (job && !job.isCurrent()) cancel('The conversation or reply changed. Your edits were kept.');
    };
    editor.addEventListener('input', cancelIfChanged);
    mounts.set(editor, {
      host,
      cancelIfChanged,
      remove() {
        cancel('Drafting cancelled.');
        editor.removeEventListener('input', cancelIfChanged);
        host.remove();
      }
    });

    star.addEventListener('click', async event => {
      if (!event.isTrusted) return;
      if (job) { cancel('Drafting cancelled.'); return; }
      const snapshot = editor.innerHTML;
      const route = location.href;
      const pane = readingPane(editor);
      const isCurrent = () => enabled && host.isConnected && editor.isConnected &&
        host.parentNode === editor.parentNode && readingPane(editor) === pane &&
        location.href === route && editor.innerHTML === snapshot;
      const currentJob = { isCurrent, cancelled: false, run: null };
      job = currentJob;
      const canContinue = () => !currentJob.cancelled && isCurrent();
      star.textContent = 'Cancel';
      status.textContent = 'Preparing your reply…';
      try {
        const [{ startRun }, { createSendNotice }, { ENGINE_LABELS }, { EMAIL_LIMITS }] = await modules();
        if (!canContinue()) { cancelIfChanged(); return; }
        const email = pane && extractThread(pane, EMAIL_LIMITS.email);
        if (!email) { status.textContent = 'Open a message and click Reply first.'; return; }
        const notes = plainText(editableRange(editor).range.cloneContents());
        if (notes.length > EMAIL_LIMITS.notes) { status.textContent = 'Shorten the text in the reply box and try again.'; return; }
        notice ??= createSendNotice({ labelForEngine: name => ENGINE_LABELS[name] });
        if (!notice.element.isConnected) wrapper.append(notice.element);
        const sameThread = () => extractThread(pane, EMAIL_LIMITS.email) === email;
        currentJob.run = startRun({ action: 'draft-gmail', email, notes }, {
          onStart: engine => {
            if (canContinue()) status.textContent = 'Drafting with ' + ENGINE_LABELS[engine] + '…';
          },
          async onApproval(details) {
            if (!canContinue() || !sameThread()) return false;
            status.textContent = 'Waiting for approval.';
            return (await notice.ask(details)) && canContinue() && sameThread();
          }
        });
        const reply = await currentJob.run.promise;
        if (currentJob.cancelled) return;
        if (!reply) { status.textContent = 'Drafting cancelled.'; return; }
        if (!canContinue() || !sameThread()) {
          status.textContent = 'The conversation or reply changed. Your edits were kept.';
          return;
        }
        job = null;
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
        if (!currentJob.cancelled) status.textContent = error.message;
      } finally {
        job = null;
        notice?.hide();
        star.textContent = '✦ Draft reply';
      }
    });
  }

  function scan() {
    frame = 0;
    if (!enabled) return;
    for (const [editor, entry] of mounts) {
      if (!editor.isConnected || !entry.host.isConnected || entry.host.parentNode !== editor.parentNode ||
          !editor.matches(editorSelector) || !readingPane(editor) || !isVisible(editor)) {
        entry.remove();
        mounts.delete(editor);
      } else entry.cancelIfChanged();
    }
    for (const editor of document.querySelectorAll(editorSelector)) {
      if (!mounts.has(editor) && readingPane(editor) && isVisible(editor)) mount(editor);
    }
  }

  function scheduleScan() { frame ||= requestAnimationFrame(scan); }
  const observer = new MutationObserver(scheduleScan);
  function setEnabled(active) {
    enabled = active;
    if (active) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable', 'style', 'hidden'] });
      scan();
    } else {
      observer.disconnect();
      cancelAnimationFrame(frame);
      frame = 0;
      for (const entry of mounts.values()) entry.remove();
      mounts.clear();
    }
  }
  let settingsChanged = false;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'OPTIMIZER_SITE_DISABLED' || message.origin !== origin) return;
    settingsChanged = true;
    setEnabled(false);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.promptcraft_sites) {
      settingsChanged = true;
      setEnabled((changes.promptcraft_sites.newValue || []).includes(origin));
    }
  });
  window.addEventListener('hashchange', scheduleScan);
  window.addEventListener('popstate', scheduleScan);
  chrome.storage.local.get('promptcraft_sites').then(data => {
    if (!settingsChanged) setEnabled((data.promptcraft_sites || []).includes(origin));
  }).catch(() => {});
})();
