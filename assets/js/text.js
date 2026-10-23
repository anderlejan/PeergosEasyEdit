/* PeergosEasyEdit - turning file bytes into editor text and back without changing anything
 * the user did not change: the UTF-8 byte order mark and the line endings are kept.
 * A browser text box always hands back "\n" line endings, so a file that used "\r\n"
 * gets them back on saving. */
'use strict';

const TextCodec = (() => {
  // {ok: true, text, bom, eol} for UTF-8, {ok: false, text} when the bytes are not UTF-8
  // (then text is only for showing: saving it would replace the undecodable bytes).
  function decode(bytes) {
    const bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    let text;
    try {
      text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bom ? bytes.subarray(3) : bytes);
    } catch (e) {
      return {ok: false, text: new TextDecoder('utf-8').decode(bytes)};
    }
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    const loneCr = (text.match(/\r(?!\n)/g) || []).length;
    const eol = crlf > 0 && crlf >= lf ? '\r\n' : '\n';
    return {ok: true, text: text.replace(/\r\n?/g, '\n'), bom, eol, mixedEol: (crlf > 0 && lf > 0) || loneCr > 0};
  }

  function encode(text, {bom = false, eol = '\n'} = {}) {
    const body = new TextEncoder().encode(eol === '\n' ? text : text.replace(/\n/g, eol));
    if (!bom)
      return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xEF, 0xBB, 0xBF]);
    out.set(body, 3);
    return out;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i])
        return false;
    return true;
  }

  async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  return {decode, encode, sameBytes, sha256};
})();

if (typeof module !== 'undefined')
  module.exports = TextCodec;
