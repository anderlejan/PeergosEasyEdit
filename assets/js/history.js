/* PeergosEasyEdit - undo and redo, and the list of edits shown in the Edit history panel.
 *
 * The editor keeps its own history instead of the browser's, so that every change can be undone the same way:
 * typing, and also a restored draft or "their version" shown after a conflict. Each step holds only what changed
 * (where, what was removed, what was inserted). It lives in memory while the file is open and is never stored -
 * not in Peergos and not on the device. */
'use strict';

const HISTORY_MAX_STEPS = 1000;
const HISTORY_MAX_CHARS = 20 * 1000 * 1000;   // removed + inserted text kept, all steps together
const HISTORY_PAUSE_MS = 1000;                // typing after a pause this long starts a new step
const HISTORY_GROUP_CHARS = 80;               // ... and so does typing this much without a pause

class EditHistory {
  constructor(text) {
    this.text = text;            // the text after the last step applied
    this.steps = [];             // {start, removed, inserted, at, kind, label, line}
    this.pos = 0;                // steps[0 .. pos-1] are applied; the rest can be redone
    this.chars = 0;
    this.openedAt = Date.now();
  }

  get canUndo() { return this.pos > 0; }
  get canRedo() { return this.pos < this.steps.length; }

  // Records the change from the last known text to newText. kind: 'type', 'delete', 'paste', 'cut', 'drop' or
  // 'other'; label names a change made by the editor itself. Returns true when something changed.
  record(newText, kind, label) {
    const old = this.text;
    if (old === newText)
      return false;
    const max = Math.min(old.length, newText.length);
    let p = 0;
    while (p < max && old.charCodeAt(p) === newText.charCodeAt(p))
      p++;
    let s = 0;
    while (s < max - p && old.charCodeAt(old.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s))
      s++;
    // never split a character made of two code units
    if (p > 0 && isHigh(old.charCodeAt(p - 1)))
      p--;
    if (s > 0 && isLow(old.charCodeAt(old.length - s)))
      s--;
    const removed = old.slice(p, old.length - s);
    const inserted = newText.slice(p, newText.length - s);
    this.text = newText;
    const now = Date.now();
    const last = this.pos === this.steps.length ? this.steps[this.pos - 1] : null;
    if (last && !label && !last.label && now - last.at < HISTORY_PAUSE_MS) {
      if (kind === 'type' && last.kind === 'type' && removed === '' && p === last.start + last.inserted.length &&
          last.inserted.length < HISTORY_GROUP_CHARS && !last.inserted.endsWith('\n')) {
        last.inserted += inserted;
        last.at = now;
        this.chars += inserted.length;
        return true;
      }
      if (kind === 'delete' && last.kind === 'delete' && inserted === '' && last.inserted === '') {
        if (p + removed.length === last.start) {          // Backspace
          last.start = p;
          last.removed = removed + last.removed;
          last.at = now;
          this.chars += removed.length;
          return true;
        }
        if (p === last.start) {                            // Delete
          last.removed += removed;
          last.at = now;
          this.chars += removed.length;
          return true;
        }
      }
    }
    for (const dropped of this.steps.splice(this.pos))
      this.chars -= dropped.removed.length + dropped.inserted.length;
    this.steps.push({start: p, removed, inserted, at: now, kind: label ? 'other' : kind, label: label || '',
                     line: lineOf(old, p)});
    this.pos = this.steps.length;
    this.chars += removed.length + inserted.length;
    while (this.steps.length > 1 && (this.steps.length > HISTORY_MAX_STEPS || this.chars > HISTORY_MAX_CHARS)) {
      const first = this.steps.shift();
      this.chars -= first.removed.length + first.inserted.length;
      this.pos--;
      this.dropped = true;
    }
    return true;
  }

  // Each returns {text, selStart, selEnd} for the editor, or null when there is nothing to undo or redo.
  undo() {
    if (!this.canUndo)
      return null;
    const st = this.steps[--this.pos];
    const t = this.text;
    this.text = t.slice(0, st.start) + st.removed + t.slice(st.start + st.inserted.length);
    return {text: this.text, selStart: st.start, selEnd: st.start + st.removed.length};
  }

  redo() {
    if (!this.canRedo)
      return null;
    const st = this.steps[this.pos++];
    const t = this.text;
    this.text = t.slice(0, st.start) + st.inserted + t.slice(st.start + st.removed.length);
    const end = st.start + st.inserted.length;
    return {text: this.text, selStart: end, selEnd: end};
  }

  // Undoes or redoes until `pos` steps are applied.
  goTo(pos) {
    let state = null;
    while (this.pos > pos && this.canUndo)
      state = this.undo();
    while (this.pos < pos && this.canRedo)
      state = this.redo();
    return state;
  }

  // What a step did, in words.
  static describe(st) {
    if (st.label)
      return st.label;
    const snippet = t => {
      const one = t.replace(/\r?\n/g, '↵').replace(/\t/g, '→');
      return '“' + (one.length > 40 ? one.slice(0, 40) + '…' : one) + '”';
    };
    if (st.inserted && !st.removed)
      return (st.kind === 'paste' ? 'Pasted ' : st.kind === 'drop' ? 'Dropped ' : 'Typed ') + snippet(st.inserted);
    if (st.removed && !st.inserted)
      return (st.kind === 'cut' ? 'Cut ' : 'Deleted ') + snippet(st.removed);
    return 'Replaced ' + snippet(st.removed) + ' with ' + snippet(st.inserted);
  }
}

const isHigh = c => c >= 0xD800 && c <= 0xDBFF;
const isLow = c => c >= 0xDC00 && c <= 0xDFFF;

function lineOf(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1))
    n++;
  return n;
}

// The kind of an edit, from the browser's input event.
function editKind(inputType) {
  if (!inputType)
    return 'other';
  if (inputType === 'insertFromPaste' || inputType === 'insertFromPasteAsQuotation')
    return 'paste';
  if (inputType === 'insertFromDrop')
    return 'drop';
  if (inputType === 'deleteByCut')
    return 'cut';
  if (inputType.startsWith('delete'))
    return 'delete';
  if (inputType.startsWith('insert'))
    return 'type';
  return 'other';
}

if (typeof module !== 'undefined')
  module.exports = {EditHistory, editKind};
