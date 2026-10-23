/* PeergosEasyEdit - what the app keeps in its own Peergos folder (STORE_APP_DATA): settings, notes, the open tabs,
 * recent files and drafts. Peergos encrypts it and every device sees the same. Nothing is kept on the device:
 * no texts, no file names, no settings.
 *
 * drafts/<id>.json - text that is not in its file yet: a new text, or changes while autosave is off or a save
 * failed. {key, loc, name, text, at}. Deleted once the text is saved. */
'use strict';

const Store = (() => {
  const queues = new Map();   // file name -> {value, waiters, running}

  async function readJSON(name) {
    const text = await Peergos.readData(name);
    return text === null ? null : JSON.parse(text);
  }

  // Writes to one file never overlap; a burst of changes becomes one write of the newest value.
  // value === undefined deletes the file.
  function writeJSON(name, value) {
    return new Promise((resolve, reject) => {
      let q = queues.get(name);
      if (!q) {
        q = {waiters: [], running: false};
        queues.set(name, q);
      }
      q.value = value;
      q.waiters.push({resolve, reject});
      if (!q.running)
        run(name, q);
    });
  }

  async function run(name, q) {
    q.running = true;
    while (q.waiters.length) {
      const waiters = q.waiters.splice(0);
      const value = q.value;
      try {
        if (value === undefined)
          await Peergos.deleteData(name);
        else
          await Peergos.writeData(name, JSON.stringify(value));
        waiters.forEach(w => w.resolve());
      } catch (e) {
        waiters.forEach(w => w.reject(e));
      }
    }
    q.running = false;
    queues.delete(name);
  }

  const remove = name => writeJSON(name, undefined);

  /* ---------- drafts ---------- */

  async function draftName(key) {
    return 'drafts/' + (await TextCodec.sha256(new TextEncoder().encode(key))).slice(0, 24) + '.json';
  }

  const getDraft = async key => readJSON(await draftName(key));
  const putDraft = async (key, record) => writeJSON(await draftName(key), Object.assign({key, at: Date.now()}, record));
  const deleteDraft = async key => remove(await draftName(key));

  // Every draft, newest first. [] when there is none.
  async function listDrafts() {
    const text = await Peergos.readData('drafts');
    if (text === null)
      return [];
    let names;
    try {
      const listing = JSON.parse(text);
      names = (listing.files || []).map(f => typeof f === 'string' ? f : f.name).filter(n => n.endsWith('.json'));
    } catch (e) {
      return [];
    }
    const drafts = [];
    for (const n of names) {
      try {
        const d = await readJSON('drafts/' + n);
        if (d && typeof d.key === 'string' && typeof d.text === 'string')
          drafts.push(d);
      } catch (e) {
        // an unreadable draft is left alone, never deleted
      }
    }
    return drafts.sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  /* ---------- the 1.1.0 copy in this browser ---------- */

  // 1.1.0 kept texts in this browser (IndexedDB). Unsaved ones become Peergos drafts; then the browser copy is
  // deleted. If moving fails, the browser copy stays for the next start - it is never written to again.
  async function moveBrowserCopy() {
    for (const k of Object.keys(localStorage || {}))
      if (k.startsWith('peergoseasyedit.'))
        try { localStorage.removeItem(k); } catch (e) { /* nothing kept there matters */ }
    if (typeof indexedDB === 'undefined' || !indexedDB.databases)
      return 0;
    let names;
    try {
      names = (await indexedDB.databases()).map(d => d.name);
    } catch (e) {
      return 0;
    }
    if (!names.includes('peergoseasyedit'))
      return 0;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('peergoseasyedit');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    let records = [];
    try {
      if (db.objectStoreNames.contains('backups'))
        records = await new Promise((resolve, reject) => {
          const req = db.transaction('backups', 'readonly').objectStore('backups').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
    } finally {
      db.close();
    }
    let moved = 0;
    for (const r of records) {
      if (r.state !== 'unsaved' || typeof r.text !== 'string' || r.text === '')
        continue;
      const isFile = r.key && r.key !== 'untitled';
      const loc = isFile ? {kind: 'chosen', path: r.key} : {kind: 'new', id: 'moved-' + (r.at || Date.now()), name: 'untitled.txt'};
      const key = isFile ? 'p:' + r.key : 'n:' + loc.id;
      await putDraft(key, {loc, name: isFile ? r.key.substring(r.key.lastIndexOf('/') + 1) : 'untitled.txt', text: r.text, at: r.at});
      moved++;
    }
    await new Promise(resolve => {
      const req = indexedDB.deleteDatabase('peergoseasyedit');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    return moved;
  }

  return {readJSON, writeJSON, remove, getDraft, putDraft, deleteDraft, listDrafts, moveBrowserCopy};
})();
