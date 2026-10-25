/* PeergosEasyEdit - keeping a Markdown file's own text when it is edited formatted.
 *
 * The formatted (WYSIWYG) editor writes Markdown in its own style: __bold__ becomes **bold**, "1)" becomes "1.",
 * raw HTML is dropped - even in parts nobody touched. So its output is never written to the file as a whole.
 * Instead the file and the editor's output are cut into top-level blocks (paragraphs, headings, lists, tables,
 * code blocks ...). A block whose formatted form did not change keeps its exact text from the file; only blocks
 * the user changed, added or removed differ. Blocks the formatted editor does not show at all (an HTML block)
 * stay where they were.
 *
 * Pure functions, also used by the unit tests:
 *   split(text, nodes)  nodes: the parser's top-level blocks [{type, sourcepos: [[line, col], [line, col]]}]
 *                       -> {blocks: [{type, text}], seps: [text before block 0, between 0 and 1, ..., after last]}
 *                       or null when the positions do not cut the text exactly
 *   merge(src, base, now)  src: the file split; base: the editor's output split when the file was loaded into it;
 *                          now: the editor's output split now -> {text to keep, replaced: the file's blocks that
 *                          were changed or removed} */
'use strict';

const MdMerge = (() => {
  function split(text, nodes) {
    const lineStart = [0];
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 10)
        lineStart.push(i + 1);
    const offset = ([line, col]) => line - 1 < lineStart.length ? lineStart[line - 1] + col : -1;
    const blocks = [], seps = [];
    let at = 0;
    for (const n of nodes) {
      const [from, to] = n.sourcepos;
      const start = offset([from[0], from[1] - 1]);
      // a block can end at column 0 of a line: it ends with the line before it
      const end = to[1] === 0 ? lineStart[to[0] - 1] - 1 : offset(to);
      if (start < at || end < start || end > text.length)
        return null;
      seps.push(text.slice(at, start));
      blocks.push({type: n.type, text: text.slice(start, end)});
      at = end;
    }
    seps.push(text.slice(at));
    return {blocks, seps};
  }

  const join = parts => parts.seps[0] + parts.blocks.map((b, i) => b.text + parts.seps[i + 1]).join('');

  // Longest common subsequence of a and b under eq: the matched index pairs, in order.
  function lcs(a, b, eq) {
    const n = a.length, m = b.length;
    const t = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i][j] = eq(a[i], b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (eq(a[i], b[j])) {
        pairs.push([i, j]);
        i++; j++;
      } else if (t[i + 1][j] >= t[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
    return pairs;
  }

  // the words of a block, without Markdown punctuation: "__Bold__ text" and "**Bold** text" are the same
  const words = t => t.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

  // Which block of the file each block of the editor's first output came from: first the same kind with the same
  // words, then - between those - the same kind in the same order (a paragraph whose HTML the editor dropped).
  function align(src, base) {
    const srcOf = new Map();
    const strict = lcs(src, base, (x, y) => x.type === y.type && words(x.text) === words(y.text));
    let s0 = 0, b0 = 0;
    for (const [s, b] of [...strict, [src.length, base.length]]) {
      for (const [i, j] of lcs(src.slice(s0, s), base.slice(b0, b), (x, y) => x.type === y.type))
        srcOf.set(b0 + j, s0 + i);
      if (s < src.length)
        srcOf.set(b, s);
      s0 = s + 1;
      b0 = b + 1;
    }
    return srcOf;
  }

  // -> {text, replaced: indexes of the file's blocks that were changed or removed}
  function merge(src, base, now) {
    const srcOf = align(src.blocks, base.blocks);
    const placed = new Set(srcOf.values());
    // unchanged blocks: the same formatted text before and now
    const pairs = lcs(base.blocks, now.blocks, (x, y) => x.text === y.text);
    const pieces = [];      // {src: index of a block kept from the file} or {text, at: the file's block it replaces}
    let emittedSrc = -1;
    const flushHidden = upTo => {    // blocks the editor does not show stay where they were
      for (let s = emittedSrc + 1; s < upTo; s++)
        if (!placed.has(s))
          pieces.push({src: s});
      emittedSrc = Math.max(emittedSrc, upTo - 1);
    };
    let pb = 0, j = 0;
    for (const [b, n] of [...pairs, [base.blocks.length, now.blocks.length]]) {
      // between two unchanged blocks: the file's blocks whose formatted form went, and the new text that came
      const gone = [];
      for (let k = pb; k < b; k++)
        if (srcOf.has(k))
          gone.push(srcOf.get(k));
      const next = srcOf.has(b) ? srcOf.get(b) : src.blocks.length;
      if (j < n) {
        const at = gone.length ? Math.min(...gone) : undefined;
        flushHidden(at !== undefined ? at : next);
        for (let first = true; j < n; j++, first = false)
          pieces.push({text: now.blocks[j].text, at: first ? at : undefined});
      }
      if (b < base.blocks.length && srcOf.has(b)) {
        flushHidden(next);
        pieces.push({src: next});
        emittedSrc = Math.max(emittedSrc, next);
      }
      pb = b + 1;
      j = n + 1;
    }
    flushHidden(src.blocks.length);
    const kept = new Set(pieces.filter(p => p.src !== undefined).map(p => p.src));
    const replaced = src.blocks.map((_, i) => i).filter(i => !kept.has(i));
    if (!src.blocks.length)   // an empty file (or only blank lines)
      return {text: pieces.length ? pieces.map(p => p.text).join('\n\n') + '\n' : src.seps[0], replaced};
    // between neighbours that were neighbours in the file (a changed block counts as the one it replaces): the
    // file's own blank lines; elsewhere one blank line
    const pos = p => p.src !== undefined ? p.src : p.at;
    let out = src.seps[0];
    pieces.forEach((p, k) => {
      if (k > 0) {
        const a = pos(pieces[k - 1]), b = pos(p);
        out += a !== undefined && b === a + 1 ? src.seps[b] : '\n\n';
      }
      out += p.src !== undefined ? src.blocks[p.src].text : p.text;
    });
    return {text: out + src.seps[src.seps.length - 1], replaced};
  }

  return {split, join, merge, lcs, words};
})();

if (typeof module !== 'undefined')
  module.exports = MdMerge;
