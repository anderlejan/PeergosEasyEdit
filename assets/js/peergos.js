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
 * Granted folders (/peergos-api/v0/folder/<grant>/<path>) pass every name correctly: each segment is
 * percent-encoded here and decoded one by one by the service worker. Their API paths need the trailing
 * slash (/v0/folders/, /v0/file-picker/, /v0/grants/): without it the request is taken for a file (404).
 */
'use strict';

const Peergos = (() => {
  const RETRY_503_MS = [250, 500, 1000, 1500, 2500, 4000, 6000];
  const DATA = '/peergos-api/v0/data/';
  const FOLDER = '/peergos-api/v0/folder/';
  const USER_WAIT_MS = 30 * 60 * 1000;   // dialogs that wait for the user

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

  // A file in a granted folder: grant id + path inside the folder.
  function grantUrl(grantId, rel) {
    const parts = String(rel || '').split('/').filter(p => p.length > 0);
    return FOLDER + encodeURIComponent(grantId) + '/' + parts.map(encodeURIComponent).join('/');
  }

  // A file's bytes from its url (chosen file, picked file or granted folder); throws HttpError/TimeoutError.
  async function readUrl(url) {
    const res = await request(url, {method: 'GET'}, 'Reading the file');
    if (!res.ok)
      throw new HttpError(res.status, 'Reading the file');
    return new Uint8Array(await res.arrayBuffer());
  }

  async function writeUrl(url, bytes, timeoutMs) {
    const res = await request(url, {method: 'PUT', body: bytes}, 'Saving the file', timeoutMs);
    if (!res.ok)
      throw new HttpError(res.status, 'Saving the file');
    return res.status;
  }

  const readFile = path => readUrl(fileUrl(path));
  const writeFile = (path, bytes, timeoutMs) => writeUrl(fileUrl(path), bytes, timeoutMs);

  // The app's granted folders, or null when this Peergos has none (older versions).
  async function grants() {
    if (!inPeergos)
      return null;
    const res = await request('/peergos-api/v0/grants/', {method: 'GET'}, 'Reading the granted folders');
    if (!res.ok)
      return null;
    try {
      const list = JSON.parse(await res.text());
      return Array.isArray(list) ? list : null;
    } catch (e) {
      return null;
    }
  }

  // Peergos asks the user for folders the app may read and change, and remember. [] when cancelled.
  async function askForFolders() {
    const res = await request('/peergos-api/v0/folders/?persist=true&write=true', {method: 'GET'}, 'Choosing folders', USER_WAIT_MS);
    if (!res.ok)
      throw new HttpError(res.status, 'Choosing folders');
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  async function revokeGrant(grantId) {
    const res = await request('/peergos-api/v0/grants/' + encodeURIComponent(grantId), {method: 'DELETE'}, 'Removing the folder');
    if (!res.ok && res.status !== 404)
      throw new HttpError(res.status, 'Removing the folder');
  }

  // {files: [{name, modified, size}], subFolders: [{name, modified}]}, or null when the folder is gone.
  async function listFolder(grantId, rel) {
    const res = await request(grantUrl(grantId, rel) + '?details=true', {method: 'GET'}, 'Reading the folder');
    if (res.status === 404)
      return null;
    if (!res.ok)
      throw new HttpError(res.status, 'Reading the folder');
    const list = JSON.parse(await res.text());
    const named = x => typeof x === 'string' ? {name: x} : x;
    return {files: (list.files || []).map(named), subFolders: (list.subFolders || []).map(named)};
  }

  async function makeFolder(grantId, rel) {
    const res = await request(grantUrl(grantId, rel) + '?type=directory', {method: 'POST'}, 'Creating the folder');
    if (!res.ok)
      throw new HttpError(res.status, 'Creating the folder');
  }

  // Renames a file or folder in a granted folder; the new name is the body (Peergos 1.40, web-ui AppSandbox.vue:
  // POST ...?action=rename answers 201). Not in the Peergos book yet.
  async function renameGranted(grantId, rel, newName) {
    const res = await request(grantUrl(grantId, rel) + '?action=rename', {method: 'POST', body: newName}, 'Renaming the file');
    if (res.status !== 201 && res.status !== 200)
      throw new HttpError(res.status, 'Renaming the file');
  }

  // Peergos' own file picker: [path, writable] (writable for this session only), [] when cancelled.
  async function pickFile() {
    const res = await request('/peergos-api/v0/file-picker/?writable=true', {method: 'GET'}, 'Choosing a file', USER_WAIT_MS);
    if (!res.ok)
      throw new HttpError(res.status, 'Choosing a file');
    const answer = JSON.parse(await res.text() || '[]');
    return Array.isArray(answer) && answer[0] ? answer : [];
  }

  // Whether a path from the file picker can be sent to Peergos unchanged (see filePathFromAddress).
  function sendablePath(path) {
    try {
      return !path.includes('?') && !path.includes('#') &&
             decodeURI(new URL(fileUrl(path), location.href).pathname) === path;
    } catch (e) {
      return false;
    }
  }

  // Save under a new name: Peergos asks the user for the name and folder (or cancels: 400).
  async function saveAs(name, bytes, timeoutMs) {
    const res = await request('/peergos-api/v0/save/' + encodeURIComponent(name), {method: 'PUT', body: bytes}, 'Saving a copy', timeoutMs);
    if (!res.ok)
      throw new HttpError(res.status, 'Saving a copy');
  }

  // The app's own data folder (STORE_APP_DATA). null = the file does not exist yet (404).
  // Any other failure throws: the caller must not treat it as "no data".
  // Outside Peergos (development only) the data lives in memory: nothing is written to this device.
  const memory = new Map();

  async function readData(name) {
    if (!inPeergos)
      return memory.has(name) ? memory.get(name) : null;
    const res = await request(DATA + name, {method: 'GET'}, 'Reading ' + name);
    if (res.status === 404)
      return null;
    if (!res.ok)
      throw new HttpError(res.status, 'Reading ' + name);
    return await res.text();
  }

  async function writeData(name, text) {
    if (!inPeergos) {
      memory.set(name, text);
      return;
    }
    const res = await request(DATA + name, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: text}, 'Saving ' + name);
    if (!res.ok)
      throw new HttpError(res.status, 'Saving ' + name);
  }

  async function deleteData(name) {
    if (!inPeergos) {
      memory.delete(name);
      return;
    }
    const res = await request(DATA + name, {method: 'DELETE'}, 'Deleting ' + name);
    if (!res.ok && res.status !== 404)
      throw new HttpError(res.status, 'Deleting ' + name);
  }

  return {inPeergos, params, filePathFromAddress, queryEncode, fileUrl, grantUrl, sendablePath,
          readUrl, writeUrl, readFile, writeFile, saveAs, grants, askForFolders, revokeGrant, listFolder, makeFolder,
          renameGranted, pickFile, readData, writeData, deleteData, HttpError, TimeoutError};
})();

if (typeof module !== 'undefined')
  module.exports = Peergos;
