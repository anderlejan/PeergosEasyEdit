/* PeergosEasyEdit - where a document lives, and the Open / Save as dialog over the granted folders.
 *
 * A location is one of
 *   {kind: 'grant', grantId, rel}  a file in a granted folder: reachable after a restart and on every device
 *   {kind: 'chosen', path}         the file the app was opened on from the Drive: this session only
 *   {kind: 'picked', path}         a file from Peergos' file picker: this session only
 *   {kind: 'new', id, name}        a text that has no file yet
 * Granted folders are asked for once (Peergos shows its own dialog) and remembered by Peergos until the user
 * removes them, here or in the app's details on the Launcher. A folder inside the home folder can be granted,
 * the home folder itself cannot (Peergos 1.40). */
'use strict';

const Loc = {
  newDoc(name) {
    return {kind: 'new', id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name};
  },
  url(loc) {
    return loc.kind === 'grant' ? Peergos.grantUrl(loc.grantId, loc.rel) : Peergos.fileUrl(loc.path);
  },
  key(loc) {
    if (loc.kind === 'grant')
      return 'g:' + loc.grantId + '/' + loc.rel;
    return loc.kind === 'new' ? 'n:' + loc.id : 'p:' + loc.path;
  },
  name(loc) {
    if (loc.kind === 'new')
      return loc.name;
    const p = loc.kind === 'grant' ? loc.rel : loc.path;
    return p.substring(p.lastIndexOf('/') + 1) || p;
  },
  lasting(loc) {
    return loc.kind === 'grant' || loc.kind === 'new';
  },
  // the folder, as shown to the user
  folder(loc) {
    if (loc.kind === 'grant') {
      const root = Files.grantPath(loc.grantId) || 'a granted folder';
      const dir = loc.rel.includes('/') ? loc.rel.substring(0, loc.rel.lastIndexOf('/')) : '';
      return dir ? root + '/' + dir : root;
    }
    if (loc.kind === 'new')
      return 'not saved yet';
    return loc.path.substring(0, loc.path.lastIndexOf('/')) || '/';
  },
  same(a, b) {
    return !!a && !!b && Loc.key(a) === Loc.key(b);
  },
  plain(loc) {
    return JSON.parse(JSON.stringify(loc));
  },
  valid(loc) {
    if (!loc || typeof loc !== 'object')
      return false;
    if (loc.kind === 'grant')
      return typeof loc.grantId === 'string' && typeof loc.rel === 'string' && loc.rel.length > 0;
    if (loc.kind === 'new')
      return typeof loc.id === 'string' && typeof loc.name === 'string';
    return (loc.kind === 'chosen' || loc.kind === 'picked') && typeof loc.path === 'string';
  },
};

const Files = (() => {
  let grantList = null;        // [{grantId, path, write, persist, stale}] or null when Peergos has no grants
  let state = null;            // the open dialog: {mode, grant, dir, selected, resolve}

  async function refreshGrants() {
    grantList = await Peergos.grants();
    return grantList;
  }

  function grantPath(grantId) {
    const g = (grantList || []).find(x => x.grantId === grantId);
    return g && !g.stale ? g.path : null;
  }

  const supported = () => grantList !== null;
  const usable = () => (grantList || []).filter(g => !g.stale && g.write);

  // The places in the granted folders where a file with this full path would be.
  const grantLocs = path => usable().filter(g => g.path && path.startsWith(g.path + '/'))
    .map(g => ({kind: 'grant', grantId: g.grantId, rel: path.substring(g.path.length + 1)}));

  // A file from an earlier session (opened from the Drive) that lies in a granted folder: reachable again.
  const inGrant = path => grantLocs(path)[0] || null;

  // A file to read only (a picture in a Markdown file): in any granted folder, also one granted read-only.
  const readable = path => {
    const g = (grantList || []).find(x => !x.stale && x.path && path.startsWith(x.path + '/'));
    return g ? {kind: 'grant', grantId: g.grantId, rel: path.substring(g.path.length + 1)} : null;
  };

  // A file opened from the Drive that lies in a granted folder: the same file as a lasting location, so its tab
  // and recent entry still work after a restart. Checked by reading it both ways.
  async function lastingFor(path, bytes) {
    for (const loc of grantLocs(path)) {
      try {
        if (TextCodec.sameBytes(await Peergos.readUrl(Loc.url(loc)), bytes))
          return loc;
      } catch (e) {
        // not readable that way: keep the session-only location
      }
    }
    return null;
  }

  /* ---------- the dialog ---------- */

  const $ = id => document.getElementById(id);

  function formatSize(n) {
    if (!Number.isFinite(n))
      return '';
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB';
  }

  function message(text, level) {
    const m = $('fdMessage');
    m.textContent = text || '';
    m.className = 'fd-message ' + (level || '');
    m.hidden = !text;
  }

  // Open: resolves to a location, {picker: true} (use Peergos' picker), or null (cancelled).
  // Save: resolves to a location (a file that may exist), or null.
  function show(mode, suggestedName, near) {
    return new Promise(resolve => {
      state = {mode, grant: null, dir: '', selected: null, resolve};
      const d = $('fileDialog');
      $('fdTitle').textContent = mode === 'save' ? 'Save as' : 'Open';
      $('fdOk').textContent = mode === 'save' ? 'Save' : 'Open';
      $('fdSaveRow').hidden = mode !== 'save';
      $('fdPicker').hidden = mode !== 'open';
      $('fdName').value = suggestedName || '';
      message('');
      d.returnValue = '';
      d.showModal();
      const start = near && near.kind === 'grant' && usable().some(g => g.grantId === near.grantId) ? near : null;
      renderRoots();
      if (start)
        go(start.grantId, start.rel.includes('/') ? start.rel.substring(0, start.rel.lastIndexOf('/')) : '');
      else if (usable().length)
        go(usable()[0].grantId, '');
      else
        renderEmpty();
      if (mode === 'save')
        setTimeout(() => $('fdName').focus(), 0);
    });
  }

  function finish(result) {
    const s = state;
    state = null;
    $('fileDialog').close();
    if (s)
      s.resolve(result);
  }

  function renderRoots() {
    const box = $('fdRoots');
    box.replaceChildren();
    for (const g of grantList || []) {
      const name = g.stale ? '(folder no longer reachable)' : g.path.substring(g.path.lastIndexOf('/') + 1) || g.path;
      const row = el('div', {className: 'fd-root' + (state && state.grant === g.grantId ? ' current' : '')},
        el('button', {type: 'button', className: 'fd-root-name', textContent: '📁 ' + name, title: g.stale ? '' : g.path + (g.write ? '' : ' (read only)'),
                      disabled: g.stale || !g.write, onclick: () => go(g.grantId, '')}),
        el('button', {type: 'button', className: 'fd-root-remove', textContent: '×', title: 'Stop letting the editor use this folder',
                      onclick: () => removeGrant(g)}));
      box.append(row);
    }
    box.append(el('button', {type: 'button', className: 'fd-add', textContent: '+ Add folders…', onclick: addFolders}));
  }

  function renderEmpty() {
    $('fdCrumbs').replaceChildren();
    $('fdList').replaceChildren(el('p', {className: 'fd-empty', textContent:
      'The editor may not use any of your folders yet. Choose "Add folders…": Peergos asks which folders the editor ' +
      'may open and save files in, and remembers your answer on every device. You can remove a folder here at any time.'}));
    $('fdOk').disabled = true;
  }

  async function go(grantId, dir) {
    if (!state)
      return;
    state.grant = grantId;
    state.dir = dir;
    state.selected = null;
    renderRoots();
    const root = grantPath(grantId) || '';
    const crumbs = $('fdCrumbs');
    const parts = dir ? dir.split('/') : [];
    crumbs.replaceChildren(el('button', {type: 'button', textContent: root.substring(root.lastIndexOf('/') + 1) || root, onclick: () => go(grantId, '')}),
      ...parts.flatMap((p, i) => [' / ', el('button', {type: 'button', textContent: p, onclick: () => go(grantId, parts.slice(0, i + 1).join('/'))})]));
    const list = $('fdList');
    list.replaceChildren(el('p', {className: 'fd-empty', textContent: 'Loading…'}));
    updateOk();
    let listing;
    try {
      listing = await Peergos.listFolder(grantId, dir);
    } catch (e) {
      list.replaceChildren(el('p', {className: 'fd-empty', textContent: 'The folder could not be read: ' + describeError(e)}));
      return;
    }
    if (!state || state.grant !== grantId || state.dir !== dir)
      return;   // the user went elsewhere meanwhile
    if (listing === null) {
      list.replaceChildren(el('p', {className: 'fd-empty', textContent: 'This folder is no longer there.'}));
      return;
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'});
    const rows = [
      ...(dir ? [el('button', {type: 'button', className: 'fd-row folder', onclick: () => go(grantId, parts.slice(0, -1).join('/'))},
                   el('span', {textContent: '⬑ ..'}))] : []),
      ...listing.subFolders.sort(byName).map(f => el('button', {type: 'button', className: 'fd-row folder',
        onclick: () => go(grantId, dir ? dir + '/' + f.name : f.name)}, el('span', {textContent: '📁 ' + f.name}))),
      ...listing.files.sort(byName).map(f => {
        const row = el('button', {type: 'button', className: 'fd-row file'},
          el('span', {textContent: '📄 ' + f.name}),
          el('span', {className: 'fd-meta', textContent: [formatSize(f.size), f.modified ? timeText(f.modified) : ''].filter(Boolean).join('  ·  ')}));
        row.onclick = () => select(f.name, row);
        row.ondblclick = () => { select(f.name, row); ok(); };
        return row;
      }),
    ];
    list.replaceChildren(...(rows.length ? rows : [el('p', {className: 'fd-empty', textContent: 'This folder is empty.'})]));
  }

  function select(name, row) {
    state.selected = name;
    for (const r of $('fdList').querySelectorAll('.fd-row'))
      r.classList.toggle('selected', r === row);
    if (state.mode === 'save')
      $('fdName').value = name;
    updateOk();
  }

  function updateOk() {
    if (!state)
      return;
    $('fdOk').disabled = !state.grant || (state.mode === 'open' ? !state.selected : !validName($('fdName').value));
  }

  function validName(name) {
    const n = name.trim();
    return n.length > 0 && n.length <= 255 && !n.startsWith('.') && !/[\/\\\u0000-\u001f]/.test(n);
  }

  async function ok() {
    if (!state || !state.grant)
      return;
    const name = state.mode === 'open' ? state.selected : $('fdName').value.trim();
    if (!name || (state.mode === 'save' && !validName(name)))
      return;
    const rel = state.dir ? state.dir + '/' + name : name;
    finish({kind: 'grant', grantId: state.grant, rel});
  }

  async function newFolder() {
    if (!state || !state.grant)
      return;
    const name = await askText('Name of the new folder', '', 'Create');
    if (name === null)
      return;
    if (!validName(name)) {
      message('A folder name must not be empty, start with a dot or hold / or \\.', 'error');
      return;
    }
    const rel = state.dir ? state.dir + '/' + name.trim() : name.trim();
    try {
      await Peergos.makeFolder(state.grant, rel);
      go(state.grant, rel);
    } catch (e) {
      message('The folder was not created: ' + describeError(e), 'error');
    }
  }

  async function addFolders() {
    message('Peergos asks which folders the editor may use…');
    try {
      const added = await Peergos.askForFolders();
      await refreshGrants();
      const writable = added.filter(g => g.write);
      message(added.length === 0 ? '' : writable.length < added.length
        ? 'A folder was granted without "change files": the editor can only save in folders it may change.' : '',
        writable.length < added.length ? 'warn' : '');
      renderRoots();
      if (writable.length)
        go(writable[0].grantId, '');
      else if (!state.grant && usable().length)
        go(usable()[0].grantId, '');
    } catch (e) {
      message('The folders could not be added: ' + describeError(e), 'error');
    }
  }

  async function removeGrant(g) {
    const what = g.stale ? 'this folder' : g.path;
    if (!await confirmAction('Stop letting PeergosEasyEdit use ' + what + '? Its files stay where they are; the editor ' +
                             'can open them again after you add the folder again.', 'Remove'))
      return;
    try {
      await Peergos.revokeGrant(g.grantId);
      await refreshGrants();
      renderRoots();
      if (state && state.grant === g.grantId) {
        if (usable().length) go(usable()[0].grantId, ''); else renderEmpty();
      }
    } catch (e) {
      message('The folder could not be removed: ' + describeError(e), 'error');
    }
  }

  function wire() {
    $('fdOk').onclick = ok;
    $('fdCancel').onclick = () => finish(null);
    $('fdNewFolder').onclick = newFolder;
    $('fdPicker').onclick = () => finish({picker: true});
    $('fdName').addEventListener('input', updateOk);
    $('fdName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    $('fileDialog').addEventListener('cancel', e => { e.preventDefault(); finish(null); });
  }

  return {refreshGrants, grantPath, supported, usable, inGrant, readable, lastingFor, show, wire};
})();
