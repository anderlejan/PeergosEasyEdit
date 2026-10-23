/* PeergosEasyEdit - one document (a tab): loading, saving, autosave and drafts.
 *
 * Rules that keep the text safe:
 *  - "Saved" is shown only after Peergos accepted the write AND the file read back has exactly the bytes sent.
 *    Every failure stays on screen until the text is saved.
 *  - The text in the editor is never replaced by what Peergos sends back.
 *  - A file that could not be read is never shown as empty and cannot be saved over.
 *  - Before saving, the file must still be what this tab last read or saved. If it was changed elsewhere (another
 *    device, another app) or deleted, nothing is written until the user decides.
 *  - Text that is not in its file yet is kept as a draft in the app's Peergos folder (store.js), never on the
 *    device, and offered back when the file (or the app) is opened again on any device. */
'use strict';

const SAVE_TIMEOUT_MS = window.PEE_SAVE_TIMEOUT_MS || 120000;  // tests shorten these
const SLOW_SAVE_MS = window.PEE_SLOW_SAVE_MS || 15000;
const AUTO_MAX_WAIT_MS = window.PEE_AUTO_MAX_WAIT_MS || 30000;   // autosave at least this often while typing
const AUTO_RETRY_MS = window.PEE_AUTO_RETRY_MS || 30000;         // pause after a failed autosave
const DRAFT_DELAY_MS = window.PEE_DRAFT_DELAY_MS || 3000;        // draft written this long after the last change
const DRAFT_MAX_WAIT_MS = 20000;

class Doc {
  constructor(loc) {
    this.id = Loc.newDoc('').id;
    this.loc = loc;
    this.lasting = Loc.lasting(loc) ? loc : null;   // where it can be found again after a restart
    this.name = Loc.name(loc);
    this.area = el('textarea', {className: 'doc-text', spellcheck: false, readOnly: true});
    this.area.setAttribute('aria-label', 'Text');
    this.state = 'loading';    // loading | ready | failed | missing | mangled
    this.loaded = false;       // the text is the file's (or a new text): editing allowed
    this.canSave = false;      // Save may write to loc
    this.readOnly = false;
    this.bom = false;
    this.eol = '\n';
    this.savedText = '';       // the text known to be in the file
    this.savedHash = null;     // SHA-256 of the file's bytes as last read or saved here
    this.savedAt = null;
    this.checked = false;      // the last save was read back and matched
    this.saving = false;
    this.slow = false;
    this.saveAgain = false;
    this.restoreOpen = false;  // waiting for the user to decide about a draft
    this.conflict = false;     // the file changed elsewhere or is gone: no saving until decided
    this.overwriteOnce = false;
    this.autoTimer = null;
    this.autoSince = null;
    this.autoFailed = false;
    this.draftTimer = null;
    this.draftSince = null;
    this.draftStored = false;
    this.banners = new Map();  // id -> {level, text, actions}
  }

  get key() {
    return Loc.key(this.loc);
  }

  get dirty() {
    return this.loaded && this.area.value !== this.savedText;
  }
}

const Docs = (() => {
  /* ---------- messages that belong to one document ---------- */

  function showBanner(doc, id, level, text, actions = []) {
    doc.banners.set(id, {level, text, actions});
    App.renderBanners();
  }

  // Says the text is kept as a draft only once Peergos has it: the draft write can fail like the save did.
  function bannerWithDraft(doc, id, level, [before, after], actions) {
    showBanner(doc, id, level, before + after, actions);
    const shown = doc.banners.get(id);
    storeDraft(doc, true).then(kept => {
      if (kept && doc.banners.get(id) === shown)
        showBanner(doc, id, level, before + ' and kept as a draft in Peergos' + after, actions);
    });
  }

  function hideBanner(doc, id) {
    if (doc.banners.delete(id))
      App.renderBanners();
  }

  /* ---------- loading ---------- */

  async function load(doc) {
    doc.state = 'loading';
    App.changed(doc);
    if (doc.loc.kind === 'new') {
      doc.loaded = true;
      doc.state = 'ready';
      App.changed(doc);
      return;
    }
    hideBanner(doc, 'load');
    let bytes;
    try {
      bytes = await Peergos.readUrl(Loc.url(doc.loc));
    } catch (e) {
      const missing = e instanceof Peergos.HttpError && e.status === 404;
      doc.state = missing ? 'missing' : 'failed';
      showBanner(doc, 'load', 'error', missing
        ? 'The file was not found. It may have been moved, renamed or deleted. Nothing is saved from this tab.'
        : 'The file could not be opened: ' + describeError(e) + ' Nothing is saved from this tab until it has been opened.',
        missing ? [['Close', () => App.close(doc)]] : [['Try again', () => load(doc)]]);
      App.changed(doc);
      return;
    }
    const decoded = TextCodec.decode(bytes);
    doc.area.value = decoded.text;
    doc.savedText = decoded.text;
    doc.savedHash = await TextCodec.sha256(bytes);
    doc.loaded = true;
    doc.state = 'ready';
    if (!decoded.ok) {
      doc.readOnly = true;
      doc.canSave = false;
      showBanner(doc, 'load', 'warn', 'This file is not UTF-8 text. It is shown read-only, because saving it would ' +
                 'change characters the editor cannot show. "Save as…" saves a UTF-8 copy of what you see.');
      App.changed(doc);
      return;
    }
    doc.bom = decoded.bom;
    doc.eol = decoded.eol;
    doc.canSave = doc.loc.kind !== 'picked' || doc.loc.writable !== false;
    if (decoded.mixedEol)
      showBanner(doc, 'eol', 'info', 'This file mixes line ending styles. Saving writes them all as ' +
                 (doc.eol === '\r\n' ? 'Windows (CR LF)' : 'Unix (LF)') + ' line endings.', [['OK', () => hideBanner(doc, 'eol')]]);
    if (doc.loc.kind === 'chosen' && Files.supported())
      doc.lasting = await Files.lastingFor(doc.loc.path, bytes);
    App.changed(doc);
    await offerDraft(doc);
  }

  /* ---------- drafts ---------- */

  async function offerDraft(doc) {
    if (!App.settings.drafts)
      return;
    let draft = null;
    try {
      draft = await Store.getDraft(doc.key);
      if (!draft && doc.lasting && !Loc.same(doc.lasting, doc.loc))
        draft = await Store.getDraft(Loc.key(doc.lasting));
    } catch (e) {
      toastOnce('drafts', 'Drafts in Peergos could not be read: ' + describeError(e));
      return;
    }
    if (!draft || typeof draft.text !== 'string' || draft.text === doc.savedText)
      return;
    doc.draftStored = true;
    doc.restoreOpen = true;
    showBanner(doc, 'restore', 'warn', 'Changes from ' + timeText(draft.at) + ' were not saved to this file. They were ' +
               'kept as a draft in Peergos.', [
      ['Restore them', () => {
        const fileText = doc.area.value;
        doc.restoreOpen = false;
        doc.area.value = draft.text;
        edited(doc);
        showBanner(doc, 'restore', 'info', 'The draft is in the editor. ' + (App.settings.autoSave && doc.canSave
          ? 'Autosave puts it in the file.' : 'Save puts it in the file.'), [
          ['Undo', () => { doc.area.value = fileText; edited(doc); hideBanner(doc, 'restore'); }],
          ['OK', () => hideBanner(doc, 'restore')]]);
      }],
      ['Discard them', async () => {
        doc.restoreOpen = false;
        hideBanner(doc, 'restore');
        await dropDraft(doc);
        App.changed(doc);
      }]]);
    App.changed(doc);
  }

  function wantsDraft(doc) {
    return App.settings.drafts && doc.loaded && !doc.readOnly && !doc.restoreOpen && doc.dirty &&
           (doc.loc.kind === 'new' || !App.settings.autoSave || doc.autoFailed || doc.conflict || !doc.canSave);
  }

  function scheduleDraft(doc) {
    clearTimeout(doc.draftTimer);
    if (!wantsDraft(doc)) {
      doc.draftSince = null;
      return;
    }
    const now = Date.now();
    if (doc.draftSince === null)
      doc.draftSince = now;
    const delay = Math.min(DRAFT_DELAY_MS, Math.max(0, doc.draftSince + DRAFT_MAX_WAIT_MS - now));
    doc.draftTimer = setTimeout(() => storeDraft(doc), delay);
  }

  async function storeDraft(doc, force) {
    clearTimeout(doc.draftTimer);
    doc.draftSince = null;
    if (!(force ? App.settings.drafts && doc.loaded && doc.dirty : wantsDraft(doc)))
      return false;
    try {
      await Store.putDraft(doc.key, {loc: Loc.plain(doc.lasting || doc.loc), name: doc.name, text: doc.area.value,
                                     savedHash: doc.savedHash});
      doc.draftStored = true;
      return true;
    } catch (e) {
      toastOnce('drafts', 'A draft could not be kept in Peergos: ' + describeError(e));
      return false;
    }
  }

  async function dropDraft(doc, key) {
    if (!doc.draftStored && !key)
      return;
    try {
      await Store.deleteDraft(key || doc.key);
      if (!key)
        doc.draftStored = false;
    } catch (e) {
      // it is offered again next time; nothing is lost
    }
  }

  const toasted = new Set();
  function toastOnce(id, text) {
    if (toasted.has(id))
      return;
    toasted.add(id);
    toast(text, 'error');
  }

  /* ---------- autosave ---------- */

  // Saves settings.autoSave seconds after the last change, and at least every AUTO_MAX_WAIT_MS while typing.
  // Only a file: a new text would open the Save as dialog by itself.
  function scheduleAutoSave(doc) {
    clearTimeout(doc.autoTimer);
    const s = App.settings;
    if (!s.autoSave || !doc.canSave || !doc.loaded || doc.restoreOpen || doc.conflict || !doc.dirty || doc.loc.kind === 'new') {
      doc.autoSince = null;
      return;
    }
    const now = Date.now();
    if (doc.autoSince === null)
      doc.autoSince = now;
    const delay = doc.autoFailed ? AUTO_RETRY_MS : Math.min(s.autoSave * 1000, Math.max(0, doc.autoSince + AUTO_MAX_WAIT_MS - now));
    doc.autoTimer = setTimeout(() => autoSaveNow(doc), delay);
  }

  function autoSaveNow(doc) {
    clearTimeout(doc.autoTimer);
    const s = App.settings;
    if (s.autoSave && doc.canSave && doc.loaded && !doc.restoreOpen && !doc.conflict && doc.dirty && doc.loc.kind !== 'new')
      save(doc, {auto: true});
  }

  function edited(doc) {
    App.changed(doc);
    scheduleAutoSave(doc);
    scheduleDraft(doc);
  }

  /* ---------- saving ---------- */

  async function save(doc, options) {
    const auto = !!(options && options.auto === true);
    if (!doc.loaded || doc.restoreOpen)
      return;
    if (!doc.canSave || doc.loc.kind === 'new')
      return auto ? undefined : saveAs(doc);
    if (doc.saving) {
      doc.saveAgain = true;
      return;
    }
    if (doc.conflict && !doc.overwriteOnce)
      return;
    clearTimeout(doc.autoTimer);
    doc.autoSince = null;
    const text = doc.area.value;
    const bytes = TextCodec.encode(text, doc);
    const url = Loc.url(doc.loc);
    doc.saving = true;
    doc.slow = false;
    App.changed(doc);
    const slowTimer = setTimeout(() => { doc.slow = true; App.changed(doc); }, SLOW_SAVE_MS);
    let stopped = false;
    try {
      if (!doc.overwriteOnce && doc.savedHash) {
        let current = null;
        try {
          current = await Peergos.readUrl(url);
        } catch (e) {
          if (!(e instanceof Peergos.HttpError && e.status === 404))
            throw e;
        }
        if (current === null) {
          stopped = true;
          gone(doc);
          return;
        }
        if (await TextCodec.sha256(current) !== doc.savedHash) {
          stopped = true;
          changedElsewhere(doc, current);
          return;
        }
      }
      doc.overwriteOnce = false;
      await Peergos.writeUrl(url, bytes, SAVE_TIMEOUT_MS);
      let back = null;
      try {
        back = await Peergos.readUrl(url);
      } catch (e) {
        back = null;  // saved, but the check could not be made
      }
      if (back && !TextCodec.sameBytes(back, bytes))
        throw new Error('Peergos reported the file as saved, but reading it back gave different content');
      doc.savedText = text;
      doc.savedHash = await TextCodec.sha256(bytes);
      doc.savedAt = new Date();
      doc.checked = back !== null;
      doc.autoFailed = false;
      doc.conflict = false;
      hideBanner(doc, 'save');
      hideBanner(doc, 'conflict');
      if (!doc.checked)
        showBanner(doc, 'save', 'warn', 'Peergos reported the file as saved, but it could not be read back to check. ' +
                   'Your text is still here.', [['Save again', () => save(doc)], ['OK', () => hideBanner(doc, 'save')]]);
      if (!doc.dirty)
        await dropDraft(doc);
    } catch (e) {
      doc.autoFailed = true;
      bannerWithDraft(doc, 'save', 'error', [(auto ? 'Autosave failed. ' : '') + 'Not saved: ' + describeError(e) +
                      (App.settings.autoSave ? ' Autosave tries again in ' + Math.round(AUTO_RETRY_MS / 1000) + ' s.' : '') +
                      ' Your text is still here', '.'],
                      [['Try again', () => save(doc)], ['Save as…', () => saveAs(doc)]]);
    } finally {
      clearTimeout(slowTimer);
      doc.saving = false;
      App.changed(doc);
    }
    if (doc.saveAgain && !stopped) {
      doc.saveAgain = false;
      if (doc.dirty)
        save(doc);
    } else {
      scheduleAutoSave(doc);
      scheduleDraft(doc);
    }
  }

  // The file is not there any more: deleted, moved or renamed - here or on another device.
  function gone(doc) {
    doc.conflict = true;
    bannerWithDraft(doc, 'conflict', 'warn', ['The file is no longer there: it was deleted, moved or renamed (maybe on ' +
                    'another device). Your text is still here', '.'], [
      ['Save it here again', () => { doc.overwriteOnce = true; doc.conflict = false; hideBanner(doc, 'conflict'); save(doc); }],
      ['Save as…', () => saveAs(doc)]]);
  }

  // The file holds something else than what this tab last read or saved.
  function changedElsewhere(doc, theirBytes) {
    doc.conflict = true;
    storeDraft(doc, true);
    showBanner(doc, 'conflict', 'warn', 'The file was changed somewhere else (another device or app) since this tab ' +
               'opened or saved it. Nothing was saved.', [
      ['Show their version', async () => {
        const mine = doc.area.value;
        const kept = await storeDraft(doc, true);
        const theirs = TextCodec.decode(theirBytes);
        doc.area.value = theirs.text;
        doc.savedText = theirs.text;
        doc.savedHash = await TextCodec.sha256(theirBytes);
        doc.conflict = false;
        App.changed(doc);
        showBanner(doc, 'conflict', 'info', 'Their version is shown. ' + (kept ? 'Yours is kept as a draft in Peergos.'
                   : 'Yours is not saved anywhere: bring it back to keep it.'), [
          ['Bring mine back', () => { doc.area.value = mine; hideBanner(doc, 'conflict'); edited(doc); }],
          ['Forget mine', async () => { hideBanner(doc, 'conflict'); await dropDraft(doc); App.changed(doc); }]]);
      }],
      ['Overwrite with mine', () => { doc.overwriteOnce = true; doc.conflict = false; hideBanner(doc, 'conflict'); save(doc); }],
      ['Save mine as…', () => saveAs(doc)]]);
  }

  async function saveAs(doc) {
    if (!doc.loaded || doc.saving || doc.restoreOpen)
      return;
    if (!Files.supported())
      return saveThroughPeergos(doc);
    const target = await Files.show('save', doc.name, doc.lasting || doc.loc);
    if (!target)
      return;
    const url = Loc.url(target);
    const same = Loc.same(target, doc.loc);
    if (!same) {
      let exists = false;
      try {
        await Peergos.readUrl(url);
        exists = true;
      } catch (e) {
        if (!(e instanceof Peergos.HttpError && e.status === 404)) {
          showBanner(doc, 'save', 'error', 'Not saved: ' + describeError(e), [['Save as…', () => saveAs(doc)]]);
          return;
        }
      }
      if (exists && !await confirmAction('"' + Loc.name(target) + '" exists in that folder. Replace it with this text?', 'Replace'))
        return;
    }
    const text = doc.area.value;
    const bytes = TextCodec.encode(text, doc.readOnly ? {} : doc);
    doc.saving = true;
    App.changed(doc);
    try {
      await Peergos.writeUrl(url, bytes, SAVE_TIMEOUT_MS);
      const back = await Peergos.readUrl(url).catch(() => null);
      if (back && !TextCodec.sameBytes(back, bytes))
        throw new Error('Peergos reported the file as saved, but reading it back gave different content');
      const oldKey = doc.key;
      const hadDraft = doc.draftStored;
      doc.loc = target;
      doc.lasting = target;
      doc.name = Loc.name(target);
      doc.savedText = text;
      doc.savedHash = await TextCodec.sha256(bytes);
      doc.savedAt = new Date();
      doc.checked = back !== null;
      doc.readOnly = false;
      doc.canSave = true;
      doc.conflict = false;
      doc.autoFailed = false;
      for (const id of ['save', 'conflict', 'load'])
        doc.banners.delete(id);
      if (hadDraft)
        await dropDraft(doc, oldKey);
      doc.draftStored = false;
      App.moved(doc, oldKey);
    } catch (e) {
      showBanner(doc, 'save', 'error', 'Not saved: ' + describeError(e), [['Try again', () => saveAs(doc)]]);
    } finally {
      doc.saving = false;
      App.changed(doc);
    }
  }

  // Peergos without granted folders: its own save dialog (it asks for the name; the path is not returned).
  async function saveThroughPeergos(doc) {
    const text = doc.area.value;
    doc.saving = true;
    App.changed(doc);
    try {
      // Peergos' dialog refuses the opened file's own name: start with "name (copy).ext"
      const dot = doc.name.lastIndexOf('.');
      const name = doc.loc.kind === 'new' ? doc.name
        : dot > 0 ? doc.name.substring(0, dot) + ' (copy)' + doc.name.substring(dot) : doc.name + ' (copy)';
      await Peergos.saveAs(name, TextCodec.encode(text, doc.readOnly ? {} : doc), 15 * 60 * 1000);
      if (doc.loc.kind === 'new') {
        doc.savedText = text;
        doc.savedAt = new Date();
        doc.checked = false;
        await dropDraft(doc);
        toast('Saved. Peergos reported the file as written.');
      } else {
        toast('A copy was saved. This tab still edits ' + doc.name + '.');
      }
    } catch (e) {
      if (e instanceof Peergos.HttpError && e.status === 400)
        toast('Not saved: cancelled, or Peergos refused the name.', 'error');
      else
        showBanner(doc, 'save', 'error', 'The copy was not saved: ' + describeError(e), [['Try again', () => saveAs(doc)]]);
    } finally {
      doc.saving = false;
      App.changed(doc);
    }
  }

  return {load, save, saveAs, edited, autoSaveNow, storeDraft, dropDraft, showBanner, hideBanner, scheduleAutoSave};
})();
