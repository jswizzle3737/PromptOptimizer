import { EMAIL_LIMITS, EMAIL_STYLE_KEY } from '../shared/email-draft.js';
import { ENGINES, ENGINE_LABELS } from '../shared/engines.js';
import { getSettings } from '../shared/storage.js';
import { applyTheme, watchTheme } from '../shared/theme-picker.js';
import { hydrateIcons } from '../shared/icons.js';
import { createSendNotice } from '../shared/assist.js';
import { startRun } from '../shared/run-client.js';

const byId = id => document.getElementById(id);
const style = byId('style-instructions');
const files = byId('sample-files');
const list = byId('sample-list');
const email = byId('incoming-email');
const notes = byId('reply-notes');
const result = byId('reply-result');
const engine = byId('reply-engine');
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

try {
  const saved = JSON.parse(localStorage.getItem(EMAIL_STYLE_KEY) || 'null');
  if (saved) {
    if (typeof saved.instructions === 'string') style.value = saved.instructions.slice(0, EMAIL_LIMITS.instructions);
    if (Array.isArray(saved.samples)) {
      samples = saved.samples.filter(item => item && typeof item.name === 'string' &&
        typeof item.text === 'string' && item.text.length <= EMAIL_LIMITS.sample)
        .slice(0, EMAIL_LIMITS.samples);
    }
    renderSamples();
  }
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

byId('save-style').addEventListener('click', () => {
  try {
    localStorage.setItem(EMAIL_STYLE_KEY, JSON.stringify({ instructions: style.value.trim(), samples }));
    status(styleStatus, 'Writing style saved on this browser.');
  } catch {
    status(styleStatus, 'Could not save your writing style. Free some browser storage and try again.', true);
  }
});

for (const item of ENGINES.filter(item => item.value !== 'offline')) {
  engine.add(new Option(item.fullLabel, item.value));
}
try {
  const settings = await getSettings();
  applyTheme(document.documentElement, settings.theme);
  if ([...engine.options].some(item => item.value === settings.preferredEngine)) engine.value = settings.preferredEngine;
} catch {
  status(replyStatus, 'Could not load engine preferences. You can still choose an engine here.', true);
}
watchTheme(theme => applyTheme(document.documentElement, theme));

function setBusy(busy) {
  draft.disabled = busy;
  cancel.hidden = !busy;
  for (const field of [style, email, notes, result]) field.readOnly = busy;
  for (const control of [files, engine, ...list.querySelectorAll('input, button')]) control.disabled = busy;
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
    engine: engine.value
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
        return approved;
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
