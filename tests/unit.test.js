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

test('start link from the app\'s address', () => {
  const at = (protocol, hostname, port) => ({protocol, hostname, port});
  assert.strictEqual(Peergos.startLink(at('https:', 'bciqabc.peergos.net', ''), 'alice'),
    'https://peergos.net/#%7B%22app%22:%22peergoseasyedit%22%2c%22path%22:%22/alice%22%2c%22args%22:%7B%22filename%22:%22%22%7D%7D');
  assert.strictEqual(Peergos.startLink(at('http:', 'bciqabc.localhost', '8777'), 'testuser').split('#')[0], 'http://localhost:8777/');
  assert.strictEqual(Peergos.startLink(at('http:', '127.0.0.1', '8790'), 'alice'), null);
  assert.strictEqual(Peergos.startLink(at('https:', 'bciqabc.peergos.net', ''), null), null);
  const frag = Peergos.startLink(at('https:', 'x.peergos.net', ''), 'a').split('#')[1];
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(frag)), {app: 'peergoseasyedit', path: '/a', args: {filename: ''}});
});

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

/* ---------- Markdown: only the blocks changed in the formatted editor are written back ---------- */

const MdMerge = require(path.join(__dirname, '..', 'assets', 'js', 'mdmerge.js'));
// A stand-in for the Markdown parser: blocks are separated by blank lines; the kind from the first characters.
function parse(text) {
  const nodes = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].trim()) j++;
    const t = lines[i];
    const type = /^#/.test(t) ? 'heading' : /^([-*]|\d+[.)]) /.test(t) ? 'list' : /^<\w/.test(t) ? 'htmlBlock' : 'paragraph';
    nodes.push({type, sourcepos: [[i + 1, 1], [j + 1, lines[j].length]]});
    i = j + 1;
  }
  const parts = MdMerge.split(text, nodes);
  assert(parts, 'split ' + JSON.stringify(text));
  assert.strictEqual(MdMerge.join(parts), text);
  return parts;
}
// what the formatted editor makes of a file: its own style, no HTML blocks, no inline HTML, no link references
const normalize = text => parse(text).blocks.filter(b => b.type !== 'htmlBlock' && !/^\[\w+\]:/.test(b.text))
  .map(b => b.text.replace(/__(\w+)__/g, '**$1**').replace(/^(\d+)\) /gm, '$1. ').replace(/^\* /gm, '- ')
                  .replace(/<[^>]+>/g, '')).join('\n\n');
const mdEdit = (file, edit) => {
  const base = normalize(file);
  return MdMerge.merge(parse(file), parse(base), parse(edit(base)));
};
const FILE = '# Title\n\nSome __strong__ text.\n\n1) one\n2) two\n\n<div>html block</div>\n\nA <span>styled</span> word.\n\n' +
             'See [it][r].\n\n[r]: http://example.org\n\nLast   paragraph.\n';

test('Markdown: nothing changed in the formatted editor - the file stays exactly as it was', () => {
  assert.strictEqual(mdEdit(FILE, t => t).text, FILE);
  assert.deepStrictEqual(mdEdit(FILE, t => t).replaced, []);
});
test('Markdown: one paragraph changed - only it is written in the editor\'s style', () => {
  const r = mdEdit(FILE, t => t.replace('Last   paragraph.', 'Last paragraph, edited.'));
  assert.strictEqual(r.text, FILE.replace('Last   paragraph.', 'Last paragraph, edited.'));
});
test('Markdown: a changed paragraph takes the editor\'s style, its neighbours keep theirs', () => {
  const r = mdEdit(FILE, t => t.replace('Some **strong** text.', 'Some **strong** text, more.'));
  assert.strictEqual(r.text, FILE.replace('Some __strong__ text.', 'Some **strong** text, more.'));
  assert(r.text.includes('1) one\n2) two'));
});
test('Markdown: a new paragraph is added between, one is removed', () => {
  const r = mdEdit(FILE, t => t.replace('# Title\n\n', '# Title\n\nNew one.\n\n').replace('\n\nLast   paragraph.', ''));
  assert.strictEqual(r.text, FILE.replace('# Title\n\n', '# Title\n\nNew one.\n\n').replace('[r]: http://example.org\n\nLast   paragraph.\n',
                                                                                              '[r]: http://example.org\n'));
});
test('Markdown: an HTML block and a link reference the editor does not show stay, also when their neighbours change', () => {
  const r = mdEdit(FILE, t => t.replace('See [it][r].', 'See [it][r] now.').replace('1. one', '1. One'));
  assert(r.text.includes('<div>html block</div>') && r.text.includes('[r]: http://example.org'));
  assert(r.text.includes('See [it][r] now.') && r.text.includes('1. One\n2. two'));
  assert(!r.text.includes('See [it][r].'));
});
test('Markdown: a paragraph with HTML in it stays while untouched; edited, it is reported as replaced', () => {
  assert(mdEdit(FILE, t => t.replace('Last', 'Final')).text.includes('A <span>styled</span> word.'));
  const r = mdEdit(FILE, t => t.replace('A styled word.', 'A styled word!'));
  assert(r.text.includes('A styled word!') && !r.text.includes('<span>'));
  const i = parse(FILE).blocks.findIndex(b => b.text.includes('<span>'));
  assert.deepStrictEqual(r.replaced, [i]);
});
test('Markdown: blank lines and the end of the file are kept around untouched blocks', () => {
  const file = '\n# A\n\n\n\nb\n\n';
  assert.strictEqual(mdEdit(file, t => t).text, file);
  assert.strictEqual(mdEdit(file, t => t.replace('b', 'c')).text, '\n# A\n\n\n\nc\n\n');
});
test('Markdown: an empty file gets what was typed', () => {
  assert.strictEqual(MdMerge.merge(parse(''), parse(''), parse('Hello')).text, 'Hello\n');
});
test('Markdown: positions that do not cut the text exactly are refused', () => {
  assert.strictEqual(MdMerge.split('abc', [{type: 'paragraph', sourcepos: [[2, 1], [2, 3]]}]), null);
  assert.strictEqual(MdMerge.split('ab\ncd', [{type: 'p', sourcepos: [[1, 1], [1, 2]]}, {type: 'p', sourcepos: [[1, 2], [2, 2]]}]), null);
});
test('Markdown: a big file (6000 blocks) with one block edited - exact and quick', () => {
  const file = Array.from({length: 6000}, (_, i) => i % 3 ? 'Paragraph __' + i + '__ text.' : '* item ' + i).join('\n\n') + '\n';
  const t0 = Date.now();
  const r = mdEdit(file, t => t.replace('Paragraph **3001** text.', 'Paragraph **3001** text, edited.'));
  const ms = Date.now() - t0;
  assert.strictEqual(r.text, file.replace('Paragraph __3001__ text.', 'Paragraph **3001** text, edited.'));
  assert(ms < 1500, 'took ' + ms + ' ms');
});
test('Markdown: the block comparison finds as many matches as the exact one', () => {
  let seed = 7;
  const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let round = 0; round < 200; round++) {
    const a = Array.from({length: rnd(12)}, () => rnd(5)), b = Array.from({length: rnd(12)}, () => rnd(5));
    const pairs = MdMerge.lcs(a, b, (x, y) => x === y);
    assert(pairs.every(([i, j]) => a[i] === b[j]));
    assert(pairs.every((p, k) => k === 0 || (p[0] > pairs[k - 1][0] && p[1] > pairs[k - 1][1])));
    // the exact length by plain dynamic programming
    const t = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    assert.strictEqual(pairs.length, t[0][0], JSON.stringify([a, b]));
  }
});
test('Markdown: a block ending at column 0 ends with the line before', () => {
  const parts = MdMerge.split('- a\n- b\n\nx', [{type: 'list', sourcepos: [[1, 1], [3, 0]]}, {type: 'paragraph', sourcepos: [[4, 1], [4, 1]]}]);
  assert.deepStrictEqual(parts.blocks.map(b => b.text), ['- a\n- b', 'x']);
  assert.deepStrictEqual(parts.seps, ['', '\n\n', '']);
});

console.log(process.exitCode ? 'unit tests FAILED' : passed + ' unit tests passed');
