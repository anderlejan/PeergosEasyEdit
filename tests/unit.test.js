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

console.log(process.exitCode ? 'unit tests FAILED' : passed + ' unit tests passed');
