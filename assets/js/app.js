/* PeergosEasyEdit - the application: tabs, menus, settings, recent files, the start panel and notes.
 * Documents (loading, saving, drafts) are in docs.js, locations and the file dialog in files.js, what is kept in
 * Peergos in store.js. Nothing is stored on the device: settings, the open tabs, recent files, notes and drafts
 * live in the app's own Peergos folder, so every device shows the same. */
'use strict';

const AUTOSAVE_CHOICES = [0, 2, 5, 10, 30];   // seconds after the last change; 0 = off
const RECENT_CHOICES = [0, 5, 10, 20];
const UI_SIZES = [12, 13, 14, 15, 16, 18, 20];   // px: menus, buttons, dialogs - not the text being edited
const UI_SIZE_RANGE = [10, 32];                   // any whole number in it can be typed in (Custom…)
const FONT_SIZE_RANGE = [6, 96];                  // the text being edited
const SIDE_PANELS = ['off', 'notes', 'history'];
const PANEL_WIDTH_RANGE = [160, 2000];            // px, dragged at the panel's edge; 0 = the normal width
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const $ = id => document.getElementById(id);

const DEFAULT_SETTINGS = {theme: 'green-on-black', wrapLines: true, fontSize: 14,
                          fontFamily: "'Lucida Console', 'Lucida Sans Typewriter', monospace",
                          autoSave: 5, lineNumbers: false, sidePanel: 'off', tabs: false, recent: 10, drafts: true,
                          uiSize: 14, history: true, panelButtons: true, panelWidth: 0, mdTools: false,
                          spellcheck: false, counts: true};
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
  // the file now has another name: the old one is gone from recent files
  renamed(doc, oldKeys) {
    if (oldKeys.length) {
      recent = recent.filter(r => !oldKeys.includes(r.key));
      noteRecent(doc);
    }
    saveSession();
    refreshState();
    renderTabs();
  },
  historyChanged(doc) {
    if (doc === active)
      EditPanel.later();
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
  $('exportMenuItem').disabled = !doc || !doc.loaded;
  $('findMenuItem').disabled = $('replaceMenuItem').disabled = !doc || !doc.loaded;
  $('renameMenuItem').disabled = !doc || !doc.loaded || doc.saving || doc.renaming || doc.restoreOpen;
  const editable = canEdit(doc);
  $('undoBtn').disabled = !editable || (!!doc.history && !doc.history.canUndo);
  $('redoBtn').disabled = !editable || (!!doc.history && !doc.history.canRedo);
  const name = $('docName');
  name.textContent = doc ? doc.name : 'PeergosEasyEdit';
  name.title = doc ? Loc.folder(doc.lasting || doc.loc) : '';
  name.classList.toggle('dirty', !!doc && doc.dirty);
  if (doc) {
    doc.area.readOnly = !doc.loaded || doc.restoreOpen || doc.readOnly === true;
    for (const d of docs) {
      d.area.hidden = d !== doc;
      if (d === doc) d.area.id = 'editor'; else d.area.removeAttribute('id');
      Markdown.layout(d, d === doc);     // a Markdown file shown formatted instead
    }
  }
  Markdown.bar(doc);
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

// With tabs off there is no tab bar: the × next to the file name in the bar closes the one open file.
function renderTabs() {
  const bar = $('tabs');
  bar.hidden = !settings.tabs || docs.length === 0;
  $('closeDocBtn').hidden = settings.tabs || !active;
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
  Counts.show();
  Find.activated();
  renderTabs();
  LineNumbers.refresh();
  EditPanel.render();
  if (doc && doc.loaded && !doc.area.readOnly)
    doc.area.focus();
  saveSession();
}

function addDoc(doc) {
  docs.push(doc);
  $('editorArea').insertBefore(doc.area, $('measure'));
  doc.area.addEventListener('input', e => {
    Docs.edited(doc, editKind(e.inputType));
    if (doc === active && settings.lineNumbers)
      LineNumbers.later();
    if (doc === active) {
      Counts.later();
      Find.textChanged();
    }
  });
  // Tab indents (Shift+Tab takes it back); after Escape the next Tab moves on, as usual, for keyboard users
  let tabMovesOn = false;
  doc.area.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      tabMovesOn = true;
      return;
    }
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || doc.area.readOnly || tabMovesOn) {
      tabMovesOn = false;
      return;
    }
    e.preventDefault();
    indent(doc.area, e.shiftKey);
  });
  doc.area.addEventListener('keydown', e => Markdown.sourceKey(doc, e));
  // the editor's own undo and redo, also from the browser's context menu
  doc.area.addEventListener('beforeinput', e => {
    if (doc.history && (e.inputType === 'historyUndo' || e.inputType === 'historyRedo')) {
      e.preventDefault();
      if (e.inputType === 'historyUndo') undo(); else redo();
    }
  });
  doc.area.addEventListener('keydown', e => {
    if (!doc.history || !(e.ctrlKey || e.metaKey) || e.altKey)
      return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'y') {
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
    }
  });
  doc.area.addEventListener('scroll', () => {
    if (doc === active) {
      LineNumbers.follow();
      Find.follow();
    }
  });
  applyLook(doc.area);
  return doc;
}

function removeDoc(doc) {
  Markdown.drop(doc);
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
  Markdown.flush(doc);
  if (doc.dirty && !doc.readOnly) {
    if (doc !== active)
      activate(doc);      // show what the question is about
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

// Open… starts in the folder of the file opened last (recent files are kept in Peergos: on every device), else in
// the folder of the file shown.
async function openDialog() {
  if (!Files.supported())
    return openWithPicker();
  const loc = await Files.show('open', '', recentPlace() || (active && (active.lasting || active.loc)));
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

/* ---------- undo, redo and the edit history panel ---------- */

function applyHistory(doc, state) {
  if (!state)
    return;
  doc.area.value = state.text;
  doc.area.setSelectionRange(state.selStart, state.selEnd);
  doc.area.focus();
  Docs.edited(doc);       // the history already holds this text: nothing new is recorded
  App.historyChanged(doc);
  if (settings.lineNumbers)
    LineNumbers.later();
}

const canEdit = doc => !!doc && doc.loaded && !doc.readOnly && !doc.restoreOpen;

// With the edit history off (Options), the browser's own undo of the text box is used.
function browserUndo(doc, command) {
  doc.area.focus();
  document.execCommand(command);
}

function undo() {
  if (!canEdit(active)) return;
  if (active.history) applyHistory(active, active.history.undo()); else browserUndo(active, 'undo');
}

function redo() {
  if (!canEdit(active)) return;
  if (active.history) applyHistory(active, active.history.redo()); else browserUndo(active, 'redo');
}

// Options → Edit history: off drops the steps kept so far; on starts from the text as it is now.
function setHistory(on) {
  changeSetting('history', on);
  for (const d of docs)
    d.history = on && d.loaded ? new EditHistory(d.area.value) : null;
  refreshState();
  EditPanel.render();
}

// Options → Side panel → Edit history: the steps of the open file, newest first; a click goes back (or forward)
// to that step. Undone steps stay listed until something new is typed.
const EditPanel = (() => {
  let timer = null;
  const clock = t => new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});

  function render() {
    clearTimeout(timer);
    timer = null;
    if (settings.sidePanel !== 'history')
      return;
    const list = $('historyList');
    const h = active && active.history;
    $('historyMessage').textContent = !settings.history ? 'The edit history is switched off (Options → Edit history).'
      : !active ? 'No file is open.'
      : !h ? 'The history starts when the file has been opened.'
      : h.dropped ? 'The oldest steps were dropped (the history keeps the last ' + HISTORY_MAX_STEPS + ').' : '';
    $('historyMessage').hidden = !$('historyMessage').textContent;
    if (!h) {
      list.replaceChildren();
      return;
    }
    const enabled = canEdit(active);
    const rows = h.steps.map((st, i) => {
      const b = el('button', {type: 'button', className: 'history-step' + (i >= h.pos ? ' undone' : '') + (i === h.pos - 1 ? ' current' : ''),
                              disabled: !enabled, title: i >= h.pos ? 'Redo up to this step' : 'Go back to just after this step',
                              onclick: () => applyHistory(active, h.goTo(i + 1))},
        el('span', {className: 'history-what', textContent: EditHistory.describe(st)}),
        el('span', {className: 'history-when', textContent: clock(st.at) + ' · line ' + st.line}));
      return el('li', {}, b);
    }).reverse();
    rows.push(el('li', {}, el('button', {type: 'button', className: 'history-step' + (h.pos === 0 ? ' current' : ''), disabled: !enabled,
                                         title: 'Go back to the text as it was opened', onclick: () => applyHistory(active, h.goTo(0))},
      el('span', {className: 'history-what', textContent: h.dropped ? 'Earlier steps' : 'Opened'}),
      el('span', {className: 'history-when', textContent: h.dropped ? '' : clock(h.openedAt)}))));
    list.replaceChildren(...rows);
  }

  // while typing, at most a few times a second
  function later() {
    if (settings.sidePanel !== 'history' || timer)
      return;
    timer = setTimeout(() => { timer = null; render(); }, 250);
  }

  return {render, later};
})();

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

// The file opened last that lies in a granted folder (opened from the Drive counts when its folder is granted).
function recentPlace() {
  for (const r of recent) {
    const loc = r.loc.kind === 'grant' ? r.loc : r.loc.path ? Files.inGrant(r.loc.path) : null;
    if (loc && Files.grantPath(loc.grantId))
      return loc;
  }
  return null;
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

// The editor comes back as it was left, on any device: with tabs, the tabs left open; without, the one file
// (or nothing - then the start panel shows). A new text comes back from its draft. Opened on a file from the
// Drive (`fromDrive`) without tabs, that file is shown instead.
async function restoreSession(fromDrive) {
  let session = null;
  try {
    session = await Store.readJSON('session.json');
  } catch (e) {
    toast('The tabs open last time could not be read from Peergos: ' + describeError(e), 'error');
  }
  sessionReady = true;
  if (!session || !Array.isArray(session.tabs))
    return;
  let tabs = session.tabs.filter(t => t && Loc.valid(t.loc));
  if (!settings.tabs) {
    if (fromDrive)
      return;
    const last = tabs.find(t => Loc.key(t.loc) === session.active) || tabs[tabs.length - 1];
    tabs = last ? [last] : [];
  }
  const skipped = [];
  for (const t of tabs) {
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
  const want = docs.find(d => Loc.key(d.lasting || d.loc) === session.active ||
                             (d.loc.kind === 'grant' && session.active === 'p:' + Files.grantPath(d.loc.grantId) + '/' + d.loc.rel));
  if (want)
    activate(want);
  if (skipped.length)
    showAppBanner('skipped', 'info', 'Not reopened (opened from the Drive, outside your granted folders): ' +
                  skipped.join(', ') + '. Open from the Drive again, or grant the folder (File → Open… → Add folders…) ' +
                  'so it comes back by itself.', [['OK', () => hideAppBanner('skipped')]]);
}

/* ---------- settings ---------- */

let settingsChain = Promise.resolve();
let settingsTimer = null;

const clamp = (n, [min, max]) => Math.min(max, Math.max(min, Math.round(n)));

function cleanSettings(s) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (s && typeof s === 'object') {
    if (THEMES.includes(s.theme)) out.theme = s.theme;
    if (typeof s.wrapLines === 'boolean') out.wrapLines = s.wrapLines;
    if (Number.isFinite(s.fontSize)) out.fontSize = clamp(s.fontSize, FONT_SIZE_RANGE);
    if (typeof s.fontFamily === 'string' && s.fontFamily.length < 200) out.fontFamily = s.fontFamily;
    if (AUTOSAVE_CHOICES.includes(s.autoSave)) out.autoSave = s.autoSave;
    for (const k of ['lineNumbers', 'tabs', 'drafts', 'history', 'panelButtons', 'mdTools', 'spellcheck', 'counts'])
      if (typeof s[k] === 'boolean') out[k] = s[k];
    if (Number.isFinite(s.panelWidth)) out.panelWidth = s.panelWidth > 0 ? clamp(s.panelWidth, PANEL_WIDTH_RANGE) : 0;
    if (RECENT_CHOICES.includes(s.recent)) out.recent = s.recent;
    if (SIDE_PANELS.includes(s.sidePanel)) out.sidePanel = s.sidePanel;
    else if (s.showNotes === true) out.sidePanel = 'notes';      // 1.2.0 and older
    if (Number.isFinite(s.uiSize)) out.uiSize = clamp(s.uiSize, UI_SIZE_RANGE);
  }
  return out;
}

function applyLook(area) {
  area.spellcheck = settings.spellcheck;
  area.classList.toggle('wrap', settings.wrapLines);
  area.style.fontSize = settings.fontSize + 'px';
  area.style.fontFamily = settings.fontFamily;
}

function applySettings() {
  document.body.className = 'theme-' + settings.theme;
  $('themeSelect').value = settings.theme;
  $('wrapCheck').checked = settings.wrapLines;
  $('fontSizeInput').value = settings.fontSize;
  $('historyCheck').checked = settings.history;
  if (![...$('fontSelect').options].some(o => o.value === settings.fontFamily))
    $('fontSelect').append(el('option', {value: settings.fontFamily, textContent: settings.fontFamily}));
  $('fontSelect').value = settings.fontFamily;
  $('autoSaveSelect').value = String(settings.autoSave);
  $('recentSelect').value = String(settings.recent);
  $('tabsCheck').checked = settings.tabs;
  $('draftsCheck').checked = settings.drafts;
  $('lineNumbersCheck').checked = settings.lineNumbers;
  $('notesPanel').hidden = settings.sidePanel !== 'notes';
  $('historyPanel').hidden = settings.sidePanel !== 'history';
  $('panelHandle').hidden = settings.sidePanel === 'off';
  PanelWidth.apply(settings.panelWidth);
  $('sidePanelSelect').value = settings.sidePanel;
  $('panelButtonsCheck').checked = settings.panelButtons;
  $('mdToolsCheck').checked = settings.mdTools;
  $('spellCheck').checked = settings.spellcheck;
  $('countsCheck').checked = settings.counts;
  Counts.later();
  $('panelButtons').hidden = !settings.panelButtons;
  $('notesPanelBtn').setAttribute('aria-pressed', String(settings.sidePanel === 'notes'));
  $('historyPanelBtn').setAttribute('aria-pressed', String(settings.sidePanel === 'history'));
  const ui = $('uiSizeSelect');
  if (![...ui.options].some(o => o.value === String(settings.uiSize)))   // a size typed in earlier
    ui.insertBefore(el('option', {value: String(settings.uiSize), textContent: settings.uiSize + ' (custom)'}), $('uiSizeCustom'));
  ui.value = String(settings.uiSize);
  document.documentElement.style.setProperty('--ui-size', settings.uiSize + 'px');
  document.documentElement.style.setProperty('--text-size', settings.fontSize + 'px');   // also the formatted view
  EditPanel.render();
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
    const on = settings.lineNumbers && !!area && !Markdown.formatted(active);
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

/* ---------- the side panel: switching it, and its width ---------- */

// The Notes and History buttons in the bar: a click shows that panel, a click on the one shown hides it.
function toggleSidePanel(which) {
  changeSetting('sidePanel', settings.sidePanel === which ? 'off' : which);
  LineNumbers.later();   // the editor's width changed
}

// Drag the panel's left edge (or ← → on it) to make the panel wider or narrower; a double-click gives the
// normal width back. The width is saved with the settings when the drag ends.
const PanelWidth = (() => {
  const panels = () => [$('notesPanel'), $('historyPanel')];
  const shown = () => panels().find(p => !p.hidden);

  function apply(px) {
    for (const p of panels()) {
      p.style.width = px ? px + 'px' : '';
      p.style.maxWidth = px ? 'calc(100vw - 160px)' : '';
    }
  }

  // not wider than the window leaves room for the editor
  function fit(px) {
    const room = $('editorArea').parentElement.clientWidth - 160;
    return clamp(Math.min(px, Math.max(PANEL_WIDTH_RANGE[0], room)), PANEL_WIDTH_RANGE);
  }

  function wire() {
    const handle = $('panelHandle');
    let startX = 0, startW = 0, width = 0;
    handle.addEventListener('pointerdown', e => {
      const panel = shown();
      if (!panel || e.button !== 0)
        return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startW = width = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId))
        return;
      width = fit(startW + startX - e.clientX);    // the panel is on the right: dragging left widens it
      apply(width);
      LineNumbers.later();
    });
    const end = e => {
      if (!handle.hasPointerCapture(e.pointerId))
        return;
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      if (Math.round(width) !== Math.round(startW))
        changeSetting('panelWidth', Math.round(width));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => {
      changeSetting('panelWidth', 0);
      LineNumbers.later();
    });
    handle.addEventListener('keydown', e => {
      const panel = shown();
      if (!panel || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight'))
        return;
      e.preventDefault();
      const w = panel.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 20 : -20);
      changeSetting('panelWidth', fit(w));
      LineNumbers.later();
    });
  }

  return {apply, wire};
})();

// The mouse wheel over A− / the size / A+ changes the text size: one step per notch of the wheel
// (a touchpad's small movements add up to a step).
function wireFontWheel() {
  let sum = 0;
  $('fontSizeGroup').addEventListener('wheel', e => {
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (!dy)
      return;
    e.preventDefault();
    if (Math.sign(dy) !== Math.sign(sum))
      sum = 0;
    sum += dy;
    if (Math.abs(sum) < 50)
      return;
    sum = 0;
    changeSetting('fontSize', settings.fontSize + (dy < 0 ? 1 : -1));
    LineNumbers.later();
  }, {passive: false});
}

/* ---------- typing helpers: Tab, word count ---------- */

// Text typed into the text box as if by the user: the browser's undo and the editor's history both get it.
function insertText(area, text) {
  area.focus();
  if (!document.execCommand('insertText', false, text)) {
    area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
    area.dispatchEvent(new Event('input'));
  }
}

// Tab: a tab character, or - with several lines selected - a tab before each of them. Shift+Tab: one tab (or up to
// four spaces) less before each line of the selection.
function indent(area, out) {
  const v = area.value, s = area.selectionStart, e = area.selectionEnd;
  const several = v.slice(s, e).includes('\n');
  if (!out && !several) {
    insertText(area, '\t');
    return;
  }
  const start = v.lastIndexOf('\n', s - 1) + 1;
  const last = several && v[e - 1] === '\n' ? e - 1 : e;     // a selection ending at a line's start: not that line
  let end = v.indexOf('\n', last);
  if (end < 0)
    end = v.length;
  const before = v.slice(start, end);
  const after = before.split('\n').map(l => out ? l.replace(/^(\t| {1,4})/, '') : '\t' + l).join('\n');
  if (after === before)
    return;
  area.setSelectionRange(start, end);
  insertText(area, after);
  if (several)
    area.setSelectionRange(start, start + after.length);
  else
    area.setSelectionRange(Math.max(start, s - (before.length - after.length)), Math.max(start, s - (before.length - after.length)));
}

// Words and characters (line breaks not counted) in the bar - of the selection, when there is one.
const Counts = (() => {
  let timer = null;
  const words = t => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  const chars = t => t.replace(/[\r\n]/g, '').length - (t.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || []).length;
  const n = x => x.toLocaleString();

  function show() {
    timer = null;
    const box = $('counts');
    box.hidden = !settings.counts || !active || !active.loaded;
    if (box.hidden)
      return;
    const a = active.area, text = a.value;
    const sel = document.activeElement === a && a.selectionEnd > a.selectionStart ? text.slice(a.selectionStart, a.selectionEnd) : '';
    box.textContent = sel ? n(words(sel)) + ' of ' + n(words(text)) + ' words · ' + n(chars(sel)) + ' of ' + n(chars(text)) + ' characters'
                          : n(words(text)) + ' words · ' + n(chars(text)) + ' characters';
  }

  function later() {
    if (!timer)
      timer = setTimeout(show, 250);
  }

  document.addEventListener('selectionchange', () => { if (active && document.activeElement === active.area) later(); });
  return {later, show, words, chars};
})();

/* ---------- Find and Replace (Ctrl+F, Ctrl+H) ---------- */

// Works on the text in the text box. Its selection does not show while the find field has the focus, so the match is
// marked with a box drawn over it, placed by a hidden copy of the text box (same font, width and wrapping).
const Find = (() => {
  let hits = [];        // [start, end] of every match in the text shown
  let current = -1;
  let boxes = [];
  let mirror = null;
  const open = () => !$('findBar').hidden;

  function pattern() {
    const q = $('findInput').value;
    if (!q)
      return null;
    let src = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if ($('findWord').checked)
      src = '(?<![\\p{L}\\p{N}_])' + src + '(?![\\p{L}\\p{N}_])';
    return new RegExp(src, 'gu' + ($('findCase').checked ? '' : 'i'));
  }

  function search() {
    hits = [];
    const re = pattern();
    if (re && active && active.loaded)
      for (const m of active.area.value.matchAll(re)) {
        hits.push([m.index, m.index + m[0].length]);
        if (hits.length >= 100000)
          break;
      }
  }

  function showCount() {
    $('findCount').textContent = !$('findInput').value ? '' : hits.length ? (current + 1) + ' of ' + hits.length.toLocaleString()
                                                                          : 'No matches';
    $('findInput').classList.toggle('none', !!$('findInput').value && !hits.length);
    const editable = canEdit(active) && !(active && Markdown.formatted(active));
    $('replaceOne').disabled = $('replaceAll').disabled = !editable || !hits.length;
  }

  // the match at or after the caret (forwards) or before it
  function nearest(forward, from) {
    if (!hits.length)
      return -1;
    if (forward) {
      const i = hits.findIndex(h => h[0] >= from);
      return i < 0 ? 0 : i;
    }
    for (let i = hits.length - 1; i >= 0; i--)
      if (hits[i][1] <= from)
        return i;
    return hits.length - 1;
  }

  function select(i) {
    current = i;
    showCount();
    clearMarks();
    if (i < 0)
      return;
    const a = active.area;
    a.setSelectionRange(hits[i][0], hits[i][1]);
    place(true);
  }

  function clearMarks() {
    for (const b of boxes)
      b.remove();
    boxes = [];
  }

  // where the current match is in the text box, measured on the copy; scrolled into view when asked
  function place(scroll) {
    clearMarks();
    if (current < 0 || !active || !hits[current] || active.area.hidden)
      return;
    const a = active.area;
    const cs = getComputedStyle(a);
    if (!mirror) {
      mirror = el('div', {className: 'find-mirror'});
      $('editorArea').append(mirror);
    }
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'paddingTop',
                     'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak'])
      mirror.style[k] = cs[k];
    mirror.style.width = a.clientWidth + 'px';
    const [s, e] = hits[current];
    const v = a.value;
    let lineEnd = v.indexOf('\n', e);
    if (lineEnd < 0)
      lineEnd = v.length;
    const mark = el('span', {textContent: v.slice(s, e)});
    mirror.replaceChildren(v.slice(0, s), mark, v.slice(e, lineEnd));
    const base = mirror.getBoundingClientRect();
    const rects = [...mark.getClientRects()].map(r => ({top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height}));
    mirror.replaceChildren();
    if (!rects.length)
      return;
    if (scroll) {
      const r = rects[0];
      if (r.top < a.scrollTop || r.top + r.height > a.scrollTop + a.clientHeight)
        a.scrollTop = Math.max(0, r.top - a.clientHeight / 3);
      if (r.left < a.scrollLeft || r.left + r.width > a.scrollLeft + a.clientWidth)
        a.scrollLeft = Math.max(0, r.left - a.clientWidth / 3);
    }
    for (const r of rects) {
      const top = r.top - a.scrollTop, left = r.left - a.scrollLeft;
      if (top + r.height < 0 || top > a.clientHeight)
        continue;
      const b = el('div', {className: 'find-hit'});
      Object.assign(b.style, {top: a.offsetTop + top + 'px', left: a.offsetLeft + left + 'px', width: r.width + 'px', height: r.height + 'px'});
      $('editorArea').append(b);
      boxes.push(b);
    }
  }

  function refresh(fromCaret) {
    search();
    if (!active) {
      showCount();
      return;
    }
    const a = active.area;
    select(nearest(true, fromCaret ? a.selectionStart : 0));
  }

  function show(replace) {
    if (!active || !active.loaded)
      return;
    // in a Markdown or HTML file shown formatted, the text is searched in Source
    if (Markdown.formatted(active))
      Markdown.showSource(active);
    $('findBar').hidden = false;
    $('replaceRow').hidden = !replace;
    const a = active.area;
    const sel = a.value.slice(a.selectionStart, a.selectionEnd);
    if (sel && !sel.includes('\n'))
      $('findInput').value = sel;
    $('findInput').focus();
    $('findInput').select();
    refresh(true);
  }

  function hide() {
    if (!open())
      return;
    $('findBar').hidden = true;
    clearMarks();
    hits = [];
    current = -1;
    if (active && !active.area.hidden)
      active.area.focus();
  }

  function next(forward) {
    if (!open())
      return show(false);
    search();
    if (!hits.length)
      return select(-1);
    const a = active.area;
    const at = current >= 0 && hits[current] && a.selectionStart === hits[current][0] && a.selectionEnd === hits[current][1];
    if (at)
      select(forward ? (current + 1) % hits.length : (current - 1 + hits.length) % hits.length);
    else
      select(nearest(forward, forward ? a.selectionEnd : a.selectionStart));
  }

  function replaceOne() {
    if (!hits.length || current < 0)
      return;
    const a = active.area;
    const [s, e] = hits[current];
    if (a.selectionStart !== s || a.selectionEnd !== e)
      return select(current);
    a.setSelectionRange(s, e);
    insertText(a, $('replaceInput').value);
    search();
    select(nearest(true, s + $('replaceInput').value.length));
    $('replaceInput').focus();
  }

  function replaceAll() {
    const re = pattern();
    if (!re || !hits.length)
      return;
    const a = active.area;
    const count = hits.length;
    const by = $('replaceInput').value;
    const text = a.value.replace(re, () => by);
    a.setSelectionRange(0, a.value.length);
    insertText(a, text);
    a.setSelectionRange(0, 0);
    refresh(false);
    toast(count.toLocaleString() + ' replaced.');
    $('replaceInput').focus();
  }

  // the text or the file shown changed: the matches are found again, the mark follows
  let timer = null;
  function textChanged() {
    if (!open())
      return;
    clearMarks();
    clearTimeout(timer);
    timer = setTimeout(() => {
      search();
      if (current >= hits.length)
        current = hits.length - 1;
      showCount();
    }, 200);
  }

  function wire() {
    $('findInput').addEventListener('input', () => refresh(true));
    $('findCase').onchange = $('findWord').onchange = () => refresh(true);
    $('findNext').onclick = () => next(true);
    $('findPrev').onclick = () => next(false);
    $('replaceOne').onclick = replaceOne;
    $('replaceAll').onclick = replaceAll;
    $('findClose').onclick = hide;
    $('findMenuItem').onclick = () => show(false);
    $('replaceMenuItem').onclick = () => show(true);
    $('findInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        next(!e.shiftKey);
      }
    });
    $('replaceInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        replaceOne();
      }
    });
    $('findBar').addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hide();
      }
    });
    document.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'f' || k === 'h')) {
        // Ctrl+F on a formatted Markdown or HTML view: the browser's own find, which searches what is shown
        if (k === 'f' && active && Markdown.formatted(active))
          return;
        e.preventDefault();
        show(k === 'h');
      } else if (e.key === 'F3' && open()) {
        e.preventDefault();
        next(!e.shiftKey);
      }
    });
    window.addEventListener('resize', () => place(false));
  }

  return {show, hide, next, wire, textChanged, follow: () => place(false), activated: () => { if (open()) refresh(true); }};
})();

/* ---------- import from and export to this device ---------- */

// File → Import…: a text file from this device becomes a new text with the file's name; Save as… then puts it
// into Peergos (cancelled: it stays open as a new text, kept as a draft like any other).
async function importFile(file) {
  if (!file)
    return;
  if (file.size > IMPORT_MAX_BYTES) {
    toast('"' + file.name + '" is too big to edit here (more than ' + IMPORT_MAX_BYTES / 1024 / 1024 + ' MB).', 'error');
    return;
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    toast('"' + file.name + '" could not be read: ' + describeError(e), 'error');
    return;
  }
  const decoded = TextCodec.decode(bytes);
  if (!decoded.ok) {
    toast('"' + file.name + '" is not UTF-8 text, so it was not imported.', 'error');
    return;
  }
  if (!await makeRoomFor())
    return;
  const name = file.name.replace(/^\.+/, '').replace(/\//g, '-') || 'imported.txt';
  const doc = addDoc(new Doc(Loc.newDoc(name)));
  doc.area.value = decoded.text;
  doc.bom = decoded.bom;     // kept as they were in the file
  doc.eol = decoded.eol;
  await Docs.load(doc);
  activate(doc);
  Docs.edited(doc);
  await Docs.saveAs(doc);
}

// File → Export…: the text shown is downloaded to this device under a name the user can change. The browser decides
// where (its downloads folder, or it asks when "Ask where to save each file" is on): Peergos runs the app in a frame
// of another origin, where browsers refuse showSaveFilePicker ("Cross origin sub frames aren't allowed to show a file
// picker", Edge, 2026-10-25). Line endings and byte order mark are the file's; a file that is not UTF-8 gives UTF-8.
function exportActive() {
  const doc = active;
  if (!doc || !doc.loaded)
    return;
  Markdown.flush(doc);
  const d = $('exportDialog');
  $('exportName').value = doc.name;
  d.returnValue = '';
  d.showModal();
  $('exportName').focus();
  $('exportName').setSelectionRange(0, doc.name.lastIndexOf('.') > 0 ? doc.name.lastIndexOf('.') : doc.name.length);
  d.addEventListener('close', () => {
    const name = $('exportName').value.trim().replace(/[\\/]/g, '-');
    if (d.returnValue !== 'export' || !name || !docs.includes(doc))
      return;
    const bytes = TextCodec.encode(doc.area.value, doc.readOnly ? {} : doc);
    const url = URL.createObjectURL(new Blob([bytes], {type: 'text/plain;charset=utf-8'}));
    const a = el('a', {href: url, download: name});
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('"' + name + '" handed to your browser to save. To see it on this device: Ctrl+J (your downloads), then ' +
          '"Show in folder".');
  }, {once: true});
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
  showRecentSubmenu(false);
}

// A menu stays inside the window: when the bar wraps (many buttons, a narrow window) Options can sit at the left,
// where its menu, opening to the left of the button, was cut off.
function fitMenu(panel) {
  panel.style.left = panel.style.right = '';
  const r = panel.getBoundingClientRect();
  if (r.left < 4) {
    panel.style.left = '0';
    panel.style.right = 'auto';
  } else if (r.right > innerWidth - 4) {
    panel.style.left = 'auto';
    panel.style.right = '0';
  }
}

// File → Recent files ▸: opens beside the File menu on pointing at it, a click or →.
let submenuTimer = null;
function showRecentSubmenu(open) {
  clearTimeout(submenuTimer);
  $('recentSubmenu').hidden = !open;
  $('recentMenuBtn').setAttribute('aria-expanded', String(open));
}

function wireRecentSubmenu() {
  const btn = $('recentMenuBtn');
  btn.onclick = e => {      // opens it (pointing at it may have done so already); leaving or Escape closes it
    e.stopPropagation();
    showRecentSubmenu(true);
  };
  $('recentSub').addEventListener('mouseenter', () => showRecentSubmenu(true));
  // a moment's grace: the pointer crosses a small gap on its way into the submenu
  $('recentSub').addEventListener('mouseleave', () => {
    clearTimeout(submenuTimer);
    submenuTimer = setTimeout(() => showRecentSubmenu(false), 300);
  });
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      showRecentSubmenu(true);
      const first = $('recentSubmenu').querySelector('button:not(:disabled)');
      if (first) first.focus();
    }
  });
  $('recentSubmenu').addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      showRecentSubmenu(false);
      btn.focus();
    }
  });
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
        fitMenu($(m));
        const first = $(m).querySelector('button:not(:disabled), select, input');
        if (first) first.focus();
      }
    };
    $(m).addEventListener('click', e => {
      if (e.target.closest('button') && !e.target.closest('.recent-forget, #recentMenuBtn'))   // an action was chosen
        closeMenus(null);
    });
  }
  wireRecentSubmenu();
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
  $('closeDocBtn').onclick = () => active && closeDoc(active);
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
        Markdown.flush(d);
        Docs.autoSaveNow(d);
        Docs.storeDraft(d);
      }
  });

  $('themeSelect').onchange = e => changeSetting('theme', e.target.value);
  $('fontSelect').onchange = e => changeSetting('fontFamily', e.target.value);
  $('wrapCheck').onchange = e => changeSetting('wrapLines', e.target.checked);
  $('lineNumbersCheck').onchange = e => changeSetting('lineNumbers', e.target.checked);
  $('tabsCheck').onchange = async e => {
    if (!e.target.checked && docs.length > 1) {
      // one file at a time from now on: the others are closed, unsaved ones after asking
      const keep = active;
      for (const d of docs.filter(x => x !== keep))
        if (!await closeDoc(d)) {
          e.target.checked = true;
          activate(d);
          toast('Tabs stay on: "' + d.name + '" is still open.');
          return;
        }
      activate(keep);
    }
    changeSetting('tabs', e.target.checked);
    saveSession();
  };
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
  $('fontSizeInput').onchange = e => {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && e.target.value.trim() !== '')
      changeSetting('fontSize', n);
    else
      e.target.value = settings.fontSize;
  };
  $('historyCheck').onchange = e => setHistory(e.target.checked);

  $('sidePanelSelect').onchange = e => {
    changeSetting('sidePanel', e.target.value);
    LineNumbers.later();   // the editor's width changed
  };
  $('notesPanelBtn').onclick = () => toggleSidePanel('notes');
  $('historyPanelBtn').onclick = () => toggleSidePanel('history');
  $('panelButtonsCheck').onchange = e => changeSetting('panelButtons', e.target.checked);
  // the formatting buttons, and with them the Formatted view for any text, not only .md files
  $('mdToolsCheck').onchange = e => {
    if (active)
      Markdown.flush(active);
    changeSetting('mdTools', e.target.checked);
    refreshState();
    LineNumbers.refresh();
  };
  PanelWidth.wire();
  wireFontWheel();
  Markdown.wire();
  Find.wire();
  Files.setPlaceHint(recentPlace);
  $('spellCheck').onchange = e => {
    changeSetting('spellcheck', e.target.checked);
    Markdown.spellcheck();
  };
  $('countsCheck').onchange = e => changeSetting('counts', e.target.checked);      // Save as… of a new text starts there too
  $('importMenuItem').onclick = () => {
    $('importInput').value = '';
    $('importInput').click();
  };
  $('importInput').onchange = e => importFile(e.target.files[0]);
  $('exportMenuItem').onclick = exportActive;
  $('exportCancel').onclick = () => $('exportDialog').close('cancel');
  $('exportCopy').onclick = () => {
    $('exportDialog').close('cancel');
    if (active && active.loaded)
      copyText(active.area.value, 'The text of "' + active.name + '"');
  };
  $('uiSizeSelect').onchange = async e => {
    if (e.target.value === 'custom') {
      e.target.value = String(settings.uiSize);
      const answer = await askText('Interface size in pixels (' + UI_SIZE_RANGE.join('–') + '):', String(settings.uiSize));
      const n = Number(answer);
      if (answer === null || answer.trim() === '' || !Number.isFinite(n))
        return;
      changeSetting('uiSize', n);
    } else {
      changeSetting('uiSize', Number(e.target.value));
    }
    LineNumbers.later();
  };
  $('undoBtn').onclick = undo;
  $('redoBtn').onclick = redo;
  $('renameMenuItem').onclick = () => active && Docs.rename(active);
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
  const link = Peergos.startLink(location, Peergos.params.get('username'));
  $('startLinkText').value = link || '';
  $('startLinkRow').hidden = !link;
  $('startLinkMissing').hidden = !!link;
  $('copyStartLinkBtn').onclick = () => copyText(link, 'Start link');
  $('startLinkBtn').onclick = () => {
    $('helpDialog').showModal();
    $('startLinkHelp').scrollIntoView();
    if (link)
      $('startLinkText').select();
  };
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
  const {path, trusted} = Peergos.filePathFromAddress(location.search);
  await restoreSession(!!path || /[?&#]path=/.test(location.href));
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
