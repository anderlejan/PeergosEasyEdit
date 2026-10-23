/* PeergosEasyEdit - talking to Peergos from inside its app sandbox.
 *
 * Every request goes to the sandbox's service worker, which hands it to the Peergos page.
 * Three Peergos behaviours shape this file (checked against Peergos 1.40.0, web-ui 36e6912):
 *  - The browser stops an idle service worker. The restarted worker has forgotten this app
 *    and answers the next request with 503 while the sandbox registers again
 *    (sw-sandbox.js resolveInstance). Such a request never reached Peergos, so it is sent again.
 *  - Peergos can leave a request unanswered (sw-sandbox.js returnAppData has no time limit).
 *    Callers get a TimeoutError; a write may still complete after it.
 *  - The file's path reaches the app unencoded in "?path=" (sandbox.js), so names holding
 *    "+", "&", "#" or "%" arrive changed. filePathFromAddress() detects that.
 */
'use strict';

const Peergos = (() => {
  const RETRY_503_MS = [250, 500, 1000, 1500, 2500, 4000, 6000];
  const DATA = '/peergos-api/v0/data/';

  class HttpError extends Error {
    constructor(status, what) {
      super(what + ' (HTTP ' + status + ')');
      this.status = status;
    }
  }

  class TimeoutError extends Error {
    constructor(what, ms) {
      super(what + ': Peergos did not answer within ' + Math.round(ms / 1000) + ' s');
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function withTimeout(promise, ms, what) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  // fetch() that sends again while the restarted service worker answers 503.
  async function request(url, options, what, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const left = Math.max(1000, deadline - Date.now());
      const res = await withTimeout(fetch(url, Object.assign({cache: 'no-store'}, options)), left, what);
      if (res.status !== 503 || attempt >= RETRY_503_MS.length || Date.now() > deadline)
        return res;
      await sleep(RETRY_503_MS[attempt]);
    }
  }

  const params = new URLSearchParams(location.search);
  // A "#" in the file's name moves the rest of the address (username, pgi) behind the "#".
  const inPeergos = /[?&#]pgi=/.test(location.href) && /[?&#]username=/.test(location.href);

  // The way a browser percent-encodes a query (WHATWG URL "special-query percent-encode set").
  function queryEncode(s) {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c <= 0x20 || c >= 0x7f || '"#<>\''.includes(ch))
        out += Array.from(new TextEncoder().encode(ch), b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
      else
        out += ch;
    }
    return out;
  }

  // The file this app was opened on, and whether that path can be trusted.
  // sandbox.js builds "?path=" + path + "&theme=..." without encoding the path. Encoding the
  // path we read the way the browser would must give back exactly what is in the address;
  // otherwise "+", "&", "#" or "%" in the name changed it, and reading or writing would reach
  // the wrong place (Peergos then answers 404 to reads and 400 to writes).
  function filePathFromAddress(search) {
    const path = new URLSearchParams(search).get('path');
    if (!path)
      return {path: null, trusted: false};
    const end = search.lastIndexOf('&theme=');
    const raw = search.startsWith('?path=') && end > 0 ? search.substring(6, end) : null;
    let trusted = raw !== null && queryEncode(path) === raw && !path.includes('?') && path.startsWith('/');
    if (trusted) {
      // the service worker decodes the request path with decodeURI: it must give this path back
      try {
        trusted = decodeURI(new URL(fileUrl(path), location.href).pathname) === path;
      } catch (e) {
        trusted = false;
      }
    }
    return {path, trusted};
  }

  function fileUrl(path) {
    return encodeURI(path);
  }

  // The chosen file (EDIT_CHOSEN_FILE). Returns the raw bytes; throws HttpError/TimeoutError.
  async function readFile(path) {
    const res = await request(fileUrl(path), {method: 'GET'}, 'Reading the file');
    if (!res.ok)
      throw new HttpError(res.status, 'Reading the file');
    return new Uint8Array(await res.arrayBuffer());
  }

  async function writeFile(path, bytes, timeoutMs) {
    const res = await request(fileUrl(path), {method: 'PUT', body: bytes}, 'Saving the file', timeoutMs);
    if (!res.ok)
      throw new HttpError(res.status, 'Saving the file');
  }

  // Save under a new name: Peergos asks the user for the name and folder (or cancels: 400).
  async function saveAs(name, bytes, timeoutMs) {
    const res = await request('/peergos-api/v0/save/' + encodeURIComponent(name), {method: 'PUT', body: bytes}, 'Saving a copy', timeoutMs);
    if (!res.ok)
      throw new HttpError(res.status, 'Saving a copy');
  }

  // The app's own data folder (STORE_APP_DATA). null = the file does not exist yet (404).
  // Any other failure throws: the caller must not treat it as "no data".
  async function readData(name) {
    if (!inPeergos)
      return localStorage.getItem('peergoseasyedit.data.' + name);
    const res = await request(DATA + name, {method: 'GET'}, 'Reading ' + name);
    if (res.status === 404)
      return null;
    if (!res.ok)
      throw new HttpError(res.status, 'Reading ' + name);
    return await res.text();
  }

  async function writeData(name, text) {
    if (!inPeergos) {
      localStorage.setItem('peergoseasyedit.data.' + name, text);
      return;
    }
    const res = await request(DATA + name, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: text}, 'Saving ' + name);
    if (!res.ok)
      throw new HttpError(res.status, 'Saving ' + name);
  }

  return {inPeergos, params, filePathFromAddress, queryEncode, readFile, writeFile, saveAs, readData, writeData,
          HttpError, TimeoutError};
})();

if (typeof module !== 'undefined')
  module.exports = Peergos;
