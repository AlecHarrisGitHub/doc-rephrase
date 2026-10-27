'use strict';
const $ = id => document.getElementById(id);
let busy = false, helper = null, shown = null, applied = false;

const ask = (action, extra = {}) => chrome.runtime.sendMessage(Object.assign({kind: 'panel', action}, extra)).then(reply => {
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Something went wrong. Try again.');
  return reply;
});
function status(message, error = false) {
  $('status').textContent = message || ''; $('status').hidden = !message;
  $('status').classList.toggle('error', error);
}
function controls() {
  document.querySelectorAll('button,select,textarea').forEach(el => { el.disabled = busy; });
  $('generate').disabled = busy || !helper;
  $('apply').disabled = $('again').disabled = busy || applied || !helper;
}
async function run(action) {
  if (busy) return;
  busy = true; controls();
  try { await action(); } catch (e) { status(String(e.message || e), true); }
  finally { busy = false; controls(); }
}
function showSelection(original, title) {
  shown = original || null;
  $('selected').hidden = !shown;
  $('original').textContent = shown || '';
  $('docTitle').textContent = title || '';
}
function showShortcut(shortcut) {
  const hint = $('shortcutHint');
  hint.replaceChildren();
  if (shortcut) {
    hint.append('Highlight text in a Google Doc, then press ');
    const key = document.createElement('kbd'); key.textContent = shortcut; hint.append(key, '.');
  } else {
    hint.textContent = 'Highlight text in a Google Doc, then click the Doc Rephrase toolbar button. Add a keyboard shortcut at chrome://extensions/shortcuts.';
  }
}
function showHelper(value, error) {
  helper = value && value.ok && value.configured ? value : null;
  $('helperStatus').textContent = helper ? 'Ready' : 'Setup needed';
  $('helperInfo').textContent = helper ? 'Connected to the local helper · ' + helper.model + ' · key from 1Password'
    : (value && value.ok && !value.op_installed) ? 'The 1Password CLI is missing. Run ./install.sh in the doc-rephrase folder.'
    : (value && value.ok) ? 'The helper has no 1Password reference yet. Run ./install.sh in the doc-rephrase folder.'
    : (value && value.error) || error || 'The helper is not reachable. Run ./install.sh in the doc-rephrase folder.';
  $('connection').open = !helper;
}

async function generate() {
  $('result').hidden = true;
  status(helper && helper.key_ready ? 'Writing a suggestion…' : 'Writing a suggestion… Approve 1Password if it asks.');
  const value = await ask('rewrite', {tone: $('tone').value, effort: $('effort').value, guidance: $('guidance').value});
  if (helper) helper.key_ready = true;
  applied = false;
  showSelection(value.original, $('docTitle').textContent);
  $('editors').replaceChildren();
  value.paragraphs.forEach((text, index) => {
    const label = document.createElement('label');
    label.textContent = value.paragraphs.length > 1 ? 'Paragraph ' + (index + 1) : 'Your editable suggestion';
    const area = document.createElement('textarea'); area.id = 'rewrite-' + index; area.value = text; label.htmlFor = area.id;
    $('editors').append(label, area);
  });
  $('note').textContent = value.note;
  $('context').textContent = value.contextCharacters.toLocaleString() + ' characters of context · ' + value.model;
  $('result').hidden = false;
  status('Ready to review. Your document has not changed.');
}

async function refresh({allowAutoRun = true} = {}) {
  const value = await ask('status');
  showShortcut(value.shortcut);
  showHelper(value.helper);
  const state = value.state;
  if (state && state.original) showSelection(state.original, state.title);
  if (state && state.error) status(state.error, true);
  else if (!value.isDoc) status('Open a Google Doc and highlight a passage to get started.');
  else if (!helper) status('Finish setup to get started: see Connection below.', true);
  else if (allowAutoRun && state && state.autoRun) return generate();
  else if (!state || !state.original) status('');
}

$('generate').onclick = () => run(generate);
$('again').onclick = () => run(generate);
$('recheck').onclick = () => run(() => refresh({allowAutoRun: false}));
$('apply').onclick = () => run(async () => {
  status('Replacing the passage in your document…');
  await ask('apply', {paragraphs: Array.from($('editors').querySelectorAll('textarea'), el => el.value)});
  applied = true;
  status('Replaced. Cmd+Z in the document undoes it.');
});
$('copy').onclick = () => run(async () => {
  await navigator.clipboard.writeText(Array.from($('editors').querySelectorAll('textarea'), el => el.value).join('\n'));
  status('Suggestion copied.');
});
for (const id of ['tone', 'effort']) {
  $(id).onchange = () => chrome.storage.local.set({[id]: $(id).value});
}

chrome.runtime.onMessage.addListener(message => {
  if (message && message.kind === 'panel-refresh') { $('result').hidden = true; run(() => refresh()); }
});
chrome.tabs.onActivated.addListener(() => run(() => refresh({allowAutoRun: false})));

chrome.storage.local.get(['tone', 'effort']).then(prefs => {
  if (prefs.tone) $('tone').value = prefs.tone;
  if (prefs.effort) $('effort').value = prefs.effort;
  run(() => refresh());
});
