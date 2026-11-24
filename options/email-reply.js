import { EMAIL_LIMITS, EMAIL_STYLE_KEY, normalizeEmailStyle } from '../shared/email-draft.js';
import { ENGINES, ENGINE_LABELS } from '../shared/engines.js';
import { getSettings } from '../shared/storage.js';
import { applyTheme, watchTheme } from '../shared/theme-picker.js';
import { hydrateIcons } from '../shared/icons.js';
import { createSendNotice } from '../shared/assist.js';
import { startRun } from '../shared/run-client.js';
import { createSelect } from '../shared/select.js';

const byId = id => document.getElementById(id);
const style = byId('style-instructions');
const files = byId('sample-files');
const list = byId('sample-list');
const email = byId('incoming-email');
const notes = byId('reply-notes');
const result = byId('reply-result');
// Same picker as the popup and Options; Offline cannot write an email reply.
const engineOptions = ENGINES.filter(item => item.value !== 'offline')
  .map(item => ({ value: item.value, label: item.fullLabel, desc: item.fullDesc, icon: item.icon }));
const engine = createSelect({ options: engineOptions, value: engineOptions[0].value, label: 'AI engine' });
byId('reply-engine').append(engine.element);
const engineTrigger = engine.element.querySelector('.pc-select__trigger');
const draft = byId('draft-reply');
const cancel = byId('cancel-draft');
const copy = byId('copy-reply');
const styleStatus = byId('style-status');
const replyStatus = byId('reply-status');
let samples = [];
let currentRun = null;

function status(element, message, isError = false) {
  element.textContent = message;
  element.dataset.error = String(isError);
}

style.maxLength = EMAIL_LIMITS.instructions;
email.maxLength = EMAIL_LIMITS.email;
notes.maxLength = EMAIL_LIMITS.notes;
hydrateIcons(document);

const notice = createSendNotice({ labelForEngine: name => ENGINE_LABELS[name] });
byId('reply-approval').append(notice.element);

function renderSamples() {
  list.replaceChildren();
  for (const sample of samples) {
    const row = document.createElement('li');
    row.className = 'reply-sample-row';
    const use = document.createElement('input');
    use.type = 'checkbox';
    use.checked = sample.selected;
    use.addEventListener('change', () => {
      sample.selected = use.checked;
      status(styleStatus, 'Unsaved changes');
    });
    const label = document.createElement('label');
    label.append(use, sample.name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pc-btn pc-btn--ghost pc-btn--sm';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + sample.name);
    remove.addEventListener('click', () => {
      samples = samples.filter(item => item !== sample);
      renderSamples();
      files.focus();
      status(styleStatus, 'Unsaved changes');
    });
    row.append(label, remove);
    list.append(row);
  }
}

/* The style lives in chrome.storage.local so the worker can use it for Gmail
   replies. Earlier versions kept it in this page's localStorage: move it once. */
async function loadStyle() {
  let { [EMAIL_STYLE_KEY]: saved } = await chrome.storage.local.get(EMAIL_STYLE_KEY);
  if (!saved) {
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(EMAIL_STYLE_KEY) || 'null'); } catch { /* unreadable */ }
    if (legacy) {
      saved = normalizeEmailStyle(legacy);
      await chrome.storage.local.set({ [EMAIL_STYLE_KEY]: saved });
      try { localStorage.removeItem(EMAIL_STYLE_KEY); } catch { /* copy already saved */ }
    }
  }
  if (!saved) return;
  const profile = normalizeEmailStyle(saved);
  style.value = profile.instructions;
  samples = profile.samples;
  renderSamples();
}

try {
  await loadStyle();
} catch {
  status(styleStatus, 'Could not load your saved writing style.', true);
}

style.addEventListener('input', () => status(styleStatus, 'Unsaved changes'));
files.addEventListener('change', async () => {
  const selected = [...files.files];
  files.value = '';
  if (!selected.length) return;
  files.disabled = true;
  draft.disabled = true;
  const issues = [];
  try {
    for (const file of selected) {
      if (samples.length >= EMAIL_LIMITS.samples) {
        issues.push('Only five samples can be added.');
        break;
      }
      try {
        if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new Error('Choose a .txt or Markdown file.');
        if (file.size > EMAIL_LIMITS.sample * 4) throw new Error('Use a sample of up to 6,000 characters.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()).trim();
        if (!text || text.includes('\0')) throw new Error('Choose a readable text file with some content.');
        if (text.length > EMAIL_LIMITS.sample) throw new Error('Use a sample of up to 6,000 characters.');
        if (!samples.some(item => item.text === text)) {
          samples.push({ name: file.name, text, selected: true });
        }
      } catch (error) {
        issues.push(file.name + ' — ' + error.message);
      }
    }
    renderSamples();
    status(styleStatus, issues.join(' ') || 'Samples ready. Save writing style to keep them.', issues.length > 0);
  } finally {
    files.disabled = false;
    draft.disabled = false;
  }
});

byId('save-style').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ [EMAIL_STYLE_KEY]: normalizeEmailStyle({ instructions: style.value.trim(), samples }) });
    status(styleStatus, 'Writing style saved on this browser. Gmail replies use it too.');
  } catch {
    status(styleStatus, 'Could not save your writing style. Free some browser storage and try again.', true);
  }
});

try {
  const settings = await getSettings();
  applyTheme(document.documentElement, settings.theme);
  if (engineOptions.some(item => item.value === settings.preferredEngine)) engine.setValue(settings.preferredEngine, { silent: true });
} catch {
  status(replyStatus, 'Could not load engine preferences. You can still choose an engine here.', true);
}
watchTheme(theme => applyTheme(document.documentElement, theme));

function setBusy(busy) {
  draft.disabled = busy;
  cancel.hidden = !busy;
  for (const field of [style, email, notes, result]) field.readOnly = busy;
  for (const control of [files, engineTrigger, ...list.querySelectorAll('input, button')]) control.disabled = busy;
  copy.disabled = busy || !result.value.trim();
}

byId('reply-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (currentRun || files.disabled) return;
  const previous = result.value;
  const input = {
    action: 'draft-email',
    email: email.value,
    notes: notes.value,
    instructions: style.value,
    samples: samples.filter(item => item.selected).map(item => item.text),
    engine: engine.getValue()
  };
  setBusy(true);
  status(replyStatus, 'Preparing your reply…');
  try {
    currentRun = startRun(input, {
      onStart(name) {
        result.value = '';
        status(replyStatus, 'Drafting with ' + ENGINE_LABELS[name] + '…');
      },
      async onApproval(details) {
        status(replyStatus, 'Waiting for your approval.');
        const approved = await notice.ask(details);
        if (approved) status(replyStatus, 'Drafting with ' + ENGINE_LABELS[details.engine] + '…');
        return { approved, remember: approved && notice.remembered() };
      },
      onToken(delta) { result.value += delta; }
    });
    const response = await currentRun.promise;
    result.value = response?.draft ?? previous;
    status(replyStatus, response
      ? (response.truncated ? 'The engine cut off this draft. Review it before copying.' : 'Draft ready to review and edit.')
      : 'Drafting cancelled.');
  } catch (error) {
    result.value = previous;
    status(replyStatus, error.message + ' You can choose another engine or use shorter excerpts.', true);
  } finally {
    currentRun = null;
    notice.hide();
    setBusy(false);
  }
});

cancel.addEventListener('click', () => currentRun?.cancel());
result.addEventListener('input', () => { copy.disabled = !result.value.trim(); });
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(result.value);
    status(replyStatus, 'Reply copied.');
  } catch {
    result.select();
    status(replyStatus, 'Use your keyboard’s copy shortcut to copy the selected draft.');
  }
});
