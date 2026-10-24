// Unit tests for the parts of PeergosEasyEdit that need no browser:  node tests/unit.test.js
'use strict';
const assert = require('assert');
const path = require('path');

global.location = {search: '', href: 'https://app.example/index.html'};
const TextCodec = require(path.join(__dirname, '..', 'assets', 'js', 'text.js'));
const Peergos = require(path.join(__dirname, '..', 'assets', 'js', 'peergos.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL ' + name + '\n  ' + e.message);
    process.exitCode = 1;
  }
}

const bytes = s => new TextEncoder().encode(s);
const roundTrip = s => {
  const d = TextCodec.decode(bytes(s));
  return Buffer.from(TextCodec.encode(d.text, d)).equals(Buffer.from(bytes(s)));
};

test('LF text comes back unchanged', () => assert(roundTrip('one\ntwo\n')));
test('CRLF text comes back with CRLF', () => assert(roundTrip('one\r\ntwo\r\n')));
test('UTF-8 BOM is kept', () => assert(roundTrip('﻿with bom\r\n')));
test('empty file', () => assert(roundTrip('')));
test('no final newline', () => assert(roundTrip('a\nb')));
test('non-ASCII text', () => assert(roundTrip('Příliš žluťoučký kůň úpěl ďábelské ódy\n')));
test('the editor sees LF only and no BOM', () => {
  const d = TextCodec.decode(bytes('﻿a\r\nb\r\n'));
  assert.strictEqual(d.text, 'a\nb\n');
  assert.strictEqual(d.bom, true);
  assert.strictEqual(d.eol, '\r\n');
});
test('mixed line endings are reported', () => assert(TextCodec.decode(bytes('a\r\nb\nc\r\n')).mixedEol));
test('non-UTF-8 bytes are refused', () => assert.strictEqual(TextCodec.decode(Uint8Array.from([0x8e, 0x6c, 0x75])).ok, false));
test('sameBytes', () => {
  assert(TextCodec.sameBytes(bytes('abc'), bytes('abc')));
  assert(!TextCodec.sameBytes(bytes('abc'), bytes('abd')));
  assert(!TextCodec.sameBytes(bytes('abc'), bytes('ab')));
});

// What the browser makes of sandbox.js' "?path=" + path + "&theme=..." (the path is not encoded there).
function address(p) {
  return new URL('https://app.example/index.html?path=' + p + '&theme=&username=u&pgi=1').search;
}
const trusted = p => Peergos.filePathFromAddress(address(p));

for (const name of ['notes.txt', 'my notes.txt', 'Příliš žluťoučký.txt', "it's (1) [x] {y} ;=@$,.txt", 'a~b!c*.md'])
  test('trusted path: ' + name, () => {
    const r = trusted('/u/docs/' + name);
    assert.strictEqual(r.path, '/u/docs/' + name);
    assert.strictEqual(r.trusted, true);
  });
for (const name of ['C++ notes.txt', 'a&b.txt', 'x&theme=y.txt', 'pct%41.txt', 'q?.txt', 'hash#1.txt'])
  test('changed path refused: ' + name, () => assert.strictEqual(trusted('/u/docs/' + name).trusted, false));
test('no path', () => assert.deepStrictEqual(Peergos.filePathFromAddress('?theme=&username=u&pgi=1'), {path: null, trusted: false}));

/* ---------- undo, redo and the edit history ---------- */

const {EditHistory, editKind} = require(path.join(__dirname, '..', 'assets', 'js', 'history.js'));
let clock = 1000000;
const realNow = Date.now;
Date.now = () => clock;
// types `added` at the end, one character at a time, `gap` ms apart
function typeAtEnd(h, added, gap = 50) {
  for (const ch of added) {
    clock += gap;
    h.record(h.text + ch, 'type');
  }
}

test('typing without a pause is one step; undo and redo give the texts back', () => {
  const h = new EditHistory('Hello');
  typeAtEnd(h, ' world');
  assert.strictEqual(h.steps.length, 1);
  assert.strictEqual(h.undo().text, 'Hello');
  assert.strictEqual(h.redo().text, 'Hello world');
  assert(!h.canRedo && h.canUndo);
});
test('a pause, a new line and a long run start new steps', () => {
  const h = new EditHistory('');
  typeAtEnd(h, 'one');
  typeAtEnd(h, ' two', 1500);
  assert.strictEqual(h.steps.length, 5);   // 'one', then each character after a long pause
  const g = new EditHistory('');
  typeAtEnd(g, 'a\nb');
  assert.deepStrictEqual(g.steps.map(s => s.inserted), ['a\n', 'b']);
  const l = new EditHistory('');
  typeAtEnd(l, 'x'.repeat(200));
  assert.strictEqual(l.steps.length, 3);
});
test('Backspace and Delete runs are one step each', () => {
  const h = new EditHistory('abcdef');
  for (const t of ['abcde', 'abcd', 'abc']) { clock += 50; h.record(t, 'delete'); }
  assert.strictEqual(h.steps.length, 1);
  assert.strictEqual(h.steps[0].removed, 'def');
  assert.strictEqual(h.undo().text, 'abcdef');
  const d = new EditHistory('abcdef');
  for (const t of ['bcdef', 'cdef']) { clock += 50; d.record(t, 'delete'); }
  assert.strictEqual(d.steps.length, 1);
  assert.strictEqual(d.undo().text, 'abcdef');
});
test('a change in the middle, a paste and a labelled change', () => {
  const h = new EditHistory('line one\nline two\n');
  clock += 5000; h.record('line one\nline 2\n', 'type');
  clock += 5000; h.record('line one\nPASTED\nline 2\n', 'paste');
  clock += 5000; h.record('their text\n', 'other', 'Their version shown');
  assert.deepStrictEqual(h.steps.map(s => s.line), [2, 2, 1]);
  assert.strictEqual(EditHistory.describe(h.steps[0]), 'Replaced “two” with “2”');
  assert.strictEqual(EditHistory.describe(h.steps[1]), 'Pasted “PASTED↵”');
  assert.strictEqual(EditHistory.describe(h.steps[2]), 'Their version shown');
  assert.strictEqual(h.goTo(0).text, 'line one\nline two\n');
  assert.strictEqual(h.goTo(2).text, 'line one\nPASTED\nline 2\n');
  assert.strictEqual(h.goTo(3).text, 'their text\n');
});
test('a new change after undo drops what could be redone', () => {
  const h = new EditHistory('a');
  clock += 5000; h.record('ab', 'type');
  clock += 5000; h.record('abc', 'type');
  h.undo();
  clock += 5000; h.record('abX', 'type');
  assert.strictEqual(h.steps.length, 2);
  assert(!h.canRedo);
  assert.strictEqual(h.goTo(0).text, 'a');
});
test('characters made of two code units are never split', () => {
  const h = new EditHistory('x😀y');
  clock += 5000; h.record('x😁y', 'type');
  assert.strictEqual(h.steps[0].removed, '😀');
  assert.strictEqual(h.undo().text, 'x😀y');
});
test('the oldest steps are dropped beyond the limit', () => {
  const h = new EditHistory('');
  for (let i = 0; i < 1005; i++) { clock += 5000; h.record(h.text + 'x', 'type'); }
  assert.strictEqual(h.steps.length, 1000);
  assert.strictEqual(h.goTo(0).text, 'x'.repeat(5));
});
test('input types', () => {
  assert.deepStrictEqual(['insertText', 'insertLineBreak', 'insertFromPaste', 'deleteContentBackward', 'deleteByCut', 'insertFromDrop', undefined].map(editKind),
                         ['type', 'type', 'paste', 'delete', 'cut', 'drop', 'other']);
});
Date.now = realNow;

console.log(process.exitCode ? 'unit tests FAILED' : passed + ' unit tests passed');
