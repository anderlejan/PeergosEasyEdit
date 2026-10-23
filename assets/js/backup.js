/* PeergosEasyEdit - local backup of the text in this browser (IndexedDB).
 *
 * One record per file: {key, text, at, state, savedHash}
 *   state 'unsaved' - the user's latest text, not confirmed saved in Peergos
 *   state 'saved'   - the text last confirmed saved (savedHash = SHA-256 of the saved bytes)
 * It lets the editor give back text a failed or never pressed Save would lose, and notice when
 * Peergos later hands back something other than what was saved. Only this browser sees it;
 * the user can switch it off and clear it (settings.localBackup). */
'use strict';

const Backup = (() => {
  const DB = 'peergoseasyedit', STORE = 'backups';
  const KEEP_SAVED_DAYS = 60;
  let dbPromise = null;
  let available = typeof indexedDB !== 'undefined';

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath: 'key'});
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('local backup storage is blocked'));
      }).catch(e => {
        available = false;
        throw e;
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('local backup write aborted'));
    });
  }

  const get = key => run('readonly', s => s.get(key));
  const put = record => run('readwrite', s => s.put(Object.assign({at: Date.now()}, record)));
  const remove = key => run('readwrite', s => s.delete(key));
  const clearAll = () => run('readwrite', s => s.clear());

  // Old confirmed-saved copies are dropped; unsaved text is kept until the user decides.
  async function prune() {
    const all = await run('readonly', s => s.getAll());
    const limit = Date.now() - KEEP_SAVED_DAYS * 24 * 3600 * 1000;
    for (const r of all || [])
      if (r.state === 'saved' && r.at < limit)
        await remove(r.key);
  }

  return {get, put, remove, clearAll, prune, isAvailable: () => available};
})();
