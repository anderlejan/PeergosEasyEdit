/* PeergosEasyEdit - the editor.
 *
 * Rules that keep the user's text safe (each one answers a way text was lost before 1.1.0):
 *  - "Saved" is shown only after Peergos accepted the write AND the file read back has exactly
 *    the bytes that were sent. Every failure stays on screen until the text is saved.
 *  - The editor's text is never replaced by what Peergos sends back after a save.
 *  - A file that could not be read is never shown as empty and cannot be saved over.
 *  - Data files (notes, settings) are treated as empty only on 404, never after another error.
 *  - The text is kept in this browser while it is not saved (backup.js) and offered back later.
 */
'use strict';

const SAVE_TIMEOUT_MS = window.PEE_SAVE_TIMEOUT_MS || 120000;  // tests shorten these
const SLOW_SAVE_MS = window.PEE_SLOW_SAVE_MS || 15000;
const AUTO_MAX_WAIT_MS = window.PEE_AUTO_MAX_WAIT_MS || 30000;   // autosave at least this often while typing
const AUTO_RETRY_MS = window.PEE_AUTO_RETRY_MS || 30000;         // pause after a failed autosave
const AUTOSAVE_CHOICES = [0, 2, 5, 10, 30];                      // seconds after the last change; 0 = off
const $ = id => document.getElementById(id);
const editor = $('editor');

const DEFAULT_SETTINGS = {theme: 'green-on-black', wrapLines: true, fontSize: 14,
                          fontFamily: "'Lucida Console', 'Lucida Sans Typewriter', monospace", localBackup: true,
                          autoSave: 5};
const THEMES = ['light', 'dark', 'green-on-black', 'sepia'];

/* ---------- small UI helpers ---------- */

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  for (const c of children)
    e.append(c);
  return e;
}

const banners = new Map();

// A message that stays until it is dismissed, replaced or its cause is gone.
function showBanner(id, level, text, actions = []) {
  hideBanner(id);
  const box = el('div', {className: 'banner ' + level});
  box.dataset.id = id;
  box.append(el('p', {textContent: text}));
  for (const [label, fn] of actions)
    box.append(el('button', {type: 'button', textContent: label, onclick: fn}));
  $('banners').append(box);
  banners.set(id, box);
}

function hideBanner(id) {
  const box = banners.get(id);
  if (box) {
    box.remove();
    banners.delete(id);
  }
}

let toastTimer = null;
function toast(text, level = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast ' + level;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, level === 'error' ? 9000 : 3000);
}

function confirmAction(text, okLabel = 'OK') {
  const d = $('confirmDialog');
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), {once: true}));
}

const timeText = t => new Date(t).toLocaleString([], {dateStyle: 'short', timeStyle: 'short'});

function describeError(e) {
  if (e instanceof Peergos.TimeoutError)
    return e.message + '. It may still finish; press Save again to be sure.';
  if (e instanceof Peergos.HttpError) {
    if (e.status === 503)
      return 'The app lost its connection to Peergos and did not get it back (HTTP 503).';
    if (e.status === 400)
      return 'Peergos refused it (HTTP 400). This happens when the file is read-only for you, when a conflict ' +
             'dialog was cancelled, or when the file name is not passed on correctly.';
    return e.message + '.';
  }
  if (e instanceof TypeError)
    return 'No connection to Peergos (' + e.message + ').';
  return (e && e.message ? e.message : String(e)) + '.';
}

/* ---------- the document ---------- */

const doc = {
  path: null,          // the file in Peergos, or null when started without a file
  key: 'untitled',     // key of the local backup
  name: 'untitled.txt',
  loaded: false,       // the text is the file's (or a new text): editing allowed
  canSave: false,      // Save may write to path
  bom: false, eol: '\n',
  savedText: '',       // the text known to be in the file
  savedHash: null,
  savedAt: null,
  checked: false,      // the last save was read back and matched
  saving: false,
  saveAgain: false,
  restoreOpen: false,  // waiting for the user to decide about a kept copy
};

const isDirty = () => doc.loaded && editor.value !== doc.savedText;

function refreshState() {
  const dirty = isDirty();
  $('docName').classList.toggle('dirty', dirty);
  $('saveBtn').disabled = !doc.loaded || doc.restoreOpen || (doc.canSave ? !dirty && !doc.saving : false);
  $('saveAsBtn').disabled = !doc.loaded || doc.restoreOpen || doc.saving;
  editor.readOnly = !doc.loaded || doc.restoreOpen || doc.readOnly === true;
  const s = $('status');
  if (doc.saving) {
    s.className = 'status busy';
    s.textContent = doc.slow ? 'Saving… Peergos has not answered yet' : 'Saving…';
  } else if (!doc.loaded) {
    // loadFile() shows how opening went
  } else if (dirty) {
    s.className = 'status warn';
    s.textContent = 'Unsaved changes';
  } else if (doc.savedAt) {
    s.className = doc.checked ? 'status ok' : 'status warn';
    s.textContent = (doc.checked ? 'Saved ✓ ' : 'Saved (not checked) ') +
                    doc.savedAt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  } else {
    s.className = 'status';
    s.textContent = doc.path && doc.canSave ? 'No changes' : '';
  }
  document.title = (dirty ? '● ' : '') + doc.name + ' – PeergosEasyEdit';
}

function setDocName() {
  $('docName').textContent = doc.name;
  $('docName').title = doc.path || 'Not saved in Peergos yet';
}

async function openDocument() {
  const {path, trusted} = Peergos.filePathFromAddress(location.search);
  if (!Peergos.inPeergos) {
    doc.name = 'PeergosEasyEdit';
    setDocName();
    showBanner('load', 'info', 'This page runs outside Peergos, so there is no file to open or save. ' +
               'Open a text file from your Peergos Drive with PeergosEasyEdit.');
    refreshState();
    return;
  }
  if (!path) {
    doc.loaded = true;
    setDocName();
    await checkBackup(null);
    refreshState();
    editor.focus();
    return;
  }
  doc.path = path;
  doc.key = path;
  doc.name = path.substring(path.lastIndexOf('/') + 1) || path;
  setDocName();
  if (!trusted) {
    showBanner('load', 'error', 'Peergos passed this file\'s name to the editor changed (names with + & # or % ' +
               'are not passed on correctly), so the editor cannot read or save this file safely and does not ' +
               'open it. Rename the file in your Drive without those characters and open it again.');
    refreshState();
    return;
  }
  await loadFile();
}

async function loadFile() {
  hideBanner('load');
  const s = $('status');
  s.className = 'status busy';
  s.textContent = 'Opening…';
  let bytes;
  try {
    bytes = await Peergos.readFile(doc.path);
  } catch (e) {
    const missing = e instanceof Peergos.HttpError && e.status === 404;
    showBanner('load', 'error', missing
      ? 'The file was not found. It may have been moved, renamed or deleted. Nothing is saved from this window.'
      : 'The file could not be opened: ' + describeError(e) + ' Nothing is saved from this window until it ' +
        'has been opened.', missing ? [] : [['Try again', loadFile]]);
    s.className = 'status error';
    s.textContent = 'Not opened';
    refreshState();
    return;
  }
  const decoded = TextCodec.decode(bytes);
  editor.value = decoded.text;
  if (!decoded.ok) {
    doc.loaded = true;
    doc.canSave = false;
    doc.readOnly = true;
    doc.savedText = decoded.text;
    showBanner('load', 'warn', 'This file is not UTF-8 text. It is shown read-only, because saving it would ' +
               'change characters the editor cannot show. "Save as…" saves a UTF-8 copy of what you see.');
    refreshState();
    return;
  }
  doc.bom = decoded.bom;
  doc.eol = decoded.eol;
  doc.savedText = decoded.text;
  doc.savedHash = await TextCodec.sha256(bytes);
  doc.loaded = true;
  doc.canSave = true;
  if (decoded.mixedEol)
    showBanner('eol', 'info', 'This file mixes line ending styles. Saving writes them all as ' +
               (doc.eol === '\r\n' ? 'Windows (CR LF)' : 'Unix (LF)') + ' line endings.', [['OK', () => hideBanner('eol')]]);
  await checkBackup(doc.savedHash);
  refreshState();
  editor.focus();
}

/* ---------- local backup in this browser ---------- */

let backupTimer = null;
let backupWarned = false;

async function checkBackup(fileHash) {
  if (!settings.localBackup)
    return;
  let rec = null;
  try {
    await Backup.prune();
    rec = await Backup.get(doc.key);
  } catch (e) {
    warnNoBackup(e);
    return;
  }
  if (!rec)
    return;
  if (rec.state === 'unsaved' && rec.text !== doc.savedText && rec.text !== '') {
    askRestore(rec, 'Changes you made on ' + timeText(rec.at) + ' were not saved to the file. The editor kept them ' +
               'in this browser.', 'Restore them', 'Discard them');
  } else if (rec.state === 'saved' && fileHash && rec.savedHash && rec.savedHash !== fileHash && rec.text !== doc.savedText) {
    askRestore(rec, 'This file is not what you saved here on ' + timeText(rec.at) + '. If it was changed on ' +
               'another device or in another app, that is expected.', 'Show my saved version', 'Keep the file as it is');
  }
}

// The editor stays read-only until the user decides, so the kept copy cannot be overwritten meanwhile.
function askRestore(rec, text, restoreLabel, keepLabel) {
  doc.restoreOpen = true;
  showBanner('restore', 'warn', text, [
    [restoreLabel, () => {
      const fileText = editor.value;
      doc.restoreOpen = false;
      editor.value = rec.text;
      onEdit();
      showBanner('restore', 'info', 'The kept text is in the editor. ' + (settings.autoSave
        ? 'Autosave puts it in the file.' : 'Press Save to put it in the file.'), [
        ['Undo', () => { editor.value = fileText; onEdit(); hideBanner('restore'); }],
        ['OK', () => hideBanner('restore')]]);
      refreshState();
    }],
    [keepLabel, () => {
      doc.restoreOpen = false;
      hideBanner('restore');
      storeBackupNow();
      refreshState();
    }]]);
  refreshState();
}

function warnNoBackup(e) {
  if (backupWarned)
    return;
  backupWarned = true;
  toast('The copy in this browser is not available (' + (e && e.message || e) + '). Save often.', 'error');
}

function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(storeBackupNow, 400);
}

function storeBackupNow() {
  clearTimeout(backupTimer);
  if (!settings.localBackup || !doc.loaded || doc.restoreOpen || doc.readOnly)
    return;
  const record = isDirty()
    ? {key: doc.key, state: 'unsaved', text: editor.value, savedHash: doc.savedHash}
    : {key: doc.key, state: 'saved', text: doc.savedText, savedHash: doc.savedHash};
  if (!doc.path && !isDirty()) {
    // a text started without a file: once saved (or empty) there is nothing to offer back
    Backup.remove(doc.key).catch(warnNoBackup);
    return;
  }
  Backup.put(record).catch(warnNoBackup);
}

function onEdit() {
  refreshState();
  scheduleBackup();
  scheduleAutoSave();
}

/* ---------- autosave ---------- */

let autoTimer = null;
let autoDirtySince = null;   // when the first change not yet autosaved was made
let autoFailed = false;      // the last autosave failed: wait AUTO_RETRY_MS before the next one

// Saves settings.autoSave seconds after the last change, and at least every AUTO_MAX_WAIT_MS while
// typing goes on. Only a file opened from the Drive: a new text would open Peergos' name dialog.
function scheduleAutoSave() {
  clearTimeout(autoTimer);
  if (!settings.autoSave || !doc.canSave || !doc.loaded || doc.restoreOpen || !isDirty()) {
    autoDirtySince = null;
    return;
  }
  const now = Date.now();
  if (autoDirtySince === null)
    autoDirtySince = now;
  const delay = autoFailed ? AUTO_RETRY_MS
    : Math.min(settings.autoSave * 1000, Math.max(0, autoDirtySince + AUTO_MAX_WAIT_MS - now));
  autoTimer = setTimeout(autoSaveNow, delay);
}

function autoSaveNow() {
  clearTimeout(autoTimer);
  if (settings.autoSave && doc.canSave && doc.loaded && !doc.restoreOpen && isDirty())
    save({auto: true});
}

/* ---------- saving ---------- */

async function save(options) {
  const auto = !!(options && options.auto === true);
  if (!doc.loaded || doc.restoreOpen)
    return;
  if (!doc.canSave)
    return saveAs();
  if (doc.saving) {
    doc.saveAgain = true;
    return;
  }
  clearTimeout(autoTimer);
  autoDirtySince = null;
  const text = editor.value;
  const bytes = TextCodec.encode(text, doc);
  doc.saving = true;
  doc.slow = false;
  refreshState();
  const slowTimer = setTimeout(() => { doc.slow = true; refreshState(); }, SLOW_SAVE_MS);
  try {
    await Peergos.writeFile(doc.path, bytes, SAVE_TIMEOUT_MS);
    let back = null;
    try {
      back = await Peergos.readFile(doc.path);
    } catch (e) {
      back = null;  // saved, but the check could not be made
    }
    if (back && !TextCodec.sameBytes(back, bytes))
      throw new Error('Peergos reported the file as saved, but reading it back gave different content');
    doc.savedText = text;
    doc.savedHash = await TextCodec.sha256(bytes);
    doc.savedAt = new Date();
    doc.checked = back !== null;
    autoFailed = false;
    hideBanner('save');
    if (!doc.checked)
      showBanner('save', 'warn', 'Peergos reported the file as saved, but it could not be read back to check. ' +
                 'Your text is still here.', [['Save again', save], ['OK', () => hideBanner('save')]]);
  } catch (e) {
    autoFailed = true;
    showBanner('save', 'error', (auto ? 'Autosave failed. ' : '') + 'Not saved: ' + describeError(e) +
               (settings.autoSave ? ' Autosave tries again in ' + Math.round(AUTO_RETRY_MS / 1000) + ' s.' : '') +
               ' Your text is still here' +
               (settings.localBackup && Backup.isAvailable() ? ' and kept in this browser' : '') + '.',
               [['Try again', save], ['Save as…', saveAs]]);
  } finally {
    clearTimeout(slowTimer);
    doc.saving = false;
    storeBackupNow();
    refreshState();
  }
  if (doc.saveAgain) {
    doc.saveAgain = false;
    if (isDirty())
      save();
  } else {
    scheduleAutoSave();   // changes made while saving, or the retry after a failure
  }
}

// The name Peergos' save dialog starts with. Peergos refuses the opened file's own name there.
function copyName() {
  if (!doc.path)
    return doc.name;
  const dot = doc.name.lastIndexOf('.');
  return dot > 0 ? doc.name.substring(0, dot) + ' (copy)' + doc.name.substring(dot) : doc.name + ' (copy)';
}

async function saveAs() {
  if (!doc.loaded || doc.saving || doc.restoreOpen)
    return;
  const text = editor.value;
  doc.saving = true;
  refreshState();
  $('status').textContent = 'Saving a copy… (Peergos asks for the name)';
  try {
    await Peergos.saveAs(copyName(), TextCodec.encode(text, doc), 15 * 60 * 1000);
    hideBanner('save');
    if (!doc.path) {
      doc.savedText = text;
      doc.savedAt = new Date();
      doc.checked = false;
      toast('Saved. Peergos reported the file as written.');
    } else {
      toast('A copy was saved. This window still edits ' + doc.name + '.');
    }
  } catch (e) {
    if (e instanceof Peergos.HttpError && e.status === 400)
      toast('Not saved: cancelled, or Peergos refused the name.', 'error');
    else
      showBanner('save', 'error', 'The copy was not saved: ' + describeError(e), [['Try again', saveAs]]);
  } finally {
    doc.saving = false;
    storeBackupNow();
    refreshState();
  }
}

/* ---------- settings ---------- */

let settings = Object.assign({}, DEFAULT_SETTINGS);
let settingsChain = Promise.resolve();
let settingsTimer = null;

function cleanSettings(s) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (s && typeof s === 'object') {
    if (THEMES.includes(s.theme)) out.theme = s.theme;
    if (typeof s.wrapLines === 'boolean') out.wrapLines = s.wrapLines;
    if (Number.isFinite(s.fontSize)) out.fontSize = Math.min(48, Math.max(8, Math.round(s.fontSize)));
    if (typeof s.fontFamily === 'string' && s.fontFamily.length < 200) out.fontFamily = s.fontFamily;
    if (typeof s.localBackup === 'boolean') out.localBackup = s.localBackup;
    if (AUTOSAVE_CHOICES.includes(s.autoSave)) out.autoSave = s.autoSave;
  }
  return out;
}

function applySettings() {
  document.body.className = 'theme-' + settings.theme;
  $('themeSelect').value = settings.theme;
  editor.classList.toggle('wrap', settings.wrapLines);
  $('wrapCheck').checked = settings.wrapLines;
  editor.style.fontSize = settings.fontSize + 'px';
  $('fontSizeLabel').textContent = settings.fontSize;
  editor.style.fontFamily = settings.fontFamily;
  if (![...$('fontSelect').options].some(o => o.value === settings.fontFamily))
    $('fontSelect').append(el('option', {value: settings.fontFamily, textContent: settings.fontFamily}));
  $('fontSelect').value = settings.fontFamily;
  $('localBackupCheck').checked = settings.localBackup;
  $('autoSaveSelect').value = String(settings.autoSave);
}

function localSettings() {
  try {
    return JSON.parse(localStorage.getItem('peergoseasyedit.settings'));
  } catch (e) {
    return null;
  }
}

async function loadSettings() {
  settings = cleanSettings(localSettings());
  applySettings();
  try {
    const text = await Peergos.readData('settings.json');
    if (text !== null) {
      settings = cleanSettings(JSON.parse(text));
      applySettings();
      try { localStorage.setItem('peergoseasyedit.settings', JSON.stringify(settings)); } catch (e) { /* only a cache */ }
    }
  } catch (e) {
    toast('Your settings could not be read from Peergos: ' + describeError(e), 'error');
  }
}

// Settings apply at once and are saved shortly after the last change.
function changeSetting(name, value) {
  settings[name] = value;
  settings = cleanSettings(settings);
  applySettings();
  try { localStorage.setItem('peergoseasyedit.settings', JSON.stringify(settings)); } catch (e) { /* only a cache */ }
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const text = JSON.stringify(settings);
    settingsChain = settingsChain.then(() => Peergos.writeData('settings.json', text))
      .catch(e => toast('Settings not saved in Peergos: ' + describeError(e), 'error'));
  }, 600);
}

/* ---------- notes ---------- */

let notes = null;           // null until read; never written before that
let notesWriting = false, notesPending = false;

async function loadNotes() {
  const msg = $('notesMessage');
  try {
    const text = await Peergos.readData('notes.json');
    const parsed = text === null ? [] : JSON.parse(text);
    if (!Array.isArray(parsed))
      throw new Error('notes.json does not hold a list of notes');
    notes = parsed.filter(n => n && typeof n === 'object');
    msg.hidden = true;
  } catch (e) {
    notes = null;
    msg.hidden = false;
    msg.replaceChildren('Your notes could not be read: ' + describeError(e) + ' They are not changed until they ' +
                        'could be read. ', el('button', {type: 'button', textContent: 'Try again', onclick: loadNotes}));
  }
  renderNotes();
}

function renderNotes() {
  $('addNoteBtn').disabled = notes === null;
  const list = $('notesList');
  list.replaceChildren();
  for (const note of notes || []) {
    const title = typeof note.title === 'string' && note.title.trim() ? note.title : 'Untitled note';
    const preview = typeof note.content === 'string' ? note.content.split('\n').find(l => l.trim()) || '' : '';
    list.append(el('li', {},
      el('div', {className: 'note-title', textContent: title, title}),
      el('div', {className: 'note-preview', textContent: preview}),
      el('div', {className: 'note-buttons'},
        el('button', {type: 'button', textContent: 'Edit', onclick: () => editNote(note)}),
        el('button', {type: 'button', textContent: 'Delete', onclick: () => deleteNote(note)}))));
  }
}

// One write at a time; a change made meanwhile is written right after with the newest list.
async function persistNotes() {
  notesPending = true;
  if (notesWriting)
    return;
  notesWriting = true;
  while (notesPending) {
    notesPending = false;
    try {
      await Peergos.writeData('notes.json', JSON.stringify(notes, null, 1));
      $('notesMessage').hidden = true;
    } catch (e) {
      const msg = $('notesMessage');
      msg.hidden = false;
      msg.replaceChildren('Notes not saved: ' + describeError(e) + ' ',
                          el('button', {type: 'button', textContent: 'Try again', onclick: persistNotes}));
      break;
    }
  }
  notesWriting = false;
}

function editNote(note) {
  if (notes === null)
    return;
  const d = $('noteDialog');
  $('noteTitle').value = note ? note.title || '' : '';
  $('noteText').value = note ? note.content || '' : '';
  d.returnValue = '';
  d.showModal();
  d.addEventListener('close', () => {
    if (d.returnValue !== 'save')
      return;
    const title = $('noteTitle').value.trim() || 'Untitled note';
    const content = $('noteText').value;
    if (note) {
      note.title = title;
      note.content = content;
    } else {
      notes.push({id: Date.now(), title, content});
    }
    renderNotes();
    persistNotes();
  }, {once: true});
}

async function deleteNote(note) {
  if (notes === null || !await confirmAction('Delete the note "' + (note.title || 'Untitled note') + '"?', 'Delete'))
    return;
  notes = notes.filter(n => n !== note);
  renderNotes();
  persistNotes();
}

/* ---------- export / import of notes and settings ---------- */

function exportData() {
  if (notes === null) {
    toast('Your notes could not be read, so they cannot be exported now.', 'error');
    return;
  }
  $('exportText').value = JSON.stringify({app: 'PeergosEasyEdit', version: VERSION, settings, notes}, null, 2);
  $('copyExportBtn').disabled = false;
}

async function copyExport() {
  const text = $('exportText').value;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch (e) {
    $('exportText').select();
    toast(document.execCommand('copy') ? 'Copied.' : 'Select the text and copy it with Ctrl+C.');
  }
}

async function importData() {
  let data;
  try {
    data = JSON.parse($('importText').value);
  } catch (e) {
    toast('This is not an exported text (' + e.message + ').', 'error');
    return;
  }
  const ok = data && typeof data === 'object' && data.settings && typeof data.settings === 'object' &&
             Array.isArray(data.notes) && data.notes.every(n => n && typeof n === 'object' &&
             (n.title === undefined || typeof n.title === 'string') && (n.content === undefined || typeof n.content === 'string'));
  if (!ok) {
    toast('This text does not hold notes and settings exported from PeergosEasyEdit.', 'error');
    return;
  }
  if (notes === null) {
    toast('Your notes could not be read, so importing would replace notes the editor cannot see. Try again later.', 'error');
    return;
  }
  if (!await confirmAction('Replace your ' + notes.length + ' note(s) and your settings with the ' + data.notes.length +
                           ' note(s) and settings from the pasted text?', 'Replace'))
    return;
  notes = data.notes.map((n, i) => ({id: Number.isFinite(n.id) ? n.id : Date.now() + i, title: n.title || '', content: n.content || ''}));
  renderNotes();
  persistNotes();
  for (const [k, v] of Object.entries(cleanSettings(data.settings)))
    changeSetting(k, v);
  $('importText').value = '';
  toast('Imported.');
}

/* ---------- wiring ---------- */

function wire() {
  editor.addEventListener('input', onEdit);
  $('saveBtn').onclick = save;
  $('saveAsBtn').onclick = saveAs;
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (e.shiftKey) saveAs(); else save();
    }
  });
  // write the backup at once when the window is hidden or closed, and autosave then
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      storeBackupNow();
      autoSaveNow();
    }
  });
  window.addEventListener('pagehide', storeBackupNow);

  $('themeSelect').onchange = e => changeSetting('theme', e.target.value);
  $('fontSelect').onchange = e => changeSetting('fontFamily', e.target.value);
  $('wrapCheck').onchange = e => changeSetting('wrapLines', e.target.checked);
  $('autoSaveSelect').onchange = e => {
    changeSetting('autoSave', Number(e.target.value));
    autoFailed = false;
    scheduleAutoSave();
  };
  $('fontBiggerBtn').onclick = () => changeSetting('fontSize', settings.fontSize + 2);
  $('fontSmallerBtn').onclick = () => changeSetting('fontSize', settings.fontSize - 2);
  $('localBackupCheck').onchange = e => {
    changeSetting('localBackup', e.target.checked);
    if (e.target.checked) storeBackupNow();
  };
  $('clearLocalBtn').onclick = async () => {
    if (!await confirmAction('Delete every copy of your texts kept in this browser, including changes that were ' +
                             'never saved?', 'Delete'))
      return;
    Backup.clearAll().then(() => toast('Deleted.'), e => toast('Could not delete: ' + e.message, 'error'));
  };

  $('notesBtn').onclick = () => {
    const panel = $('notesPanel');
    panel.hidden = !panel.hidden;
    $('notesBtn').setAttribute('aria-pressed', String(!panel.hidden));
  };
  $('addNoteBtn').onclick = () => editNote(null);
  $('noteCancel').onclick = () => $('noteDialog').close('cancel');
  $('backupBtn').onclick = () => $('backupDialog').showModal();
  $('helpBtn').onclick = () => $('helpDialog').showModal();
  $('aboutBtn').onclick = () => $('aboutDialog').showModal();
  $('exportBtn').onclick = exportData;
  $('copyExportBtn').onclick = copyExport;
  $('importBtn').onclick = importData;
  for (const b of document.querySelectorAll('[data-close]'))
    b.onclick = () => b.closest('dialog').close();
  $('aboutVersion').textContent = VERSION;
}

async function start() {
  wire();
  refreshState();
  await loadSettings();
  await openDocument();
  await loadNotes();
}

start();
