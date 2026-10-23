/* PeergosEasyEdit - the application: tabs, menus, settings, recent files, the start panel and notes.
 * Documents (loading, saving, drafts) are in docs.js, locations and the file dialog in files.js, what is kept in
 * Peergos in store.js. Nothing is stored on the device: settings, the open tabs, recent files, notes and drafts
 * live in the app's own Peergos folder, so every device shows the same. */
'use strict';

const AUTOSAVE_CHOICES = [0, 2, 5, 10, 30];   // seconds after the last change; 0 = off
const RECENT_CHOICES = [0, 5, 10, 20];
const $ = id => document.getElementById(id);

const DEFAULT_SETTINGS = {theme: 'green-on-black', wrapLines: true, fontSize: 14,
                          fontFamily: "'Lucida Console', 'Lucida Sans Typewriter', monospace",
                          autoSave: 5, lineNumbers: false, showNotes: false, tabs: false, recent: 10, drafts: true};
const THEMES = ['light', 'dark', 'green-on-black', 'amber-on-black', 'sepia', 'solarized-light', 'solarized-dark', 'nord',
                'blue', 'high-contrast'];

/* ---------- small UI helpers ---------- */

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  for (const c of children)
    e.append(c);
  return e;
}

let toastTimer = null;
function toast(text, level = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast ' + level;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, level === 'error' ? 9000 : 3500);
}

function confirmAction(text, okLabel = 'OK') {
  const d = $('confirmDialog');
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), {once: true}));
}

// Three answers: resolves to 'save', 'discard' or null (cancel).
function askSaveChanges(name) {
  const d = $('choiceDialog');
  $('choiceText').textContent = '"' + name + '" has changes that are not saved. Save them?';
  d.returnValue = '';
  d.showModal();
  return new Promise(resolve => d.addEventListener('close', () =>
    resolve(d.returnValue === 'save' || d.returnValue === 'discard' ? d.returnValue : null), {once: true}));
}

// A line of text; resolves to it, or null when cancelled.
function askText(label, value, okLabel = 'OK') {
  const d = $('promptDialog');
  $('promptLabel').textContent = label;
  $('promptInput').value = value || '';
  $('promptOk').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  $('promptInput').focus();
  return new Promise(resolve => d.addEventListener('close', () =>
    resolve(d.returnValue === 'ok' ? $('promptInput').value : null), {once: true}));
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
    if (e.status === 403)
      return 'Peergos allows reading this folder, not changing it (HTTP 403).';
    return e.message + '.';
  }
  if (e instanceof TypeError)
    return 'No connection to Peergos (' + e.message + ').';
  return (e && e.message ? e.message : String(e)) + '.';
}

/* ---------- the application state ---------- */

let settings = Object.assign({}, DEFAULT_SETTINGS);
const docs = [];
let active = null;
const appBanners = new Map();   // messages that belong to no document

const App = {
  get settings() { return settings; },
  changed(doc) {
    if (doc === active)
      refreshState();
    renderTabs();
  },
  renderBanners,
  close: doc => closeDoc(doc),
  moved(doc, oldKey) {
    noteRecent(doc);
    saveSession();
    refreshState();
    renderTabs();
  },
};

function showAppBanner(id, level, text, actions = []) {
  appBanners.set(id, {level, text, actions});
  renderBanners();
}

function hideAppBanner(id) {
  if (appBanners.delete(id))
    renderBanners();
}

function renderBanners() {
  const box = $('banners');
  box.replaceChildren();
  const all = [...appBanners.values(), ...(active ? active.banners.values() : [])];
  for (const b of all) {
    const row = el('div', {className: 'banner ' + b.level}, el('p', {textContent: b.text}));
    for (const [label, fn] of b.actions)
      row.append(el('button', {type: 'button', textContent: label, onclick: fn}));
    box.append(row);
  }
}

function refreshState() {
  const doc = active;
  $('startPanel').hidden = !!doc;
  $('saveBtn').disabled = !doc || !doc.loaded || doc.restoreOpen || doc.conflict ||
                          (doc.canSave && doc.loc.kind !== 'new' ? !doc.dirty && !doc.saving : false);
  $('saveMenuItem').disabled = $('saveBtn').disabled;
  $('saveAsBtn').disabled = !doc || !doc.loaded || doc.restoreOpen || doc.saving;
  $('closeMenuItem').disabled = !doc;
  const name = $('docName');
  name.textContent = doc ? doc.name : 'PeergosEasyEdit';
  name.title = doc ? Loc.folder(doc.lasting || doc.loc) : '';
  name.classList.toggle('dirty', !!doc && doc.dirty);
  if (doc) {
    doc.area.readOnly = !doc.loaded || doc.restoreOpen || doc.readOnly === true;
    for (const d of docs) {
      d.area.hidden = d !== doc;
      if (d === doc) d.area.id = 'editor'; else d.area.removeAttribute('id');
    }
  }
  const s = $('status');
  if (!doc) {
    s.className = 'status';
    s.textContent = '';
  } else if (doc.saving) {
    s.className = 'status busy';
    s.textContent = doc.slow ? 'Saving… Peergos has not answered yet' : 'Saving…';
  } else if (doc.state === 'loading') {
    s.className = 'status busy';
    s.textContent = 'Opening…';
  } else if (!doc.loaded) {
    s.className = 'status error';
    s.textContent = doc.state === 'missing' ? 'Not found' : 'Not opened';
  } else if (doc.conflict) {
    s.className = 'status warn';
    s.textContent = 'Not saved – see above';
  } else if (doc.dirty) {
    s.className = 'status warn';
    s.textContent = doc.loc.kind === 'new' ? 'Not saved yet' : 'Unsaved changes';
  } else if (doc.savedAt) {
    s.className = doc.checked ? 'status ok' : 'status warn';
    s.textContent = (doc.checked ? 'Saved ✓ ' : 'Saved (not checked) ') +
                    doc.savedAt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  } else {
    s.className = 'status';
    s.textContent = doc.readOnly ? 'Read only' : doc.canSave && doc.loc.kind !== 'new' ? 'No changes' : '';
  }
  document.title = (doc ? (doc.dirty ? '● ' : '') + doc.name + ' – ' : '') + 'PeergosEasyEdit';
  renderBanners();
}

/* ---------- tabs and documents ---------- */

function renderTabs() {
  const bar = $('tabs');
  bar.hidden = !settings.tabs || docs.length === 0;
  if (bar.hidden)
    return;
  bar.replaceChildren(...docs.map(d => {
    const tab = el('div', {className: 'tab' + (d === active ? ' active' : '') + (d.dirty ? ' dirty' : ''), title: Loc.folder(d.lasting || d.loc)},
      el('button', {type: 'button', className: 'tab-name', textContent: d.name, onclick: () => activate(d)}),
      el('button', {type: 'button', className: 'tab-close', textContent: '×', title: 'Close', onclick: () => closeDoc(d)}));
    tab.addEventListener('auxclick', e => { if (e.button === 1) closeDoc(d); });
    return tab;
  }), el('button', {type: 'button', className: 'tab-new', textContent: '+', title: 'New text', onclick: () => newDoc()}));
}

function activate(doc) {
  active = doc;
  refreshState();
  renderTabs();
  LineNumbers.refresh();
  if (doc && doc.loaded && !doc.area.readOnly)
    doc.area.focus();
  saveSession();
}

function addDoc(doc) {
  docs.push(doc);
  $('editorArea').insertBefore(doc.area, $('measure'));
  doc.area.addEventListener('input', () => {
    Docs.edited(doc);
    if (doc === active && settings.lineNumbers)
      LineNumbers.later();
  });
  doc.area.addEventListener('scroll', () => { if (doc === active) LineNumbers.follow(); });
  applyLook(doc.area);
  return doc;
}

function removeDoc(doc) {
  clearTimeout(doc.autoTimer);
  clearTimeout(doc.draftTimer);
  doc.area.remove();
  docs.splice(docs.indexOf(doc), 1);
  if (active === doc)
    active = docs[docs.length - 1] || null;
  activate(active);
  if (!active)
    renderStart();
}

// Without tabs one document at a time: a new one replaces it, after asking about unsaved changes.
async function makeRoomFor() {
  if (settings.tabs)
    return true;
  for (const d of docs.slice())
    if (!await closeDoc(d))
      return false;
  return true;
}

async function closeDoc(doc) {
  if (doc.dirty && !doc.readOnly) {
    const answer = await askSaveChanges(doc.name);
    if (answer === null)
      return false;
    if (answer === 'save') {
      await Docs.save(doc);
      if (doc.dirty)   // not saved (failed, cancelled or waiting for a decision): keep the tab
        return false;
    } else {
      await Docs.dropDraft(doc);
    }
  }
  removeDoc(doc);
  saveSession();
  return true;
}

async function newDoc() {
  if (!await makeRoomFor())
    return;
  const names = new Set(docs.map(d => d.name));
  let n = 1, name = 'untitled.txt';
  while (names.has(name))
    name = 'untitled ' + (++n) + '.txt';
  const doc = addDoc(new Doc(Loc.newDoc(name)));
  await Docs.load(doc);
  activate(doc);
}

// Opens a location (or shows it when it is open already). Resolves to the document.
async function openLoc(loc, options = {}) {
  const open = docs.find(d => Loc.same(d.loc, loc) || (d.lasting && Loc.same(d.lasting, loc)));
  if (open) {
    activate(open);
    return open;
  }
  if (!options.keepOthers && !await makeRoomFor())
    return null;
  const doc = addDoc(new Doc(loc));
  if (options.draftText !== undefined) {
    doc.area.value = options.draftText;
    doc.draftStored = true;
  }
  activate(doc);
  await Docs.load(doc);
  if (doc.loaded)
    noteRecent(doc);
  else if (doc.state === 'missing')
    markRecentMissing(loc);
  saveSession();
  LineNumbers.refresh();
  return doc;
}

async function openDialog() {
  if (!Files.supported())
    return openWithPicker();
  const loc = await Files.show('open', '', active && (active.lasting || active.loc));
  if (!loc)
    return;
  if (loc.picker)
    return openWithPicker();
  await openLoc(loc);
}

// Peergos' own file picker: any file in the drive, for this session only.
async function openWithPicker() {
  let answer;
  try {
    answer = await Peergos.pickFile();
  } catch (e) {
    toast('The file picker could not be opened: ' + describeError(e), 'error');
    return;
  }
  if (!answer.length)
    return;
  const [path, writable] = answer;
  if (!Peergos.sendablePath(path)) {
    toast('Peergos cannot pass this file name to apps unchanged (it holds # or ?). Open it from a granted folder.', 'error');
    return;
  }
  await openLoc({kind: 'picked', path, writable: writable === true});
}

/* ---------- recent files ---------- */

let recent = [];        // [{key, loc, name, folder, at, missing}]

async function loadRecent() {
  try {
    const list = await Store.readJSON('recent.json');
    recent = Array.isArray(list) ? list.filter(r => r && Loc.valid(r.loc)) : [];
  } catch (e) {
    recent = [];
    toast('Recent files could not be read from Peergos: ' + describeError(e), 'error');
  }
}

function saveRecent() {
  Store.writeJSON('recent.json', recent).catch(e => toast('Recent files not saved in Peergos: ' + describeError(e), 'error'));
}

function noteRecent(doc) {
  if (!settings.recent || doc.loc.kind === 'new')
    return;
  const loc = doc.lasting || doc.loc;
  const key = Loc.key(loc);
  const folder = Loc.folder(loc);
  recent = [{key, loc: Loc.plain(loc), name: doc.name, folder, at: Date.now()},
            ...recent.filter(r => r.key !== key && r.key !== Loc.key(doc.loc) && !(r.folder === folder && r.name === doc.name))]
    .slice(0, settings.recent);
  saveRecent();
}

function markRecentMissing(loc) {
  const r = recent.find(x => x.key === Loc.key(loc) || (x.folder === Loc.folder(loc) && x.name === Loc.name(loc)));
  if (r && !r.missing) {
    r.missing = true;
    saveRecent();
  }
}

function forgetRecent(key) {
  recent = recent.filter(r => r.key !== key);
  saveRecent();
  renderRecent();
}

function recentItems(onPick) {
  if (!settings.recent || !recent.length)
    return [el('p', {className: 'recent-empty', textContent: settings.recent ? 'No recent files yet.' : 'Recent files are switched off (Options).'})];
  return recent.slice(0, settings.recent).map(r => {
    // opened from the Drive earlier: reachable again once its folder is granted
    const loc = Loc.lasting(r.loc) ? r.loc : Files.inGrant(r.loc.path);
    const reachable = !!loc;
    const row = el('div', {className: 'recent-row' + (r.missing ? ' missing' : '')},
      el('button', {type: 'button', className: 'recent-open', disabled: !reachable,
                    title: reachable ? r.folder : 'Opened from the Drive in an earlier session: open it from the Drive again, ' +
                                                  'or add its folder (File → Open… → Add folders…)',
                    onclick: () => { onPick && onPick(); openLoc(loc); }},
        el('span', {className: 'recent-name', textContent: r.name}),
        el('span', {className: 'recent-folder', textContent: r.missing ? 'not found – ' + r.folder : r.folder})),
      el('button', {type: 'button', className: 'recent-forget', textContent: '×', title: 'Remove from the list',
                    onclick: e => { e.stopPropagation(); forgetRecent(r.key); }}));
    return row;
  });
}

function renderRecent() {
  $('recentMenu').replaceChildren(...recentItems(() => closeMenus()));
  $('startRecent').replaceChildren(...recentItems());
}

/* ---------- the start panel (nothing open) ---------- */

async function renderStart() {
  renderRecent();
  const box = $('startDrafts');
  box.replaceChildren();
  if (!settings.drafts)
    return;
  let drafts = [];
  try {
    drafts = await Store.listDrafts();
  } catch (e) {
    return;
  }
  const openKeys = new Set(docs.flatMap(d => [d.key, d.lasting ? Loc.key(d.lasting) : '']));
  drafts = drafts.filter(d => !openKeys.has(d.key) && Loc.valid(d.loc));
  if (!drafts.length)
    return;
  box.append(el('h3', {textContent: 'Unsaved texts kept in Peergos'}),
    ...drafts.map(d => el('div', {className: 'recent-row'},
      el('button', {type: 'button', className: 'recent-open', disabled: !Loc.lasting(d.loc),
                    title: Loc.lasting(d.loc) ? '' : 'Open the file from the Drive: the draft is offered there',
                    onclick: () => d.loc.kind === 'new' ? openLoc(d.loc, {draftText: d.text}) : openLoc(d.loc)},
        el('span', {className: 'recent-name', textContent: d.name}),
        el('span', {className: 'recent-folder', textContent: timeText(d.at) + ' – ' + Loc.folder(d.loc)})),
      el('button', {type: 'button', className: 'recent-forget', textContent: '×', title: 'Delete this draft',
                    onclick: async () => {
                      if (await confirmAction('Delete the unsaved text "' + d.name + '" from ' + timeText(d.at) + '?', 'Delete')) {
                        await Store.deleteDraft(d.key).catch(e => toast(describeError(e), 'error'));
                        renderStart();
                      }
                    }}))));
}

/* ---------- the open tabs, kept in Peergos ---------- */

let sessionTimer = null;
let sessionReady = false;   // not written before the last session was read

function saveSession() {
  if (!sessionReady || !Peergos.inPeergos)
    return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    // a new text is listed even while empty: it comes back only if it has a draft by then
    const tabs = docs.map(d => ({loc: Loc.plain(d.lasting || d.loc), name: d.name}));
    Store.writeJSON('session.json', {tabs, active: active ? Loc.key(active.lasting || active.loc) : null})
      .catch(e => toast('Open tabs not saved in Peergos: ' + describeError(e), 'error'));
  }, 800);
}

// With tabs on, the tabs left open last time come back - on any device. A new text comes back from its draft.
async function restoreSession() {
  let session = null;
  try {
    session = await Store.readJSON('session.json');
  } catch (e) {
    toast('The tabs open last time could not be read from Peergos: ' + describeError(e), 'error');
  }
  sessionReady = true;
  if (!settings.tabs || !session || !Array.isArray(session.tabs))
    return;
  const skipped = [];
  for (const t of session.tabs) {
    if (!t || !Loc.valid(t.loc))
      continue;
    if (!Loc.lasting(t.loc)) {
      const loc = Files.inGrant(t.loc.path);
      if (loc)
        await openLoc(loc, {keepOthers: true});
      else
        skipped.push(t.name);
      continue;
    }
    if (t.loc.kind === 'new') {
      const draft = await Store.getDraft(Loc.key(t.loc)).catch(() => null);
      if (draft && draft.text)
        await openLoc(t.loc, {keepOthers: true, draftText: draft.text});
      continue;
    }
    await openLoc(t.loc, {keepOthers: true});
  }
  const want = docs.find(d => Loc.key(d.lasting || d.loc) === session.active);
  if (want)
    activate(want);
  if (skipped.length)
    showAppBanner('skipped', 'info', 'Not reopened (they were opened from the Drive, outside your granted folders): ' +
                  skipped.join(', ') + '. Open them from the Drive again.', [['OK', () => hideAppBanner('skipped')]]);
}

/* ---------- settings ---------- */

let settingsChain = Promise.resolve();
let settingsTimer = null;

function cleanSettings(s) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (s && typeof s === 'object') {
    if (THEMES.includes(s.theme)) out.theme = s.theme;
    if (typeof s.wrapLines === 'boolean') out.wrapLines = s.wrapLines;
    if (Number.isFinite(s.fontSize)) out.fontSize = Math.min(48, Math.max(8, Math.round(s.fontSize)));
    if (typeof s.fontFamily === 'string' && s.fontFamily.length < 200) out.fontFamily = s.fontFamily;
    if (AUTOSAVE_CHOICES.includes(s.autoSave)) out.autoSave = s.autoSave;
    for (const k of ['lineNumbers', 'showNotes', 'tabs', 'drafts'])
      if (typeof s[k] === 'boolean') out[k] = s[k];
    if (RECENT_CHOICES.includes(s.recent)) out.recent = s.recent;
  }
  return out;
}

function applyLook(area) {
  area.classList.toggle('wrap', settings.wrapLines);
  area.style.fontSize = settings.fontSize + 'px';
  area.style.fontFamily = settings.fontFamily;
}

function applySettings() {
  document.body.className = 'theme-' + settings.theme;
  $('themeSelect').value = settings.theme;
  $('wrapCheck').checked = settings.wrapLines;
  $('fontSizeLabel').textContent = settings.fontSize;
  if (![...$('fontSelect').options].some(o => o.value === settings.fontFamily))
    $('fontSelect').append(el('option', {value: settings.fontFamily, textContent: settings.fontFamily}));
  $('fontSelect').value = settings.fontFamily;
  $('autoSaveSelect').value = String(settings.autoSave);
  $('recentSelect').value = String(settings.recent);
  $('tabsCheck').checked = settings.tabs;
  $('draftsCheck').checked = settings.drafts;
  $('lineNumbersCheck').checked = settings.lineNumbers;
  $('notesPanel').hidden = !settings.showNotes;
  $('notesBtn').checked = settings.showNotes;
  for (const d of docs)
    applyLook(d.area);
  renderTabs();
  fitSandboxPage();
  LineNumbers.refresh();
}

// Peergos' sandbox page (same origin as the app) keeps the browser's 8 px body margin around the app's frame,
// which shows as a white border. Take it away and paint that page in the theme's colour.
function fitSandboxPage() {
  try {
    const page = window.parent !== window ? window.parent.document : null;
    if (!page || !page.getElementById('appSandboxId'))
      return;
    page.body.style.margin = '0';
    page.body.style.overflow = 'hidden';
    page.body.style.background = getComputedStyle(document.body).backgroundColor;
  } catch (e) {
    // another origin (an older Peergos): leave it as it is
  }
}

async function loadSettings() {
  try {
    const text = await Peergos.readData('settings.json');
    if (text !== null)
      settings = cleanSettings(JSON.parse(text));
  } catch (e) {
    toast('Your settings could not be read from Peergos: ' + describeError(e), 'error');
  }
  applySettings();
}

// Settings apply at once and are saved in Peergos shortly after the last change.
function changeSetting(name, value) {
  settings[name] = value;
  settings = cleanSettings(settings);
  applySettings();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const text = JSON.stringify(settings);
    settingsChain = settingsChain.then(() => Peergos.writeData('settings.json', text))
      .catch(e => toast('Settings not saved in Peergos: ' + describeError(e), 'error'));
  }, 600);
}

/* ---------- line numbers ---------- */

// One number per line of the file. With wrapping on, a long line takes several rows: its height is
// measured on a hidden copy of the text that has the editor's width and font.
const LineNumbers = (() => {
  let timer = null;

  function refresh() {
    clearTimeout(timer);
    const area = active && active.area;
    const on = settings.lineNumbers && !!area;
    $('gutter').hidden = !on;
    if (!on) {
      $('gutterLines').replaceChildren();
      return;
    }
    const lines = area.value.split('\n');
    const gutter = $('gutter');
    gutter.style.fontFamily = area.style.fontFamily;
    gutter.style.fontSize = area.style.fontSize;
    gutter.style.minWidth = (String(lines.length).length + 1.5) + 'ch';
    const rows = document.createDocumentFragment();
    if (settings.wrapLines) {
      const measure = $('measure');
      measure.style.fontFamily = area.style.fontFamily;
      measure.style.fontSize = area.style.fontSize;
      measure.style.width = area.clientWidth + 'px';
      measure.replaceChildren(...lines.map(l => el('div', {textContent: l || '​'})));
      const heights = [...measure.children].map(d => d.getBoundingClientRect().height);
      measure.replaceChildren();
      lines.forEach((_, i) => rows.append(el('div', {textContent: i + 1, style: 'height:' + heights[i] + 'px'})));
    } else {
      lines.forEach((_, i) => rows.append(el('div', {textContent: i + 1})));
    }
    $('gutterLines').replaceChildren(rows);
    follow();
  }

  function follow() {
    if (active)
      $('gutterLines').style.transform = 'translateY(' + (-active.area.scrollTop) + 'px)';
  }

  function later() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  }

  return {refresh, later, follow};
})();

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

// Every note in one window, each with a tick box, to read and copy at once.
function showAllNotes() {
  if (notes === null)
    return;
  const list = $('notesAllList');
  list.replaceChildren(...notes.map((note, i) => el('label', {},
    el('input', {type: 'checkbox', checked: true, value: String(i)}),
    el('div', {},
      el('div', {className: 'note-title', textContent: note.title || 'Untitled note'}),
      el('div', {className: 'note-body', textContent: note.content || ''})))));
  if (!notes.length)
    list.append(el('p', {textContent: 'There are no notes yet.'}));
  $('notesAllDialog').showModal();
}

function notesText(selectedOnly) {
  const boxes = [...$('notesAllList').querySelectorAll('input[type=checkbox]')];
  return boxes.filter(b => !selectedOnly || b.checked)
    .map(b => notes[Number(b.value)])
    .map(n => (n.title || 'Untitled note') + '\n\n' + (n.content || ''))
    .join('\n\n----------\n\n');
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(what + ' copied.');
  } catch (e) {
    // the clipboard API may be blocked in Peergos' frames: copy through a selected text box
    const box = el('textarea', {value: text});
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    toast(ok ? what + ' copied.' : 'Copying is not allowed here: select the text and press Ctrl+C.', ok ? '' : 'error');
  }
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

function copyExport() {
  copyText($('exportText').value, 'The export');
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

const MENUS = [['fileMenuBtn', 'fileMenu'], ['optionsMenuBtn', 'optionsMenu']];

function closeMenus(except) {
  for (const [b, m] of MENUS)
    if (m !== except) {
      $(m).hidden = true;
      $(b).setAttribute('aria-expanded', 'false');
    }
}

// Drop-down menus: one open at a time; Escape, a click outside or choosing an item closes it.
function wireMenus() {
  for (const [b, m] of MENUS) {
    $(b).onclick = e => {
      e.stopPropagation();
      const open = $(m).hidden;
      closeMenus(m);
      if (open && m === 'fileMenu')
        renderRecent();
      $(m).hidden = !open;
      $(b).setAttribute('aria-expanded', String(open));
      if (open) {
        const first = $(m).querySelector('button:not(:disabled), select, input');
        if (first) first.focus();
      }
    };
    $(m).addEventListener('click', e => {
      if (e.target.closest('button') && !e.target.closest('.recent-forget'))   // an action was chosen
        closeMenus(null);
    });
  }
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenus(null); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(null); });
}

function wire() {
  wireMenus();
  Files.wire();
  window.addEventListener('resize', () => LineNumbers.later());
  const saveActive = () => active && Docs.save(active);
  const saveActiveAs = () => active && Docs.saveAs(active);
  $('saveBtn').onclick = saveActive;
  $('saveMenuItem').onclick = saveActive;
  $('saveAsBtn').onclick = saveActiveAs;
  $('newMenuItem').onclick = () => newDoc();
  $('openMenuItem').onclick = () => openDialog();
  $('closeMenuItem').onclick = () => active && closeDoc(active);
  $('startNew').onclick = () => newDoc();
  $('startOpen').onclick = () => openDialog();
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (e.shiftKey) saveActiveAs(); else saveActive();
    }
  });
  // when the window is hidden (another tab, the app closed): autosave, and keep drafts in Peergos at once
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden')
      for (const d of docs) {
        Docs.autoSaveNow(d);
        Docs.storeDraft(d);
      }
  });

  $('themeSelect').onchange = e => changeSetting('theme', e.target.value);
  $('fontSelect').onchange = e => changeSetting('fontFamily', e.target.value);
  $('wrapCheck').onchange = e => changeSetting('wrapLines', e.target.checked);
  $('lineNumbersCheck').onchange = e => changeSetting('lineNumbers', e.target.checked);
  $('tabsCheck').onchange = e => { changeSetting('tabs', e.target.checked); saveSession(); };
  $('recentSelect').onchange = e => {
    changeSetting('recent', Number(e.target.value));
    recent = recent.slice(0, settings.recent);
    saveRecent();
    renderRecent();
  };
  $('autoSaveSelect').onchange = e => {
    changeSetting('autoSave', Number(e.target.value));
    for (const d of docs) {
      d.autoFailed = false;
      Docs.scheduleAutoSave(d);
    }
  };
  $('draftsCheck').onchange = e => changeSetting('drafts', e.target.checked);
  $('deleteDraftsBtn').onclick = async () => {
    let drafts = [];
    try {
      drafts = await Store.listDrafts();
    } catch (e) {
      toast(describeError(e), 'error');
      return;
    }
    if (!drafts.length) {
      toast('There are no drafts.');
      return;
    }
    if (!await confirmAction('Delete all ' + drafts.length + ' unsaved texts kept as drafts in Peergos?', 'Delete'))
      return;
    for (const d of drafts)
      await Store.deleteDraft(d.key).catch(() => {});
    for (const d of docs)
      d.draftStored = false;
    toast('Drafts deleted.');
    if (!active)
      renderStart();
  };
  $('fontBiggerBtn').onclick = () => changeSetting('fontSize', settings.fontSize + 2);
  $('fontSmallerBtn').onclick = () => changeSetting('fontSize', settings.fontSize - 2);

  $('notesBtn').onchange = e => {
    changeSetting('showNotes', e.target.checked);
    LineNumbers.later();   // the editor's width changed
  };
  $('addNoteBtn').onclick = () => editNote(null);
  $('showNotesBtn').onclick = showAllNotes;
  $('notesAllSelect').onclick = () => $('notesAllList').querySelectorAll('input').forEach(b => { b.checked = true; });
  $('notesAllNone').onclick = () => $('notesAllList').querySelectorAll('input').forEach(b => { b.checked = false; });
  $('notesCopySelected').onclick = () => copyText(notesText(true), 'Selected notes');
  $('notesCopyAll').onclick = () => copyText(notesText(false), 'All notes');
  $('noteCancel').onclick = () => $('noteDialog').close('cancel');
  $('promptCancel').onclick = () => $('promptDialog').close('cancel');
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
  await loadSettings();
  document.documentElement.classList.remove('loading');
  if (!Peergos.inPeergos) {
    showAppBanner('outside', 'info', 'This page runs outside Peergos, so there is no file to open or save. ' +
                  'Open PeergosEasyEdit from the Peergos Launcher or a text file in your Drive.');
    sessionReady = true;
    refreshState();
    renderStart();
    await loadNotes();
    return;
  }
  const moved = await Store.moveBrowserCopy().catch(() => 0);
  if (moved)
    toast(moved + ' unsaved text(s) kept in this browser by version 1.1.0 moved to drafts in Peergos.');
  await Files.refreshGrants().catch(() => null);
  await loadRecent();
  await restoreSession();
  const {path, trusted} = Peergos.filePathFromAddress(location.search);
  if (path && !trusted)
    showAppBanner('mangled', 'error', 'Peergos passed this file\'s name to the editor changed (names with + & # or % are ' +
                  'not passed on correctly), so the editor cannot read or save it safely and did not open it. Open it ' +
                  'with File → Open… from a granted folder (names are passed on correctly there), or rename it.',
                  [['Open…', () => openDialog()], ['OK', () => hideAppBanner('mangled')]]);
  else if (path)
    await openLoc({kind: 'chosen', path}, {keepOthers: true});
  if (!active)
    renderStart();
  refreshState();
  renderTabs();
  await loadNotes();
}

start();
