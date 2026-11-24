/**
 * Gmail tools. Runs only on https://mail.google.com after the user turns it on
 * from the toolbar popup. Above each reply box, Compose window and popped-out
 * reply it adds:
 *   ✦ Draft reply / ✦ Write email — writes into the box (box text = notes/brief)
 *   Polish    — rewrites the box text in the saved style
 *   Revise    — Shorter / More formal / Friendlier / a typed change
 *   Summarize — key points, asks and deadlines of the open conversation (replies only)
 * Results replace the box text above the quote/signature with insertText, so
 * Ctrl+Z restores the previous text. The worker adds the saved writing style;
 * this script never sees it or any API key.
 */
(() => {
  if (window.__promptOptimizerGmail) return;
  window.__promptOptimizerGmail = true;

  const editorSelector = '[contenteditable="true"][role="textbox"][g_editable="true"], .editable[contenteditable="true"][role="textbox"]';
  const messageSelector = '.adn .a3s';
  const protectedSelector = '.gmail_quote, .gmail_signature, [data-smartmail="gmail_signature"]';
  const subjectSelector = 'input[name="subjectbox"]';
  const origin = location.origin;
  const mounts = new Map();
  const url = file => chrome.runtime.getURL(file);
  let enabled = false;
  let frame = 0;

  const VERBS = { reply: 'Drafting', compose: 'Writing', polish: 'Polishing', revise: 'Revising', summary: 'Summarizing' };

  function isVisible(node) {
    return node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
  }

  const hasThread = root => Boolean(root) && [...root.querySelectorAll(messageSelector)].some(isVisible);
  const REPLY_SUBJECT = /^\s*(re|fwd?|aw|sv|vs|tr)\s*:/i;

  /**
   * Where an editor lives. Inline replies sit in the reading pane. A dialog is a
   * popped-out reply or forward when its subject is hidden, or reads "Re:"/"Fwd:"
   * with the conversation still open behind it; otherwise it is a new email.
   */
  function contextOf(editor) {
    const dialog = editor.closest('[role="dialog"]');
    if (!dialog) {
      const pane = editor.closest('[role="main"]');
      return pane ? { kind: 'reply', box: pane, threadRoot: pane, subject: null } : null;
    }
    const main = document.querySelector('[role="main"]');
    const subject = dialog.querySelector(subjectSelector);
    if (subject && isVisible(subject) && !(REPLY_SUBJECT.test(subject.value) && hasThread(main))) {
      return { kind: 'compose', box: dialog, threadRoot: null, subject };
    }
    return { kind: 'reply', box: dialog, threadRoot: main, subject: null };
  }

  /** Light or dark from the background Gmail actually paints behind the box. */
  function pageIsDark(node) {
    for (let element = node; element instanceof Element; element = element.parentElement) {
      const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (channels && (channels.length < 4 || channels[3] > 0.5)) {
        const [r, g, b] = channels;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
      }
    }
    // Nothing painted: the browser's canvas shows, white unless the page opts into dark.
    return /^dark$|^only dark/.test(getComputedStyle(document.documentElement).colorScheme.trim()) &&
      matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /** "PromptOptimizer was reloaded" reads better than Chrome's internal wording. */
  function friendlyError(error) {
    const message = String(error?.message || error);
    return /context invalidated|receiving end does not exist|could not establish connection|dynamically imported module/i.test(message)
      ? 'PromptOptimizer was updated or reloaded. Refresh Gmail to keep using it.'
      : message;
  }

  function plainText(fragment) {
    fragment.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    fragment.querySelectorAll('p, div, li').forEach(node => node.append('\n'));
    return fragment.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** The last few visible messages, newest kept first when trimming to `limit`. */
  function extractThread(root, limit) {
    if (!root) return '';
    const messages = [...root.querySelectorAll(messageSelector)].filter(isVisible).slice(-4);
    let available = limit;
    const excerpts = [];
    for (const message of messages.reverse()) {
      const copy = message.cloneNode(true);
      copy.querySelectorAll('.gmail_quote, blockquote, [hidden], [aria-hidden="true"]').forEach(node => node.remove());
      const text = plainText(copy);
      if (!text || available <= 0) continue;
      // Sender name and sent date let the model place "Friday" or "tomorrow".
      const header = message.closest('.adn');
      const sender = header?.querySelector('.gD')?.textContent.trim();
      const sent = header?.querySelector('.g3')?.getAttribute('title')?.trim();
      const lines = [sender && 'From: ' + sender, sent && 'Sent: ' + sent].filter(Boolean);
      const excerpt = [...lines, text].join('\n').slice(0, available);
      excerpts.unshift(excerpt);
      available -= excerpt.length + 2;
    }
    return excerpts.join('\n\n');
  }

  /** The user's part of the box: everything before the quote or signature. */
  function editableRange(editor) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const protectedBlock = editor.querySelector(protectedSelector);
    if (protectedBlock) range.setEndBefore(protectedBlock);
    return { range, protectedBlock };
  }

  /* Set while this script edits a box, so its own input events are not taken
     for the user's typing. execCommand fires them synchronously. */
  let editing = false;
  function edit(command) {
    editing = true;
    try { return command(); } finally { editing = false; }
  }

  function replaceBoxText(editor, text) {
    const { range, protectedBlock } = editableRange(editor);
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // insertText keeps Gmail's undo stack and draft autosave working.
    return edit(() => document.execCommand('insertText', false, protectedBlock ? text + '\n\n' : text));
  }

  let modulesPromise = null;
  const modules = () => modulesPromise ??= Promise.all([
    import(url('shared/run-client.js')),
    import(url('shared/assist.js')),
    import(url('shared/engines.js')),
    import(url('shared/email-draft.js'))
  ]).catch(error => { modulesPromise = null; throw error; });

  const STYLE = `
    .gmail-reply { margin: 4px 0; font-family: var(--font-sans); font-size: 13px; color: var(--text-primary); }
    .gmail-reply__row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .gmail-reply__row + .gmail-reply__row, .gmail-reply__panel { margin-top: 6px; }
    .gmail-reply__button { font: inherit; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
    .gmail-reply__button:disabled { opacity: .5; cursor: default; }
    .gmail-reply__button[aria-expanded="true"] { border-color: var(--text-primary); }
    .gmail-reply__input { font: inherit; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 3px 8px; min-width: 0; flex: 1 1 160px; max-width: 320px; }
    .gmail-reply__status { background: var(--bg-surface); border-radius: 4px; font-size: 12px; padding: 3px 6px; }
    .gmail-reply__status:empty { display: none; }
    .gmail-reply__panel { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 8px 10px; max-width: 640px; }
    .gmail-reply__panel h3 { font: inherit; font-weight: 600; margin: 0 0 4px; }
    .gmail-reply__summary { max-height: 240px; overflow: auto; margin: 0 0 6px; }
    .gmail-reply__summary h4 { font: inherit; font-weight: 600; margin: 6px 0 2px; }
    .gmail-reply__summary h4:first-child { margin-top: 0; }
    .gmail-reply__summary ul { margin: 0; padding-left: 18px; list-style: disc; }
    .gmail-reply__summary p { margin: 0; white-space: pre-wrap; }
    /* The notice's tint is translucent; give it the theme's surface, not Gmail's page, behind it. */
    .gmail-reply__notice { background: var(--bg-surface); border-radius: 8px; max-width: 640px; margin-top: 6px; }
    .gmail-reply__notice:not(:has(> :not([hidden]))) { display: none; }
    [hidden] { display: none !important; }
  `;

  function button(label, title) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'gmail-reply__button';
    element.textContent = label;
    if (title) element.title = title;
    return element;
  }

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
    style.textContent = STYLE;
    shadow.append(style);
    const wrapper = document.createElement('div');
    wrapper.className = 'gmail-reply';

    // Main row
    const primary = button('');
    const polish = button('Polish', 'Rewrite the text in the box in your writing style');
    const reviseToggle = button('Revise', 'Change the text in the box');
    reviseToggle.setAttribute('aria-expanded', 'false');
    const summarize = button('Summarize', 'Summarize this conversation');
    const status = document.createElement('span');
    status.className = 'gmail-reply__status';
    status.setAttribute('role', 'status');
    const undo = button('Undo', 'Put back the text that was in the box');
    undo.hidden = true;
    const mainRow = document.createElement('div');
    mainRow.className = 'gmail-reply__row';
    mainRow.append(primary, polish, reviseToggle, summarize, status, undo);

    // Revise row
    const reviseRow = document.createElement('div');
    reviseRow.className = 'gmail-reply__row';
    reviseRow.setAttribute('role', 'group');
    reviseRow.setAttribute('aria-label', 'Revise the text in the box');
    reviseRow.hidden = true;
    const presets = [['shorter', 'Shorter'], ['formal', 'More formal'], ['friendly', 'Friendlier']]
      .map(([revision, label]) => ({ revision, element: button(label) }));
    const changeInput = document.createElement('input');
    changeInput.type = 'text';
    changeInput.className = 'gmail-reply__input';
    changeInput.placeholder = 'Other change, e.g. say no politely';
    changeInput.setAttribute('aria-label', 'Describe another change');
    const apply = button('Apply');
    const closeRevise = button('✕', 'Close revise options');
    closeRevise.setAttribute('aria-label', 'Close revise options');
    reviseRow.append(...presets.map(preset => preset.element), changeInput, apply, closeRevise);

    // Summary panel
    const panel = document.createElement('section');
    panel.className = 'gmail-reply__panel';
    panel.hidden = true;
    const panelTitle = document.createElement('h3');
    panelTitle.textContent = 'Conversation summary';
    const summaryText = document.createElement('div');
    summaryText.className = 'gmail-reply__summary';
    summaryText.tabIndex = 0;
    const copySummary = button('Copy');
    const closeSummary = button('Close');
    const panelRow = document.createElement('div');
    panelRow.className = 'gmail-reply__row';
    panelRow.append(copySummary, closeSummary);
    panel.append(panelTitle, summaryText, panelRow);

    const noticeSlot = document.createElement('div');
    noticeSlot.className = 'gmail-reply__notice';
    wrapper.append(mainRow, noticeSlot, reviseRow, panel);
    shadow.append(wrapper);
    editor.before(host);

    // Gmail's single-key shortcuts listen on the document: keep typing here private.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      changeInput.addEventListener(type, event => event.stopPropagation());
    }
    changeInput.maxLength = 300;

    const actions = [primary, polish, reviseToggle, summarize, ...presets.map(preset => preset.element), apply];
    const labels = new Map(actions.map(element => [element, element.textContent]));
    let notice;
    let job = null;
    let lastSummary = '';

    function setBusy(trigger) {
      for (const element of actions) {
        element.disabled = Boolean(trigger) && element !== trigger;
        element.textContent = element === trigger ? 'Cancel' : labels.get(element);
      }
      changeInput.disabled = Boolean(trigger);
      if (trigger) undo.hidden = true;
    }

    /** Follow Gmail's theme and whether this box is a reply or a new email. */
    function refresh() {
      const theme = pageIsDark(editor) ? 'dark' : 'light';
      if (wrapper.dataset.theme !== theme) wrapper.dataset.theme = theme;
      const composing = contextOf(editor)?.kind === 'compose';
      const label = composing ? '✦ Write email' : '✦ Draft reply';
      if (labels.get(primary) === label) return;
      labels.set(primary, label);
      primary.title = composing ? 'Write this email from the text in the box' : 'Draft a reply to this conversation';
      summarize.hidden = composing;
      if (!job) primary.textContent = label;
    }
    refresh();

    /** Headings as headings, "- " lines as a list; text only, never HTML. */
    function renderSummary(text) {
      summaryText.replaceChildren();
      let list = null;
      for (const line of text.split('\n').map(item => item.trim()).filter(Boolean)) {
        const bullet = line.match(/^[-•*]\s+(.*)$/);
        if (bullet) {
          list ??= summaryText.appendChild(document.createElement('ul'));
          list.appendChild(document.createElement('li')).textContent = bullet[1];
        } else {
          list = null;
          const heading = /^(key points|asked of you|dates and deadlines):?$/i.test(line);
          summaryText.appendChild(document.createElement(heading ? 'h4' : 'p')).textContent = line.replace(/:$/, '');
        }
      }
    }

    function showRevise(open) {
      reviseRow.hidden = !open;
      reviseToggle.setAttribute('aria-expanded', String(open));
    }

    function cancel(message) {
      if (!job || job.cancelled) return;
      job.cancelled = true;
      status.textContent = message;
      job.run?.cancel();
      notice?.hide();
    }
    const cancelIfChanged = () => {
      if (job && !job.isCurrent()) cancel('The conversation or your text changed. Your edits were kept.');
    };
    const onInput = () => {
      if (editing) return;
      cancelIfChanged();
      // Typing makes "Done…" and Undo stale; Ctrl+Z still works.
      if (!job) { status.textContent = ''; undo.hidden = true; }
    };
    editor.addEventListener('input', onInput);
    mounts.set(editor, {
      host,
      cancelIfChanged,
      refresh,
      remove() {
        cancel('Cancelled.');
        editor.removeEventListener('input', onInput);
        host.remove();
      }
    });

    async function run(task, trigger, extra = {}) {
      if (job) { cancel('Cancelled.'); return; }
      const now = contextOf(editor);
      if (!now) return;
      const snapshot = editor.innerHTML;
      const route = location.href;
      const changesBox = task !== 'summary';
      let routeBound = true;
      const isCurrent = () => enabled && host.isConnected && editor.isConnected &&
        host.parentNode === editor.parentNode && contextOf(editor)?.box === now.box &&
        (!routeBound || location.href === route) && (!changesBox || editor.innerHTML === snapshot);
      const currentJob = { isCurrent, cancelled: false, run: null };
      job = currentJob;
      const canContinue = () => !currentJob.cancelled && isCurrent();
      setBusy(trigger);
      status.textContent = 'Preparing…';
      try {
        const [{ startRun }, { createSendNotice }, { ENGINE_LABELS }, { EMAIL_LIMITS }] = await modules();
        if (!canContinue()) { cancelIfChanged(); return; }
        const boxText = plainText(editableRange(editor).range.cloneContents());
        const email = extractThread(now.threadRoot, EMAIL_LIMITS.email);
        routeBound = Boolean(email);
        const payload = { action: 'draft-gmail', task, ...extra };
        const stop = message => { status.textContent = message; return true; };
        if ((task === 'reply' || task === 'summary') && !email &&
            stop(task === 'reply' ? 'Open a message and click Reply first.' : 'Open a conversation first.')) return;
        if (task === 'compose' && !boxText &&
            stop('Type a few words about the email you want, then click Write email.')) return;
        if ((task === 'polish' || task === 'revise') && !boxText && stop('Type or draft some text first.')) return;
        if ((task === 'reply' || task === 'compose') && boxText.length > EMAIL_LIMITS.notes &&
            stop('Shorten the text in the box and try again.')) return;
        if ((task === 'polish' || task === 'revise') && boxText.length > EMAIL_LIMITS.draft &&
            stop('Your draft is too long to rewrite here.')) return;
        if (email) payload.email = email;
        if (task === 'reply' || task === 'compose') payload.notes = boxText;
        if (task === 'polish' || task === 'revise') payload.draft = boxText;

        notice ??= createSendNotice({ labelForEngine: name => ENGINE_LABELS[name] });
        if (!notice.element.isConnected) noticeSlot.append(notice.element);
        const sameThread = () => !email || extractThread(now.threadRoot, EMAIL_LIMITS.email) === email;
        currentJob.run = startRun(payload, {
          onStart: engine => {
            if (canContinue()) status.textContent = VERBS[task] + ' with ' + ENGINE_LABELS[engine] + '…';
          },
          async onApproval(details) {
            if (!canContinue() || !sameThread()) return false;
            status.textContent = 'Waiting for approval.';
            const approved = (await notice.ask(details)) && canContinue() && sameThread();
            return { approved, remember: approved && notice.remembered() };
          }
        });
        const result = await currentJob.run.promise;
        if (currentJob.cancelled) return;
        if (!result) { status.textContent = 'Cancelled.'; return; }
        if (!canContinue() || !sameThread()) {
          status.textContent = 'The conversation or your text changed. Your edits were kept.';
          return;
        }
        job = null;
        if (task === 'summary') {
          lastSummary = result.draft;
          renderSummary(result.draft);
          panel.hidden = false;
          status.textContent = result.truncated ? 'The summary was cut off.' : '';
          summaryText.focus({ preventScroll: true });
          return;
        }
        if (!replaceBoxText(editor, result.draft)) {
          status.textContent = 'Gmail could not insert the text.';
          return;
        }
        const subject = now.subject;
        if (task === 'compose' && result.subject && subject?.isConnected && !subject.value.trim()) {
          subject.value = result.subject;
          subject.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (task === 'revise' && extra.change) changeInput.value = '';
        showRevise(true);
        undo.hidden = false;
        status.textContent = result.truncated
          ? 'The text was cut off. Review it before sending.'
          : 'Done. Review it before sending.';
      } catch (error) {
        if (!currentJob.cancelled) status.textContent = friendlyError(error);
      } finally {
        if (job === currentJob) job = null;
        notice?.hide();
        setBusy(null);
      }
    }

    const trusted = handler => event => { if (event.isTrusted) handler(event); };
    primary.addEventListener('click', trusted(() => run(contextOf(editor)?.kind || 'reply', primary)));
    polish.addEventListener('click', trusted(() => run('polish', polish)));
    summarize.addEventListener('click', trusted(() => run('summary', summarize)));
    reviseToggle.addEventListener('click', trusted(() => {
      showRevise(reviseRow.hidden);
      if (!reviseRow.hidden) presets[0].element.focus();
    }));
    for (const { revision, element } of presets) {
      element.addEventListener('click', trusted(() => run('revise', element, { revision })));
    }
    const applyChange = () => {
      const change = changeInput.value.trim();
      if (!job && !change) { status.textContent = 'Say what to change.'; changeInput.focus(); return; }
      run('revise', apply, { change });
    };
    apply.addEventListener('click', trusted(applyChange));
    changeInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.isTrusted) { event.preventDefault(); applyChange(); }
    });
    undo.addEventListener('click', trusted(() => {
      if (job) return;
      const before = editor.innerHTML;
      editor.focus({ preventScroll: true });
      edit(() => document.execCommand('undo'));
      undo.hidden = true;
      status.textContent = editor.innerHTML === before
        ? 'Click in the message and press Ctrl+Z to undo.'
        : 'Previous text restored.';
    }));
    closeRevise.addEventListener('click', () => { showRevise(false); reviseToggle.focus(); });
    closeSummary.addEventListener('click', () => { panel.hidden = true; summarize.focus(); });
    copySummary.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(lastSummary);
        status.textContent = 'Summary copied.';
      } catch {
        status.textContent = 'Select the summary text and copy it.';
      }
    });
  }

  function scan() {
    frame = 0;
    if (!enabled) return;
    for (const [editor, entry] of mounts) {
      if (!editor.isConnected || !entry.host.isConnected || entry.host.parentNode !== editor.parentNode ||
          !editor.matches(editorSelector) || !contextOf(editor) || !isVisible(editor)) {
        entry.remove();
        mounts.delete(editor);
      } else {
        entry.cancelIfChanged();
        entry.refresh();
      }
    }
    for (const editor of document.querySelectorAll(editorSelector)) {
      if (!mounts.has(editor) && contextOf(editor) && isVisible(editor)) mount(editor);
    }
  }

  function scheduleScan() { frame ||= requestAnimationFrame(scan); }
  const observer = new MutationObserver(scheduleScan);
  function setEnabled(active) {
    if (active === enabled) return;
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

  /* Storage is locked to extension pages, so the opt-in list comes from the
     worker: READ_STATE once, then STATE_CHANGED relays. */
  let settingsChanged = false;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'OPTIMIZER_SITE_DISABLED' && message.origin === origin) {
      settingsChanged = true;
      setEnabled(false);
    } else if (message?.type === 'STATE_CHANGED' && message.changes?.promptcraft_sites) {
      settingsChanged = true;
      setEnabled((message.changes.promptcraft_sites.newValue || []).includes(origin));
    }
  });
  window.addEventListener('hashchange', scheduleScan);
  window.addEventListener('popstate', scheduleScan);
  chrome.runtime.sendMessage({ type: 'READ_STATE', keys: ['sites'] }).then(res => {
    if (!settingsChanged && res?.success) setEnabled((res.state.sites || []).includes(origin));
  }).catch(() => {});
})();
