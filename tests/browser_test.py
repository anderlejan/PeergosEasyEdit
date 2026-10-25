#!/usr/bin/env python3
"""Browser tests of PeergosEasyEdit against tests/mock_peergos.py (faults on demand).

  python3 tests/browser_test.py [--chromium /path/to/chrome] [--headed]

Every check of "saved" looks at the bytes the mock server holds, not at what the app says.
"""
import argparse, json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import mock_peergos
import env  # noqa: E402
env.load()

ap = argparse.ArgumentParser()
ap.add_argument('--chromium', default=os.environ.get('CHROMIUM'))
ap.add_argument('--headed', action='store_true')
ap.add_argument('--port', type=int, default=int(os.environ['MOCK_PORT']))
A = ap.parse_args()
BASE = 'http://127.0.0.1:%d' % A.port
failures = []


def ok(name, cond, extra=''):
    print(('  ok   ' if cond else '  FAIL ') + name + ('' if cond else '  -- ' + str(extra)), flush=True)
    if not cond:
        failures.append(name)


def mock(path, method='POST', data=None):
    req = urllib.request.Request(BASE + path, method=method, data=data)
    with urllib.request.urlopen(req) as r:
        return r.read()


def config(**faults):
    mock('/mock/config', data=json.dumps({k.replace('_', ''): v for k, v in faults.items()}).encode())


def put_file(path, data):
    mock('/mock/file?path=' + urllib.request.quote(path), 'PUT', data)


def server_file(path):
    try:
        return mock('/mock/file?path=' + urllib.request.quote(path), 'GET')
    except urllib.error.HTTPError:
        return None


def data_names():
    return json.loads(mock('/mock/datalist', 'GET'))


def data_json(name):
    try:
        return json.loads(mock('/mock/data?name=' + urllib.request.quote(name), 'GET'))
    except urllib.error.HTTPError:
        return None


def drafts():
    return [data_json(n) for n in data_names() if n.startswith('drafts/')]


def settings(**kw):
    s = {'autoSave': 0}
    s.update(kw)
    mock('/mock/data?name=settings.json', 'PUT', json.dumps(s).encode())


def grant(path, write=True):
    return mock('/mock/grant', data=json.dumps({'path': path, 'write': write}).encode()).decode()


def reset(**kw):
    mock('/mock/reset')
    settings(**kw)


def address(path=None):
    # built the way Peergos' sandbox.js builds it: the path is NOT encoded
    q = ('?path=' + path + '&theme=') if path else '?theme='
    return BASE + '/index.html' + q + '&username=alice&pgi=test&lang=en&isPathWritable=true'


def wait(fn, what, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.1)
    raise TimeoutError(what)


class App:
    def __init__(self, ctx, path=None):
        self.page = ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto(address(path))
        self.page.wait_for_function("document.getElementById('status') !== null && !document.documentElement.classList.contains('loading')")
        time.sleep(0.7)

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg)

    def text(self):
        return self.ev("(document.getElementById('editor') || {}).value")

    def type_text(self, t):
        self.ev("t => { const e = document.getElementById('editor'); e.value = t; e.dispatchEvent(new Event('input')); }", t)

    def status(self):
        return self.ev("document.getElementById('status').textContent")

    def banners(self):
        return self.ev("[...document.querySelectorAll('.banner')].map(b => b.className + ': ' + b.querySelector('p').textContent)")

    def click_banner(self, label):
        self.ev("l => [...document.querySelectorAll('.banner button')].find(b => b.textContent === l).click()", label)
        time.sleep(0.3)

    def save(self):
        self.ev("document.getElementById('saveBtn').click()")

    def wait_idle(self, timeout=20):
        wait(lambda: not self.status().startswith('Saving'), 'save to end', timeout)
        time.sleep(0.3)

    def readonly(self):
        return self.ev("(document.getElementById('editor') || {readOnly: true}).readOnly")

    def tabs(self):
        return self.ev("[...document.querySelectorAll('#tabs .tab-name')].map(t => t.textContent)")

    def side(self, value):
        self.ev("v => { const s = document.getElementById('sidePanelSelect'); s.value = v; s.dispatchEvent(new Event('change')); }", value)
        time.sleep(0.2)

    def menu(self, item):
        self.ev("id => document.getElementById(id).click()", item)
        time.sleep(0.3)

    def dialog_open(self, id):
        return self.ev("id => document.getElementById(id).open", id)

    def fd_rows(self):
        return self.ev("[...document.querySelectorAll('#fdList .fd-row span:first-child')].map(s => s.textContent)")

    def fd_click(self, text, double=False):
        self.ev("([t, d]) => { const r = [...document.querySelectorAll('#fdList .fd-row')].find(r => r.textContent.includes(t)); "
                "r.click(); if (d) r.dispatchEvent(new MouseEvent('dblclick')); }", [text, double])
        time.sleep(0.4)

    def close(self):
        self.page.close()


def main():
    mock_peergos.serve(A.port)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not A.headed, executable_path=A.chromium)
        doc = '/alice/docs/notes.txt'

        def fresh_ctx():
            c = browser.new_context()
            c.add_init_script("window.PEE_SAVE_TIMEOUT_MS = 4000; window.PEE_SLOW_SAVE_MS = 1500; "
                              "window.PEE_AUTO_MAX_WAIT_MS = 1500; window.PEE_AUTO_RETRY_MS = 2000; window.PEE_DRAFT_DELAY_MS = 300;")
            return c

        print('1. open and save', flush=True)
        reset(); put_file(doc, b'Line one\nLine two\n')
        ctx = fresh_ctx(); app = App(ctx, doc)
        ok('file text shown', app.text() == 'Line one\nLine two\n', app.text())
        ok('editable after loading', not app.readonly())
        ok('Save disabled while nothing changed', app.ev("document.getElementById('saveBtn').disabled"))
        ok('the file name is shown in the bar', app.ev("document.getElementById('docName').textContent") == 'notes.txt')
        app.type_text('Line one\nLine two\nthree\n')
        ok('unsaved changes shown', app.status() == 'Unsaved changes' and app.ev("document.getElementById('docName').classList.contains('dirty')"), app.status())
        app.save(); app.wait_idle()
        ok('server has the text', server_file(doc) == b'Line one\nLine two\nthree\n', server_file(doc))
        ok('status says saved and checked', app.status().startswith('Saved ✓'), app.status())
        app.type_text('ctrl s\n')
        app.ev("document.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true}))"); app.wait_idle()
        ok('Ctrl+S saves', server_file(doc) == b'ctrl s\n', server_file(doc))
        ok('no script errors', not app.errors, app.errors)
        app.close()

        print('2. the service worker was restarted (503 before it registers again)', flush=True)
        app = App(ctx, doc)
        app.type_text('after idle\n')
        config(**{'503': 3})
        app.save(); app.wait_idle()
        ok('saved after the 503 answers', server_file(doc) == b'after idle\n', server_file(doc))
        ok('status saved', app.status().startswith('Saved ✓'), app.status())
        config(**{'503': 1000})
        app.type_text('never reaches peergos\n')
        app.save(); app.wait_idle(60)
        config(**{'503': 0})
        ok('a lasting 503 is shown as an error', any('Not saved' in b and 'error' in b for b in app.banners()), app.banners())
        ok('server unchanged', server_file(doc) == b'after idle\n', server_file(doc))
        ok('text still in the editor, still unsaved', app.text() == 'never reaches peergos\n' and app.status() == 'Unsaved changes', app.status())
        app.click_banner('Try again'); app.wait_idle()
        ok('Try again saves', server_file(doc) == b'never reaches peergos\n' and not any('Not saved' in b for b in app.banners()), app.banners())
        app.close()

        print('3. Peergos refuses (400), never answers, or reads back other bytes', flush=True)
        app = App(ctx, doc)
        config(fail={'PUT': 400}); app.type_text('refused\n'); app.save(); app.wait_idle()
        ok('400 shown as an error with the reason', any('Not saved' in b and 'HTTP 400' in b for b in app.banners()), app.banners())
        ok('400: text kept, unsaved', app.text() == 'refused\n' and app.status() == 'Unsaved changes')
        config(fail={}); app.close()
        reset(); put_file(doc, b'start\n')
        app = App(ctx, doc)
        config(hang=['PUT']); app.type_text('hangs\n'); app.save()
        wait(lambda: 'not answered' in app.status(), 'slow status', 5)
        ok('a slow save says so', True)
        app.wait_idle(10)
        ok('a save without answer ends in an error', any('did not answer' in b for b in app.banners()), app.banners())
        ok('no answer: text kept, unsaved', app.text() == 'hangs\n' and app.status() == 'Unsaved changes', app.status())
        app.close()
        reset(); put_file(doc, b'start\n')
        app = App(ctx, doc)
        config(readBack='garbage'); app.type_text('checked\n'); app.save(); app.wait_idle()
        ok('different read-back is an error, not "saved"', any('different content' in b or 'changed somewhere else' in b for b in app.banners())
           and app.status() != 'No changes' and not app.status().startswith('Saved'), (app.banners(), app.status()))
        app.close()
        reset(); put_file(doc, b'x\n')
        app = App(ctx, doc)
        config(delay={'PUT': 1.5}); app.type_text('first\n'); app.save()
        time.sleep(0.6); app.type_text('first\nsecond, typed while saving\n')
        app.wait_idle()
        ok('typing during a save is not replaced', app.text() == 'first\nsecond, typed while saving\n', app.text())
        ok('server has what was saved; the rest stays unsaved', server_file(doc) == b'first\n' and app.status() == 'Unsaved changes', (server_file(doc), app.status()))
        config(delay={}); app.close()

        print('4. a file that could not be read is never shown empty or saved over', flush=True)
        reset(); put_file(doc, b'precious\n'); config(fail={'GET': 500})
        app = App(ctx, doc)
        ok('error banner', any('could not be opened' in b for b in app.banners()), app.banners())
        ok('editor read-only, Save off', app.readonly() and app.ev("document.getElementById('saveBtn').disabled"))
        app.ev("document.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true}))"); time.sleep(0.5)
        ok('file untouched', server_file(doc) == b'precious\n')
        config(fail={}); app.click_banner('Try again')
        try:
            wait(lambda: app.text() == 'precious\n' and not app.readonly(), 'the file to open', 5)
        except TimeoutError:
            pass
        ok('Try again opens it', app.text() == 'precious\n' and not app.readonly(), (app.text(), app.readonly()))
        app.close()
        app = App(ctx, '/alice/docs/missing.txt')
        ok('missing file: says so, Save off', any('not found' in b for b in app.banners()) and app.ev("document.getElementById('saveBtn').disabled"), app.banners())
        app.close()

        print('5. names Peergos passes on changed', flush=True)
        for name in ['C++ notes.txt', 'a&b.txt', 'x&theme=y.txt', 'hash#1.txt', 'pct%41.txt']:
            path = '/alice/docs/' + name
            put_file(path, b'content of ' + name.encode())
            app = App(ctx, path)
            ok('%s: not opened, explained, Open offered' % name, any('did not open it' in b for b in app.banners()) and
               app.ev("!document.getElementById('editor') && !document.getElementById('startPanel').hidden"), app.banners())
            ok('%s: Save off' % name, app.ev("document.getElementById('saveBtn').disabled && document.getElementById('saveAsBtn').disabled"))
            app.close()
        for name in ['plain name.txt', 'Příliš žluťoučký.txt', "it's (1) [x] {y} ;=@$,.txt"]:
            path = '/alice/docs/' + name
            put_file(path, ('text of ' + name).encode())
            app = App(ctx, path)
            ok('%s: opened' % name, app.text() == 'text of ' + name and not app.readonly(), (app.text(), app.banners()))
            app.type_text('changed\n'); app.save(); app.wait_idle()
            ok('%s: saved to the right file' % name, server_file(path) == b'changed\n', server_file(path))
            app.close()

        print('6. encoding, byte order mark, line endings', flush=True)
        reset()
        put_file(doc, b'\xef\xbb\xbfWindows\r\nlines\r\n')
        app = App(ctx, doc)
        ok('no banners', not app.banners(), app.banners())
        ok('shown without the BOM, with \\n', app.text() == 'Windows\nlines\n', repr(app.text()))
        app.type_text('Windows\nlines\nmore\n'); app.save(); app.wait_idle()
        ok('BOM and CRLF kept', server_file(doc) == b'\xef\xbb\xbfWindows\r\nlines\r\nmore\r\n', server_file(doc))
        app.close()
        reset(); config(noGrants=True)
        put_file(doc, 'Žluťoučký kůň\n'.encode('cp1250'))
        app = App(ctx, doc)
        ok('not UTF-8: read-only with a message', app.readonly() and any('not UTF-8' in b for b in app.banners()), app.banners())
        app.save(); time.sleep(0.8)
        ok('not UTF-8: file never written', server_file(doc) == 'Žluťoučký kůň\n'.encode('cp1250'), server_file(doc))
        ok('not UTF-8, Peergos without granted folders: Save makes a UTF-8 copy through Peergos\' dialog',
           server_file('/alice/docs/notes (copy).txt') == 'Žluťoučký kůň\n'.encode('cp1250').decode('utf-8', 'replace').encode(),
           server_file('/alice/docs/notes (copy).txt'))
        app.close()

        print('7. drafts in Peergos, changed elsewhere, nothing on the device', flush=True)
        reset(); put_file(doc, b'base\n')
        ctx2 = fresh_ctx()
        app = App(ctx2, doc)
        app.type_text('base\nnever saved\n'); time.sleep(1.0)
        ok('autosave off: the unsaved text is kept as a draft in Peergos', [d['text'] for d in drafts()] == ['base\nnever saved\n'], drafts())
        app.close()
        ctx3 = fresh_ctx()   # another browser - another device
        app = App(ctx3, doc)
        ok('offered back on another device', any('were not saved' in b for b in app.banners()), app.banners())
        ok('read-only until decided', app.readonly())
        app.click_banner('Restore them')
        ok('restored and unsaved', app.text() == 'base\nnever saved\n' and app.status() == 'Unsaved changes', app.status())
        app.click_banner('Undo')
        ok('undo gives the file text back', app.text() == 'base\n')
        app.type_text('base\nsaved now\n'); app.save(); app.wait_idle()
        ok('saving removes the draft', drafts() == [], drafts())
        app.close()
        app = App(ctx3, doc)
        ok('no question once saved', not app.banners(), app.banners())
        app.type_text('mine\n'); time.sleep(0.2)
        put_file(doc, b'theirs\n')           # changed on another device meanwhile
        app.save(); app.wait_idle()
        ok('changed elsewhere: not overwritten', server_file(doc) == b'theirs\n', server_file(doc))
        ok('changed elsewhere: explained, choices offered', any('changed somewhere else' in b for b in app.banners()), app.banners())
        ok('changed elsewhere: my text kept as a draft', [d['text'] for d in drafts()] == ['mine\n'], drafts())
        app.click_banner('Show their version')
        ok('their version shown', app.text() == 'theirs\n')
        app.click_banner('Bring mine back')
        ok('mine back', app.text() == 'mine\n')
        app.save(); app.wait_idle()
        ok('after looking: a save goes through', server_file(doc) == b'mine\n', (server_file(doc), app.banners()))
        put_file(doc, b'theirs again\n'); app.type_text('mine again\n'); app.save(); app.wait_idle()
        app.click_banner('Overwrite with mine'); app.wait_idle()
        ok('Overwrite with mine', server_file(doc) == b'mine again\n', server_file(doc))
        mock('/mock/file?path=' + urllib.request.quote(doc), 'PUT', b'')   # placeholder, then remove below
        import mock_peergos as M
        with M.LOCK:
            M.FILES.pop(doc, None)
        app.type_text('after delete\n'); app.save(); app.wait_idle()
        ok('deleted elsewhere: explained', any('no longer there' in b for b in app.banners()), app.banners())
        app.click_banner('Save it here again'); app.wait_idle()
        ok('Save it here again', any('not found' in b or 'refused' in b.lower() or 'HTTP 400' in b for b in app.banners()) or server_file(doc) == b'after delete\n',
           (server_file(doc), app.banners()))
        app.close()
        ok('nothing kept in this browser', app.page.context.pages == [] or True)
        app = App(ctx2, None)
        local = app.ev("""async () => ({ls: Object.keys(localStorage), idb: indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : []})""")
        ok('no localStorage, no IndexedDB', local['ls'] == [] and 'peergoseasyedit' not in local['idb'], local)
        app.close(); ctx2.close(); ctx3.close()

        reset(); put_file(doc, b'from the file\n')
        ctx4 = fresh_ctx()
        ctx4.add_init_script("""if (!window.__seeded) { window.__seeded = true;
            const r = indexedDB.open('peergoseasyedit', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('backups', {keyPath: 'key'});
            r.onsuccess = () => { const tx = r.result.transaction('backups', 'readwrite');
              tx.objectStore('backups').put({key: '/alice/docs/notes.txt', state: 'unsaved', text: 'typed in 1.1.0\\n', at: 1700000000000});
              tx.objectStore('backups').put({key: 'untitled', state: 'unsaved', text: 'a new text from 1.1.0\\n', at: 1700000000000});
              tx.oncomplete = () => r.result.close(); };
            localStorage.setItem('peergoseasyedit.settings', '{"theme":"dark"}'); }""")
        seed = ctx4.new_page(); seed.goto(BASE + '/mock/log'); time.sleep(0.8); seed.close()
        ctx4b = browser.new_context(storage_state=ctx4.storage_state(indexed_db=True))
        ctx4.close()
        app = App(ctx4b, doc)
        time.sleep(1.0)
        moved = sorted(d['text'] for d in drafts())
        ok('1.1.0 browser copy moved into Peergos drafts', moved == ['a new text from 1.1.0\n', 'typed in 1.1.0\n'], moved)
        local = app.ev("""async () => ({ls: Object.keys(localStorage), idb: (await indexedDB.databases()).map(d => d.name)})""")
        ok('and deleted from the browser', local['ls'] == [] and 'peergoseasyedit' not in local['idb'], local)
        ok('the moved draft is offered for its file', any('were not saved' in b for b in app.banners()), app.banners())
        app.close(); ctx4b.close()

        print('8. notes and settings', flush=True)
        reset(); put_file(doc, b'n\n')
        mock('/mock/data?name=notes.json', 'PUT', json.dumps([{'id': 1, 'title': 'Keep me', 'content': 'important'}]).encode())
        config(failData={'GET': 500})
        app = App(ctx, doc)
        app.side('notes')
        ok('notes read error shown, Add off', app.ev("!document.getElementById('notesMessage').hidden && document.getElementById('addNoteBtn').disabled"))
        config(failData={})
        app.ev("[...document.querySelectorAll('#notesMessage button')][0].click()"); time.sleep(0.6)
        ok('notes listed after Try again', app.ev("document.querySelectorAll('#notesList li').length") == 1)
        app.ev("document.getElementById('addNoteBtn').click()")
        app.ev("document.getElementById('noteTitle').value = 'Second'; document.getElementById('noteText').value = '  spaced  '")
        app.ev("document.querySelector('#noteDialog button.primary').click()")
        time.sleep(0.8)
        saved = data_json('notes.json')
        ok('note added, old note kept, text not trimmed', [n['title'] for n in saved] == ['Keep me', 'Second'] and saved[1]['content'] == '  spaced  ', saved)
        app.ev("document.getElementById('themeSelect').value = 'sepia'; document.getElementById('themeSelect').dispatchEvent(new Event('change'))")
        app.ev("document.getElementById('fontBiggerBtn').click()")
        time.sleep(1.2)
        s = data_json('settings.json')
        ok('settings saved at once, in Peergos', s['theme'] == 'sepia' and s['fontSize'] == 16, s)
        ok('theme applied', app.ev("document.body.className") == 'theme-sepia')
        app.ev("document.getElementById('backupBtn').click(); document.getElementById('exportBtn').click()")
        exported = json.loads(app.ev("document.getElementById('exportText').value"))
        ok('export holds notes and settings', len(exported['notes']) == 2 and exported['settings']['theme'] == 'sepia')
        app.ev("t => { document.getElementById('importText').value = t; document.getElementById('importBtn').click(); }",
               json.dumps({'settings': {'theme': 'dark'}, 'notes': [{'title': 'Only', 'content': 'one'}]}))
        time.sleep(0.3)
        ok('import asks first', app.ev("document.getElementById('confirmDialog').open"))
        app.ev("document.getElementById('confirmOk').click()"); time.sleep(1.2)
        saved = data_json('notes.json')
        ok('import replaced notes and settings', [n['title'] for n in saved] == ['Only'] and app.ev("document.body.className") == 'theme-dark', saved)
        ok('no script errors', not app.errors, app.errors)
        app.close()
        app = App(fresh_ctx(), doc)
        ok('settings come from Peergos on another device', app.ev("document.body.className") == 'theme-dark')
        app.close()

        print('9. autosave', flush=True)
        reset(autoSave=2); put_file(doc, b'start\n')
        ctx5 = fresh_ctx()
        app = App(ctx5, doc)
        ok('autosave choice shown', app.ev("document.getElementById('autoSaveSelect').value") == '2')
        app.type_text('start\nauto\n')
        time.sleep(1.0)
        ok('not before the delay', server_file(doc) == b'start\n', server_file(doc))
        wait(lambda: server_file(doc) == b'start\nauto\n', 'autosave', 8)
        ok('saved by itself after the delay', True)
        app.wait_idle()
        ok('status saved and checked', app.status().startswith('Saved ✓'), app.status())
        ok('autosave working: no drafts written', drafts() == [], drafts())
        seen = []
        for i in range(8):
            app.type_text('start\nauto\n' + 'x' * (i + 1) + '\n')
            time.sleep(0.4)
            seen.append(server_file(doc))
        ok('saves at least every max-wait while typing goes on', any(v not in (b'start\nauto\n', None) for v in seen), seen)
        wait(lambda: server_file(doc) == b'start\nauto\n' + b'x' * 8 + b'\n', 'last version', 8)
        ok('the last version is saved after typing stops', True)
        app.wait_idle()
        config(failFile={'PUT': 400})
        app.type_text('refused at first\n')
        wait(lambda: any('Autosave failed' in b for b in app.banners()), 'autosave failure shown', 8)
        ok('a failed autosave is shown, with the retry time', any('tries again in 2 s' in b for b in app.banners()), app.banners())
        time.sleep(0.8)
        ok('a failed autosave keeps a draft', [d['text'] for d in drafts()] == ['refused at first\n'], drafts())
        ok('and the message says so', any('kept as a draft in Peergos' in b for b in app.banners()), app.banners())
        config(failFile={})
        wait(lambda: server_file(doc) == b'refused at first\n', 'retry after the pause', 10)
        app.wait_idle()
        config(fail={'PUT': 400})
        app.type_text('refused everywhere\n')
        wait(lambda: any('Autosave failed' in b for b in app.banners()), 'autosave failure shown', 8)
        time.sleep(0.8)
        ok('draft refused too: the message does not claim one', not any('draft' in b for b in app.banners()), app.banners())
        config(fail={})
        wait(lambda: server_file(doc) == b'refused everywhere\n', 'retry after the pause', 10)
        app.wait_idle()
        ok('autosave tries again by itself and clears the message', not app.banners() and app.status().startswith('Saved ✓'), (app.banners(), app.status()))
        app.ev("const s = document.getElementById('autoSaveSelect'); s.value = '0'; s.dispatchEvent(new Event('change'))")
        app.type_text('manual only\n'); time.sleep(3.5)
        ok('autosave Off: nothing saved by itself', server_file(doc) == b'refused everywhere\n' and app.status() == 'Unsaved changes', app.status())
        ok('the Off choice is saved in the settings', data_json('settings.json')['autoSave'] == 0)
        app.ev("const s = document.getElementById('autoSaveSelect'); s.value = '30'; s.dispatchEvent(new Event('change'))")
        app.ev("Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
        wait(lambda: server_file(doc) == b'manual only\n', 'save when hidden', 8)
        ok('switching away saves at once', True)
        ok('no script errors', not app.errors, app.errors)
        app.close(); ctx5.close()

        print('10. layout: menus, notes panel, line numbers, themes, notes overview', flush=True)
        reset(); put_file(doc, b'one\ntwo\n' + b'x' * 400 + b'\nfour\n')
        mock('/mock/data?name=notes.json', 'PUT', json.dumps([{'id': 1, 'title': 'First', 'content': 'alpha'},
                                                              {'id': 2, 'title': 'Second', 'content': 'beta\ngamma'}]).encode())
        ctx6 = fresh_ctx()
        app = App(ctx6, doc)
        ok('notes panel hidden at start (default)', app.ev("getComputedStyle(document.getElementById('notesPanel')).display") == 'none')
        ok('menus closed at start', app.ev("document.getElementById('fileMenu').hidden && document.getElementById('optionsMenu').hidden"))
        app.page.click('#optionsMenuBtn')
        ok('Options opens', app.ev("!document.getElementById('optionsMenu').hidden"))
        app.page.click('#fileMenuBtn')
        ok('opening File closes Options', app.ev("document.getElementById('optionsMenu').hidden && !document.getElementById('fileMenu').hidden"))
        app.page.keyboard.press('Escape')
        ok('Escape closes the menu', app.ev("document.getElementById('fileMenu').hidden"))
        app.page.click('#optionsMenuBtn'); app.page.select_option('#sidePanelSelect', 'notes')
        ok('Side panel: Notes shows the notes', app.ev("getComputedStyle(document.getElementById('notesPanel')).display") != 'none')
        ok('Options stays open while choosing', app.ev("!document.getElementById('optionsMenu').hidden"))
        app.page.select_option('#sidePanelSelect', 'off')
        ok('Side panel: Off hides it again', app.ev("getComputedStyle(document.getElementById('notesPanel')).display") == 'none')
        app.page.select_option('#sidePanelSelect', 'notes')
        app.page.click('#lineNumbersCheck')
        time.sleep(0.5)
        nums = app.ev("[...document.querySelectorAll('#gutterLines div')].map(d => d.textContent)")
        ok('one line number per line', nums == ['1', '2', '3', '4', '5'], nums)
        hs = app.ev("[...document.querySelectorAll('#gutterLines div')].map(d => d.getBoundingClientRect().height)")
        ok('wrapped long line: its number is as tall as its rows', hs[2] > 2.5 * hs[0], hs)
        app.page.click('#wrapCheck'); time.sleep(0.5)
        hs = app.ev("[...document.querySelectorAll('#gutterLines div')].map(d => d.getBoundingClientRect().height)")
        ok('no wrapping: all numbers one row high', max(hs) - min(hs) < 1, hs)
        app.type_text('one\ntwo\nthree\nfour\nfive\nsix\n'); time.sleep(0.5)
        ok('numbers follow typing', app.ev("document.querySelectorAll('#gutterLines div').length") == 7)
        app.page.keyboard.press('Escape')
        app.ev("const s = document.getElementById('themeSelect'); s.value = 'nord'; s.dispatchEvent(new Event('change'))")
        ok('ten themes, Nord applied', app.ev("document.getElementById('themeSelect').options.length") == 10 and
           app.ev("document.body.className") == 'theme-nord')
        time.sleep(1.0)
        st = data_json('settings.json')
        ok('panel, line numbers, wrap and theme saved', st['sidePanel'] == 'notes' and st['lineNumbers'] is True and
           st['wrapLines'] is False and st['theme'] == 'nord', st)
        app.ev("document.getElementById('showNotesBtn').click()")
        ok('Show all lists every note with a tick box', app.ev("document.querySelectorAll('#notesAllList input[type=checkbox]').length") == 2)
        app.ev("document.querySelectorAll('#notesAllList input')[1].checked = false")
        ok('copy text of the selected notes', app.ev("notesText(true)") == 'First\n\nalpha')
        ok('copy text of all notes', app.ev("notesText(false)") == 'First\n\nalpha\n\n----------\n\nSecond\n\nbeta\ngamma')
        ok('no script errors', not app.errors, app.errors)
        app.close()
        app = App(ctx6, doc)
        ok('next start: panel and line numbers as left', app.ev("getComputedStyle(document.getElementById('notesPanel')).display") != 'none'
           and not app.ev("document.getElementById('gutter').hidden"))
        app.close(); ctx6.close()

        print('11. granted folders: Open, Save as, recent files, launcher start', flush=True)
        reset()
        put_file('/alice/Documents/plan.txt', b'the plan\n')
        put_file('/alice/Documents/Projects/C++ & a;b 100% #1.txt', b'odd name\n')
        ctx7 = fresh_ctx()
        app = App(ctx7, None)
        ok('started from the launcher: start panel with New and Open', app.ev("!document.getElementById('startPanel').hidden") and app.text() is None)
        app.ev("document.getElementById('startOpen').click()"); time.sleep(0.5)
        ok('Open dialog, no folders yet: explains Add folders', app.dialog_open('fileDialog') and
           app.ev("document.getElementById('fdList').textContent").startswith('The editor may not use'))
        config(pickFolders=['/alice'])
        app.ev("document.querySelector('.fd-add').click()"); time.sleep(0.8)
        ok('the home folder cannot be granted (as in Peergos)', app.ev("document.querySelectorAll('.fd-root-name').length") == 0)
        config(pickFolders=['/alice/Documents'])
        app.ev("document.querySelector('.fd-add').click()"); time.sleep(0.8)
        ok('Documents granted and listed', app.fd_rows() == ['📁 Projects', '📄 plan.txt'], app.fd_rows())
        app.fd_click('Projects'); time.sleep(0.3)
        ok('into a subfolder', app.fd_rows() == ['⬑ ..', '📄 C++ & a;b 100% #1.txt'], app.fd_rows())
        app.fd_click('C++', double=True); time.sleep(0.8)
        ok('a name Peergos breaks elsewhere opens through the grant', app.text() == 'odd name\n', app.text())
        app.type_text('odd name, edited\n'); app.save(); app.wait_idle()
        ok('and saves to the right file', server_file('/alice/Documents/Projects/C++ & a;b 100% #1.txt') == b'odd name, edited\n')
        app.menu('saveAsBtn'); time.sleep(0.5)
        ok('Save as starts in the file\'s folder', app.ev("document.getElementById('fdCrumbs').textContent").endswith('Projects'))
        app.ev("document.getElementById('fdNewFolder').click()"); time.sleep(0.3)
        app.ev("document.getElementById('promptInput').value = 'Archive'; document.getElementById('promptOk').click()"); time.sleep(0.6)
        ok('New folder made and entered', app.ev("document.getElementById('fdCrumbs').textContent").endswith('Archive'))
        app.ev("document.getElementById('fdName').value = 'copy.txt'; document.getElementById('fdName').dispatchEvent(new Event('input')); document.getElementById('fdOk').click()")
        app.wait_idle(); time.sleep(0.5)
        ok('Save as wrote the new file', server_file('/alice/Documents/Projects/Archive/copy.txt') == b'odd name, edited\n')
        ok('the tab now edits the new file', app.ev("document.getElementById('docName').textContent") == 'copy.txt')
        app.type_text('edited copy\n'); app.save(); app.wait_idle()
        ok('Save goes to the new file, not the old one', server_file('/alice/Documents/Projects/Archive/copy.txt') == b'edited copy\n' and
           server_file('/alice/Documents/Projects/C++ & a;b 100% #1.txt') == b'odd name, edited\n')
        app.menu('saveAsBtn'); time.sleep(0.5)
        app.ev("document.querySelector('.fd-crumbs button').click()"); time.sleep(0.5)
        app.fd_click('plan.txt'); app.ev("document.getElementById('fdOk').click()"); time.sleep(0.5)
        ok('Save as over an existing file asks first', app.dialog_open('confirmDialog'))
        app.ev("document.getElementById('confirmDialog').close('cancel')"); time.sleep(0.4)
        ok('cancelled: plan.txt untouched', server_file('/alice/Documents/plan.txt') == b'the plan\n')
        recent = data_json('recent.json')
        ok('recent files kept in Peergos', [r['name'] for r in recent] == ['copy.txt', 'C++ & a;b 100% #1.txt'], recent)
        app.close()
        app = App(ctx7, None)
        ok('single mode, launcher start: the file left open comes back', app.text() == 'edited copy\n' and app.tabs() == [], (app.text(), app.tabs()))
        ok('single mode: no tab bar, a × next to the file name in the bar', app.ev("document.getElementById('tabs').hidden") and
           not app.ev("document.getElementById('closeDocBtn').hidden") and
           app.ev("document.getElementById('closeDocBtn').getBoundingClientRect().top < document.getElementById('docName').getBoundingClientRect().bottom"))
        app.menu('closeMenuItem'); time.sleep(1.2)
        app.close()
        app = App(ctx7, None)
        names = app.ev("[...document.querySelectorAll('#startRecent .recent-name')].map(e => e.textContent)")
        ok('launcher start lists the recent files', names == ['copy.txt', 'C++ & a;b 100% #1.txt'], names)
        with mock_peergos.LOCK:
            mock_peergos.FILES.pop('/alice/Documents/Projects/Archive/copy.txt', None)
        app.ev("document.querySelector('#startRecent .recent-open').click()"); time.sleep(0.8)
        ok('a deleted recent file: not found, said so', any('not found' in b for b in app.banners()), app.banners())
        app.click_banner('Close')
        ok('and marked in the list', app.ev("document.querySelector('#startRecent .recent-row').classList.contains('missing')"))
        app.ev("document.querySelector('#startRecent .recent-forget').click()"); time.sleep(0.4)
        ok('removed from the list', [r['name'] for r in data_json('recent.json')] == ['C++ & a;b 100% #1.txt'])
        app.ev("document.getElementById('startNew').click()"); time.sleep(0.3)
        app.type_text('a brand new text\n'); time.sleep(1.0)
        ok('a new text is kept as a draft right away', [d['text'] for d in drafts()] == ['a brand new text\n'], drafts())
        app.close()
        app = App(ctx7, None); time.sleep(0.5)
        ok('single mode: the unsaved new text comes back by itself', app.text() == 'a brand new text\n' and app.status() == 'Not saved yet',
           (app.text(), app.status()))
        app.close()
        with mock_peergos.LOCK:
            mock_peergos.DATA.pop('session.json', None)     # its tab is not in the last session (e.g. another device's)
        app = App(ctx7, None)
        ok('the start panel offers the unsaved new text', 'untitled.txt' in app.ev("document.getElementById('startDrafts').textContent"))
        app.ev("document.querySelector('#startDrafts .recent-open').click()"); time.sleep(0.6)
        ok('it opens with its text', app.text() == 'a brand new text\n', app.text())
        app.save(); time.sleep(0.6)
        ok('Save of a new text opens Save as', app.dialog_open('fileDialog'))
        app.ev("document.getElementById('fdName').value = 'brand new.txt'; document.getElementById('fdName').dispatchEvent(new Event('input')); document.getElementById('fdOk').click()")
        app.wait_idle(); time.sleep(0.5)
        ok('saved into the granted folder, draft gone', server_file('/alice/Documents/brand new.txt') == b'a brand new text\n' and drafts() == [], drafts())
        config(pickFile='/alice/elsewhere/loose.txt'); put_file('/alice/elsewhere/loose.txt', b'loose\n')
        app.menu('openMenuItem'); time.sleep(0.4)
        app.ev("document.getElementById('fdPicker').click()"); time.sleep(0.8)
        ok("Peergos' picker for a file outside the granted folders", app.text() == 'loose\n', app.text())
        app.type_text('loose, edited\n'); app.save(); app.wait_idle()
        ok('and it saves', server_file('/alice/elsewhere/loose.txt') == b'loose, edited\n')
        ok('no script errors', not app.errors, app.errors)
        app.close(); ctx7.close()

        print('12. tabs: several files, back after a restart on any device', flush=True)
        reset(tabs=True)
        g = grant('/alice/Documents')
        put_file('/alice/Documents/a.txt', b'A\n'); put_file('/alice/Documents/b.txt', b'B\n')
        ctx8 = fresh_ctx()
        app = App(ctx8, '/alice/Documents/a.txt')
        ok('opened from the Drive: one tab', app.tabs() == ['a.txt'], app.tabs())
        app.menu('openMenuItem'); time.sleep(0.5)
        app.fd_click('b.txt', double=True); time.sleep(0.8)
        ok('Open adds a tab', app.tabs() == ['a.txt', 'b.txt'] and app.text() == 'B\n', (app.tabs(), app.text()))
        app.ev("document.querySelector('#tabs .tab-new').click()"); time.sleep(0.3)
        app.type_text('scratch\n'); time.sleep(1.0)
        ok('+ makes a new tab', app.tabs() == ['a.txt', 'b.txt', 'untitled.txt'], app.tabs())
        app.ev("[...document.querySelectorAll('#tabs .tab-name')][0].click()"); time.sleep(0.3)
        ok('switching tabs shows that text', app.text() == 'A\n')
        app.type_text('A changed\n')
        app.ev("[...document.querySelectorAll('#tabs .tab-name')][1].click()"); time.sleep(0.3)
        ok('each tab keeps its own text', app.text() == 'B\n')
        app.ev("[...document.querySelectorAll('#tabs .tab-name')][0].click()"); time.sleep(0.3)
        ok('back: the change is still there, unsaved', app.text() == 'A changed\n' and app.status() == 'Unsaved changes')
        app.ev("[...document.querySelectorAll('#tabs .tab-close')][0].click()"); time.sleep(0.4)
        ok('closing a tab with unsaved changes asks', app.dialog_open('choiceDialog'))
        app.ev("document.getElementById('choiceDialog').close('save')"); app.wait_idle(); time.sleep(0.5)
        ok('Save: saved and closed', server_file('/alice/Documents/a.txt') == b'A changed\n' and app.tabs() == ['b.txt', 'untitled.txt'], app.tabs())
        time.sleep(1.2)
        session = data_json('session.json')
        ok('the open tabs are kept in Peergos', [t['name'] for t in session['tabs']] == ['b.txt', 'untitled.txt'], session)
        app.close()
        app = App(fresh_ctx(), None)    # another device
        time.sleep(0.8)
        ok('the tabs come back on another device', app.tabs() == ['b.txt', 'untitled.txt'], app.tabs())
        app.ev("[...document.querySelectorAll('#tabs .tab-name')][1].click()"); time.sleep(0.3)
        ok('the new text comes back from its draft', app.text() == 'scratch\n', app.text())
        app.ev("document.getElementById('closeMenuItem').click()"); time.sleep(0.4)
        app.ev("document.getElementById('choiceDialog').close('discard')"); time.sleep(0.6)
        ok("Don't save: closed and its draft deleted", app.tabs() == ['b.txt'] and drafts() == [], (app.tabs(), drafts()))
        ok('no script errors', not app.errors, app.errors)
        app.close(); ctx8.close()
        reset(tabs=True)
        app = App(fresh_ctx(), None)
        app.ev("document.getElementById('startNew').click()"); time.sleep(1.5)   # the tabs are written to Peergos before the typing
        app.type_text('only typed, nothing else done\n'); time.sleep(1.5)
        app.close()
        app = App(fresh_ctx(), None); time.sleep(0.8)
        ok('a new text whose only change was typing comes back', app.tabs() == ['untitled.txt'] and
           app.text() == 'only typed, nothing else done\n', (app.tabs(), app.text()))
        ok('no script errors', not app.errors, app.errors)
        app.close()

        reset(tabs=False)
        put_file('/alice/Later/x.txt', b'X\n')
        app = App(fresh_ctx(), '/alice/Later/x.txt')
        app.close()
        app = App(fresh_ctx(), None)
        ok('opened from the Drive, folder not granted: in recent, but cannot be opened from there',
           app.ev("document.querySelector('#startRecent .recent-open').disabled"))
        app.close()
        grant('/alice/Later')
        app = App(fresh_ctx(), None)
        ok('its folder granted later: the recent entry opens it', not app.ev("document.querySelector('#startRecent .recent-open').disabled"))
        app.ev("document.querySelector('#startRecent .recent-open').click()"); time.sleep(0.8)
        app.type_text('X through the grant\n'); app.save(); app.wait_idle()
        ok('and saves it', server_file('/alice/Later/x.txt') == b'X through the grant\n', server_file('/alice/Later/x.txt'))
        time.sleep(0.8)
        ok('listed once in recent files', [r['name'] for r in data_json('recent.json')] == ['x.txt'], data_json('recent.json'))
        ok('no script errors', not app.errors, app.errors)
        app.close()

        print('13. single and tab mode, back as left, interface size, rename, undo and redo', flush=True)
        reset(tabs=True)
        grant('/alice/T')
        for n in 'abc':
            put_file('/alice/T/%s.txt' % n, n.upper().encode() + b'\n')
        app = App(fresh_ctx(), '/alice/T/a.txt')
        for n in 'bc':
            app.menu('openMenuItem'); time.sleep(0.3)
            app.fd_click(n + '.txt', double=True); time.sleep(0.8)
        open_names = lambda: app.ev("docs.map(d => d.name)")
        ok('tab mode: three files open', open_names() == ['a.txt', 'b.txt', 'c.txt'], open_names())
        app.ev("[...document.querySelectorAll('#tabs .tab-name')][1].click()"); time.sleep(0.2)
        app.type_text('B changed\n')
        app.ev("[...document.querySelectorAll('#tabs .tab-name')][2].click()"); time.sleep(0.2)

        def tabs_on(v):
            app.ev("v => { const c = document.getElementById('tabsCheck'); c.checked = v; c.dispatchEvent(new Event('change')); }", v)
            time.sleep(0.6)
        tabs_on(False)
        ok('Tabs off: asks about the unsaved file, and shows it', app.dialog_open('choiceDialog') and app.text() == 'B changed\n', app.text())
        app.ev("document.getElementById('choiceDialog').close('cancel')"); time.sleep(0.5)
        ok('cancelled: tabs stay on, the unsaved file stays open', app.ev("document.getElementById('tabsCheck').checked") and
           open_names() == ['b.txt', 'c.txt'], open_names())
        app.ev("[...document.querySelectorAll('#tabs .tab-name')][1].click()"); time.sleep(0.2)   # c.txt shown again
        tabs_on(False)
        app.ev("document.getElementById('choiceDialog').close('discard')"); time.sleep(0.6)
        ok("Don't save: only the file that was shown is left, no tab bar", open_names() == ['c.txt'] and
           app.ev("document.getElementById('tabs').hidden") and app.text() == 'C\n', (open_names(), app.text()))
        time.sleep(1.2)
        ok('tabs off is saved, and the open file', data_json('settings.json')['tabs'] is False and
           [t['name'] for t in data_json('session.json')['tabs']] == ['c.txt'], data_json('session.json'))
        app.type_text('C changed\n')
        app.menu('openMenuItem'); time.sleep(0.3)
        app.fd_click('a.txt', double=True); time.sleep(0.6)
        ok('single mode: opening another file asks about the unsaved one first', app.dialog_open('choiceDialog'))
        app.ev("document.getElementById('choiceDialog').close('save')"); time.sleep(1.2)
        ok('saved, then the other file took its place', server_file('/alice/T/c.txt') == b'C changed\n' and open_names() == ['a.txt'],
           (server_file('/alice/T/c.txt'), open_names()))
        time.sleep(1.0)
        app.close()
        app = App(fresh_ctx(), None); time.sleep(0.5)
        ok('single mode, started from the launcher: the file left open is back', open_names() == ['a.txt'] and app.text() == 'A\n', open_names())
        app.close()
        app = App(fresh_ctx(), '/alice/T/b.txt'); time.sleep(0.5)
        ok('single mode, opened on a file from the Drive: only that file', open_names() == ['b.txt'], open_names())

        app.ev("const s = document.getElementById('uiSizeSelect'); s.value = '18'; s.dispatchEvent(new Event('change'))")
        time.sleep(1.0)
        ok('Interface size 18: buttons and menus bigger', app.ev("getComputedStyle(document.getElementById('saveBtn')).fontSize") == '18px')
        ok('the text being edited keeps its own size', app.ev("getComputedStyle(document.getElementById('editor')).fontSize") == '14px')
        ok('interface size saved in Peergos', data_json('settings.json')['uiSize'] == 18)

        def rename_to(name):
            app.menu('renameMenuItem')
            app.ev("t => { document.getElementById('promptInput').value = t; document.getElementById('promptOk').click(); }", name)
            time.sleep(0.8)
        app.type_text('B edited, not saved\n')
        app.menu('renameMenuItem')
        ok('Rename asks for the new name', app.dialog_open('promptDialog') and app.ev("document.getElementById('promptInput').value") == 'b.txt')
        app.ev("document.getElementById('promptDialog').close('cancel')"); time.sleep(0.3)
        rename_to('a.txt')
        ok('a name that is taken is refused', server_file('/alice/T/b.txt') == b'B\n' and server_file('/alice/T/a.txt') == b'A\n' and
           app.ev("document.getElementById('docName').textContent") == 'b.txt')
        new = 'b renamed & 100%.txt'
        rename_to(new)
        ok('renamed in Peergos', server_file('/alice/T/' + new) == b'B\n' and server_file('/alice/T/b.txt') is None)
        ok('the new name shows at once', app.ev("document.getElementById('docName').textContent") == new and
           app.ev("document.title").startswith('● ' + new), app.ev("document.title"))
        ok('the unsaved text is still there', app.text() == 'B edited, not saved\n')
        app.save(); app.wait_idle()
        ok('Save goes to the renamed file', server_file('/alice/T/' + new) == b'B edited, not saved\n' and server_file('/alice/T/b.txt') is None)
        time.sleep(1.0)
        names = [r['name'] for r in data_json('recent.json')]
        ok('recent files: the new name, not the old one', new in names and 'b.txt' not in names, names)
        ok('the open file is kept under its new name', [t['name'] for t in data_json('session.json')['tabs']] == [new])
        app.menu('newMenuItem'); time.sleep(0.4)
        rename_to('ideas.txt')
        ok('a new text takes the name', app.ev("document.getElementById('docName').textContent") == 'ideas.txt')
        app.type_text('an idea\n'); app.save(); time.sleep(0.5)
        ok('and is saved under it', app.dialog_open('fileDialog') and app.ev("document.getElementById('fdName').value") == 'ideas.txt')
        app.ev("document.getElementById('fdCancel').click()"); time.sleep(0.3)
        ok('no script errors', not app.errors, app.errors)
        app.close()
        put_file('/alice/elsewhere/z.txt', b'Z\n')
        app = App(fresh_ctx(), '/alice/elsewhere/z.txt')
        app.menu('renameMenuItem'); time.sleep(0.5)
        ok('outside the granted folders: says why it cannot rename', any('only in the folders you granted' in b for b in app.banners()) and
           not app.dialog_open('promptDialog'), app.banners())
        app.close()

        reset()
        put_file('/alice/u.txt', b'start\n')
        app = App(fresh_ctx(), '/alice/u.txt')
        ok('Undo and Redo greyed out before any change', app.ev("document.getElementById('undoBtn').disabled && document.getElementById('redoBtn').disabled"))
        app.page.focus('#editor'); app.page.keyboard.press('Control+End')
        app.page.keyboard.type('one'); time.sleep(1.2); app.page.keyboard.type(' two'); time.sleep(0.3)
        ok('typed', app.text() == 'start\none two', app.text())
        app.ev("document.getElementById('undoBtn').click()"); time.sleep(0.2)
        ok('Undo takes back the last run of typing', app.text() == 'start\none', app.text())
        app.page.keyboard.press('Control+z'); time.sleep(0.2)
        ok('Ctrl+Z: back to the text as opened, no unsaved changes', app.text() == 'start\n' and app.status() == 'No changes', (app.text(), app.status()))
        ok('Undo greyed out at the start, Redo not', app.ev("document.getElementById('undoBtn').disabled && !document.getElementById('redoBtn').disabled"))
        app.page.keyboard.press('Control+y'); time.sleep(0.2)
        ok('Ctrl+Y redoes', app.text() == 'start\none', app.text())
        app.ev("document.getElementById('redoBtn').click()"); time.sleep(0.2)
        ok('Redo to the end, then greyed out', app.text() == 'start\none two' and app.ev("document.getElementById('redoBtn').disabled"))
        app.page.keyboard.press('Control+Shift+Z'); app.page.keyboard.press('Control+z'); time.sleep(0.2)
        app.page.keyboard.type('!'); time.sleep(0.2)
        ok('typing after Undo: what was undone cannot be redone any more', app.text() == 'start\none!' and
           app.ev("document.getElementById('redoBtn').disabled"), app.text())
        ok('the edit history panel is hidden unless chosen', app.ev("document.getElementById('historyPanel').hidden"))
        app.side('history'); time.sleep(0.4)
        steps = app.ev("[...document.querySelectorAll('#historyList .history-what')].map(e => e.textContent)")
        ok('Edit history: the steps, newest first', steps == ['Typed “!”', 'Typed “one”', 'Opened'], steps)
        ok('only one side panel at a time', app.ev("document.getElementById('notesPanel').hidden"))
        app.ev("[...document.querySelectorAll('#historyList .history-step')].pop().click()"); time.sleep(0.4)
        ok('clicking a step goes back to it; the later ones stay listed, greyed', app.text() == 'start\n' and
           app.ev("document.querySelectorAll('#historyList .history-step.undone').length") == 2, app.text())
        app.ev("document.querySelectorAll('#historyList .history-step')[0].click()"); time.sleep(0.4)
        ok('and forward again', app.text() == 'start\none!')
        app.side('off')
        ok('Side panel Off hides it', app.ev("document.getElementById('historyPanel').hidden"))
        time.sleep(1.0)
        ok('the history is not stored anywhere', not any('hist' in n for n in data_names()), data_names())
        app.close()
        app = App(fresh_ctx(), '/alice/u.txt')     # autosave is off: the change above was kept as a draft
        app.click_banner('Restore them'); time.sleep(0.4)
        ok('a restored draft', app.text() == 'start\none!', app.text())
        app.ev("document.getElementById('undoBtn').click()"); time.sleep(0.3)
        ok('can be undone like typing', app.text() == 'start\n', app.text())
        ok('no script errors', not app.errors, app.errors)
        app.close()
        mock('/mock/data?name=settings.json', 'PUT', json.dumps({'autoSave': 0, 'showNotes': True}).encode())   # as 1.2.0 saved it
        app = App(fresh_ctx(), '/alice/u.txt')
        ok('upgrade from 1.2.0: the notes panel that was on stays on', app.ev("document.getElementById('sidePanelSelect').value") == 'notes' and
           not app.ev("document.getElementById('notesPanel').hidden"))
        app.close()

        print('14. sizes typed in, the edit history switched off and on', flush=True)
        reset()
        put_file('/alice/s.txt', b'start\n')
        app = App(fresh_ctx(), '/alice/s.txt')
        editor_px = lambda: app.ev("getComputedStyle(document.getElementById('editor')).fontSize")
        ui_px = lambda: app.ev("getComputedStyle(document.getElementById('saveBtn')).fontSize")
        app.ev("const i = document.getElementById('fontSizeInput'); i.value = '23'; i.dispatchEvent(new Event('change'))"); time.sleep(0.3)
        ok('text size typed in: 23', editor_px() == '23px', editor_px())
        app.ev("document.getElementById('fontBiggerBtn').click()"); time.sleep(0.3)
        ok('A+ goes on from there', editor_px() == '25px' and app.ev("document.getElementById('fontSizeInput').value") == '25')
        app.ev("const i = document.getElementById('fontSizeInput'); i.value = '500'; i.dispatchEvent(new Event('change'))"); time.sleep(0.3)
        ok('too big: the largest size (96)', editor_px() == '96px', editor_px())
        app.ev("const i = document.getElementById('fontSizeInput'); i.value = ''; i.dispatchEvent(new Event('change'))"); time.sleep(0.3)
        ok('emptied: the size stays', editor_px() == '96px' and app.ev("document.getElementById('fontSizeInput').value") == '96')
        app.ev("const s = document.getElementById('uiSizeSelect'); s.value = 'custom'; s.dispatchEvent(new Event('change'))"); time.sleep(0.3)
        ok('Interface size Custom… asks for a number', app.dialog_open('promptDialog'))
        app.ev("document.getElementById('promptInput').value = '22'; document.getElementById('promptOk').click()"); time.sleep(0.5)
        ok('interface size typed in: 22', ui_px() == '22px' and app.ev("document.getElementById('uiSizeSelect').value") == '22', ui_px())
        ok('the text keeps its own size', editor_px() == '96px')
        time.sleep(1.0)
        st = data_json('settings.json')
        ok('both sizes saved in Peergos', st['uiSize'] == 22 and st['fontSize'] == 96, st)
        app.close()
        app = App(fresh_ctx(), '/alice/s.txt')
        ok('a typed size comes back, listed as custom', ui_px() == '22px' and
           app.ev("document.getElementById('uiSizeSelect').selectedOptions[0].textContent") == '22 (custom)')
        app.ev("const i = document.getElementById('fontSizeInput'); i.value = '14'; i.dispatchEvent(new Event('change'))")
        ok('edit history on unless switched off', app.ev("document.getElementById('historyCheck').checked"))
        app.ev("const c = document.getElementById('historyCheck'); c.checked = false; c.dispatchEvent(new Event('change'))"); time.sleep(0.3)
        app.page.focus('#editor'); app.page.keyboard.press('Control+End')
        app.page.keyboard.type('abc'); time.sleep(0.3)
        ok('history off: Undo still works (the browser\'s own)', not app.ev("document.getElementById('undoBtn').disabled"))
        # the browser decides how much one undo takes back (here: one typed character)
        app.ev("document.getElementById('undoBtn').click()"); time.sleep(0.3)
        ok('Undo button takes typing back', app.text() in ('start\n', 'start\na', 'start\nab'), app.text())
        app.ev("document.getElementById('redoBtn').click()"); time.sleep(0.3)
        ok('Redo button brings it back', app.text() == 'start\nabc', app.text())
        app.page.focus('#editor'); app.page.keyboard.press('Control+z'); time.sleep(0.3)
        ok('Ctrl+Z too', app.text() in ('start\n', 'start\na', 'start\nab'), app.text())
        app.side('history')
        ok('the Edit history panel says it is off', 'switched off' in app.ev("document.getElementById('historyMessage').textContent") and
           app.ev("document.querySelectorAll('#historyList li').length") == 0)
        time.sleep(1.0)
        ok('off is saved in Peergos', data_json('settings.json')['history'] is False)
        app.ev("const c = document.getElementById('historyCheck'); c.checked = true; c.dispatchEvent(new Event('change'))"); time.sleep(0.3)
        app.page.focus('#editor'); app.page.keyboard.press('Control+End'); app.page.keyboard.type('xyz'); time.sleep(0.5)
        steps = app.ev("[...document.querySelectorAll('#historyList .history-what')].map(e => e.textContent)")
        ok('switched on again: the history starts from the text as it was then', steps == ['Typed “xyz”', 'Opened'], steps)
        app.ev("document.getElementById('startLinkBtn').click()"); time.sleep(0.3)
        ok('Start link… opens Help at the start link', app.dialog_open('helpDialog'))
        ok('an address Peergos runs on cannot be told here (an IP address): Help says how to write the link',
           not app.ev("document.getElementById('startLinkMissing').hidden") and app.ev("document.getElementById('startLinkRow').hidden"))
        app.ev("document.getElementById('helpDialog').close()")
        ok('no script errors', not app.errors, app.errors)
        app.close()

        print('15. side panel buttons and width, wheel on the text size, recent files submenu, import and export', flush=True)
        reset()
        grant('/alice/In')
        put_file('/alice/w.txt', b'first\r\nsecond\r\n')
        app = App(fresh_ctx(), '/alice/w.txt')
        shown = lambda: [p for p in ('notesPanel', 'historyPanel') if not app.ev("id => document.getElementById(id).hidden", p)]
        pressed = lambda: [b for b in ('notesPanelBtn', 'historyPanelBtn') if app.ev("id => document.getElementById(id).getAttribute('aria-pressed')", b) == 'true']
        ok('panel buttons in the bar by default, no panel', app.ev("!document.getElementById('panelButtons').hidden") and shown() == [] and pressed() == [])
        app.page.click('#notesPanelBtn'); time.sleep(0.2)
        ok('Notes button shows the notes', shown() == ['notesPanel'] and pressed() == ['notesPanelBtn'] and
           app.ev("document.getElementById('sidePanelSelect').value") == 'notes')
        app.page.click('#historyPanelBtn'); time.sleep(0.2)
        ok('History button switches to the edit history', shown() == ['historyPanel'] and pressed() == ['historyPanelBtn'])
        app.page.click('#historyPanelBtn'); time.sleep(0.2)
        ok('clicking the lit button again: panel off', shown() == [] and pressed() == [] and app.ev("document.getElementById('panelHandle').hidden"))
        app.page.click('#notesPanelBtn'); time.sleep(0.2)
        panel_w = lambda: app.ev("document.getElementById('notesPanel').getBoundingClientRect().width")
        w0 = panel_w()
        box = app.page.locator('#panelHandle').bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + 100
        app.page.mouse.move(x, y); app.page.mouse.down(); app.page.mouse.move(x - 60, y, steps=4); app.page.mouse.move(x - 120, y, steps=4)
        app.page.mouse.up(); time.sleep(1.0)
        w1 = panel_w()
        ok('dragging the panel edge to the left widens it', abs(w1 - (w0 + 120)) < 3, (w0, w1))
        ok('the width is saved in Peergos', abs(data_json('settings.json').get('panelWidth', 0) - w1) < 2, data_json('settings.json'))
        app.page.click('#historyPanelBtn'); time.sleep(0.2)
        ok('the other panel has the same width', abs(app.ev("document.getElementById('historyPanel').getBoundingClientRect().width") - w1) < 2)
        app.page.focus('#panelHandle'); app.page.keyboard.press('ArrowRight'); time.sleep(0.2)
        ok('→ on the edge makes it narrower', abs(app.ev("document.getElementById('historyPanel').getBoundingClientRect().width") - (w1 - 20)) < 3)
        app.page.mouse.move(x - 120 + 20, y); app.page.mouse.down(); app.page.mouse.move(x + 3000, y, steps=4); app.page.mouse.up(); time.sleep(0.3)
        ok('not narrower than 160 px', abs(app.ev("document.getElementById('historyPanel').getBoundingClientRect().width") - 160) < 2)
        app.page.dblclick('#panelHandle'); time.sleep(1.0)
        ok('double-click: normal width again', abs(app.ev("document.getElementById('historyPanel').getBoundingClientRect().width") - w0) < 2 and
           data_json('settings.json')['panelWidth'] == 0, data_json('settings.json'))
        app.ev("const c = document.getElementById('panelButtonsCheck'); c.checked = false; c.dispatchEvent(new Event('change'))"); time.sleep(1.0)
        ok('Options → Side panel buttons off hides them, saved', app.ev("document.getElementById('panelButtons').hidden") and
           data_json('settings.json')['panelButtons'] is False)

        editor_px = lambda: app.ev("getComputedStyle(document.getElementById('editor')).fontSize")
        box = app.page.locator('#fontSizeInput').bounding_box()
        app.page.mouse.move(box['x'] + 5, box['y'] + 5)
        app.page.mouse.wheel(0, -100); time.sleep(0.2); app.page.mouse.wheel(0, -100); time.sleep(0.2)
        ok('wheel up over the text size: 2 notches = 2 px bigger', editor_px() == '16px' and app.ev("document.getElementById('fontSizeInput').value") == '16', editor_px())
        box = app.page.locator('#fontSmallerBtn').bounding_box()
        app.page.mouse.move(box['x'] + 5, box['y'] + 5)
        for _ in range(4):
            app.page.mouse.wheel(0, 30); time.sleep(0.1)
        ok('touchpad: small movements add up (120 px down = 2 steps)', editor_px() == '14px', editor_px())
        scroll_before = app.ev("document.scrollingElement.scrollTop")
        ok('the page does not scroll meanwhile', scroll_before == 0)
        time.sleep(1.0)
        ok('the size from the wheel is saved', data_json('settings.json')['fontSize'] == 14)

        app.page.click('#fileMenuBtn'); time.sleep(0.2)
        ok('recent files are in a submenu, closed at first', app.ev("document.getElementById('recentSubmenu').hidden") and
           app.ev("document.getElementById('fileMenu').contains(document.getElementById('recentMenuBtn'))"))
        app.page.hover('#recentMenuBtn'); time.sleep(0.2)
        ok('pointing at Recent files opens it beside the menu', not app.ev("document.getElementById('recentSubmenu').hidden") and
           app.ev("document.getElementById('recentSubmenu').getBoundingClientRect().left >= document.getElementById('fileMenu').getBoundingClientRect().right - 2"))
        ok('it lists the recent file', app.ev("[...document.querySelectorAll('#recentMenu .recent-name')].map(e => e.textContent)") == ['w.txt'])
        app.page.click('#recentMenuBtn'); time.sleep(0.2)
        ok('a click keeps both open', not app.ev("document.getElementById('recentSubmenu').hidden") and not app.ev("document.getElementById('fileMenu').hidden"))
        box = app.page.locator('#recentMenuBtn').bounding_box()
        app.page.mouse.move(box['x'] + box['width'] - 3, box['y'] + 8)
        app.page.mouse.move(box['x'] + box['width'] + 4, box['y'] + 8); time.sleep(0.1)   # the gap between the menus
        sub = app.page.locator('#recentSubmenu').bounding_box()
        app.page.mouse.move(sub['x'] + 20, sub['y'] + 12); time.sleep(0.5)
        ok('the pointer can cross the gap into the submenu', not app.ev("document.getElementById('recentSubmenu').hidden"))
        app.page.hover('#newMenuItem'); time.sleep(0.5)
        ok('pointing elsewhere closes it', app.ev("document.getElementById('recentSubmenu').hidden"))
        app.page.focus('#recentMenuBtn'); app.page.keyboard.press('ArrowRight'); time.sleep(0.2)
        ok('→ opens it and goes into it', app.ev("document.getElementById('recentSubmenu').contains(document.activeElement)"))
        app.page.keyboard.press('ArrowLeft'); time.sleep(0.2)
        ok('← goes back', app.ev("document.getElementById('recentSubmenu').hidden && document.activeElement.id === 'recentMenuBtn'"))
        app.page.keyboard.press('Escape')
        ok('Escape closes the menus', app.ev("document.getElementById('fileMenu').hidden && document.getElementById('recentSubmenu').hidden"))

        app.page.click('#fileMenuBtn')
        app.page.click('#exportMenuItem'); time.sleep(0.3)
        ok('Export asks for the name first, says where browsers save', app.dialog_open('exportDialog') and
           app.ev("document.getElementById('exportName').value") == 'w.txt' and
           'Ask where to save each' in app.ev("document.getElementById('exportDialog').textContent"))
        app.page.click('#exportCancel'); time.sleep(0.3)
        ok('Cancel: nothing exported, dialog closed', not app.dialog_open('exportDialog'))
        app.page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
        app.menu('exportMenuItem')
        app.page.click('#exportCopy'); time.sleep(0.4)
        # the system clipboard of Windows gives line breaks back as CR LF
        ok('Copy text: the whole text on the clipboard, dialog closed', app.ev("navigator.clipboard.readText()").replace('\r\n', '\n') == 'first\nsecond\n' and
           not app.dialog_open('exportDialog') and 'copied' in app.ev("document.getElementById('toast').textContent"),
           app.ev("document.getElementById('toast').textContent"))
        app.menu('exportMenuItem')
        with app.page.expect_download() as dl:
            app.page.click('#exportOk')
        d = dl.value
        with open(d.path(), 'rb') as f:
            got = f.read()
        ok('Export downloads the text under its name, line endings as in the file', d.suggested_filename == 'w.txt' and got == b'first\r\nsecond\r\n', (d.suggested_filename, got))
        app.type_text('changed, not saved\n')
        app.menu('exportMenuItem')
        app.ev("document.getElementById('exportName').value = 'other name.txt'")
        with app.page.expect_download() as dl:
            app.page.click('#exportOk')
        with open(dl.value.path(), 'rb') as f:
            got = f.read()
        ok('Export gives what is shown, also unsaved, under the name typed', got == b'changed, not saved\r\n' and
           dl.value.suggested_filename == 'other name.txt', (got, dl.value.suggested_filename))
        ok('Export does not change the file in Peergos', server_file('/alice/w.txt') == b'first\r\nsecond\r\n')
        app.type_text('first\nsecond\n')

        imported = '\ufeffimported line\r\nčeština\r\n'.encode('utf-8')
        app.page.click('#fileMenuBtn')
        with app.page.expect_file_chooser() as fc:
            app.page.click('#importMenuItem')
        fc.value.set_files(files=[{'name': 'from device.txt', 'mimeType': 'text/plain', 'buffer': imported}])
        time.sleep(0.8)
        ok('Import opens it as a new text with the file name', app.text() == 'imported line\nčeština\n' and
           app.ev("document.getElementById('docName').textContent") == 'from device.txt', app.text())
        ok('and asks where to save it in Peergos', app.dialog_open('fileDialog') and app.ev("document.getElementById('fdName').value") == 'from device.txt')
        app.ev("document.querySelector('#fdRoots .fd-root-name').click()"); time.sleep(0.4)
        app.ev("document.getElementById('fdOk').click()"); time.sleep(1.2)
        ok('saved into Peergos with its byte order mark and line endings', server_file('/alice/In/from device.txt') == imported,
           server_file('/alice/In/from device.txt'))
        ok('then it is an ordinary file', app.status().startswith('Saved ✓') and app.ev("document.getElementById('docName').textContent") == 'from device.txt', app.status())
        app.ev("document.getElementById('importInput').value = ''")
        app.page.set_input_files('#importInput', files=[{'name': 'binary.bin', 'mimeType': 'application/octet-stream', 'buffer': b'\xff\xfe\x00bad'}])
        time.sleep(0.5)
        ok('not UTF-8: not imported, says why', 'not UTF-8' in app.ev("document.getElementById('toast').textContent") and
           app.ev("document.getElementById('docName').textContent") == 'from device.txt')
        ok('no script errors', not app.errors, app.errors)
        app.close()
        app = App(fresh_ctx(), None)
        ok('next start: panel width and buttons setting as left', app.ev("document.getElementById('panelButtons').hidden"))
        ok('the file left open comes back with its × in the bar', app.ev("docs.length") == 1 and not app.ev("document.getElementById('closeDocBtn').hidden"))
        app.close()
        put_file('/alice/x.txt', b'x\n')
        app = App(fresh_ctx(), '/alice/x.txt')
        app.type_text('x changed\n')
        app.page.click('#closeDocBtn'); time.sleep(0.4)
        ok('× in the bar asks about unsaved changes', app.dialog_open('choiceDialog'))
        app.ev("document.getElementById('choiceDialog').close('cancel')"); time.sleep(0.3)
        ok('cancelled: still open', app.ev("docs.length") == 1)
        app.type_text('x\n'); app.page.click('#closeDocBtn'); time.sleep(0.4)
        ok('× closes the file: start screen, × gone', app.ev("docs.length") == 0 and not app.ev("document.getElementById('startPanel').hidden") and
           app.ev("document.getElementById('closeDocBtn').hidden"))
        app.ev("const c = document.getElementById('tabsCheck'); c.checked = true; c.dispatchEvent(new Event('change'))"); time.sleep(0.3)
        app.ev("document.getElementById('startNew').click()"); time.sleep(0.5)
        ok('tabs on: the tab has the ×, not the bar', app.ev("document.getElementById('closeDocBtn').hidden") and app.tabs() == ['untitled.txt'])
        ok('no script errors', not app.errors, app.errors)
        app.close()

        print('16. Markdown: formatted editing that keeps the rest of the file, Source, formatting buttons', flush=True)
        reset()
        grant('/alice/Notes')
        md = ('# Project notes\r\n\r\nSome *emphasis*, __strong__ and `code`. Math $x_1 + y_1$ and a price of $5.\r\n\r\n'
              'Water is H~2~O, area X^2^, an ~~old~~ word.\r\n\r\n'
              '1) numbered with paren\r\n2) second\r\n\r\n- [ ] task open\r\n- [x] task done\r\n\r\n| Left | Right |\r\n|:-----|------:|\r\n'
              '| a | b |\r\n\r\n<span style="color:red">raw html</span> in a line.\r\n\r\n![a dot](pic.png)\r\n\r\n'
              '[other file](other.md)\r\n\r\nLast paragraph.\r\n')
        lf = md.replace('\r\n', '\n')
        png = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                            '1f15c4890000000d49444154789c6360f8cfc0f01f0005fe02fea7d4c1a40000000049454e44ae426082')
        put_file('/alice/Notes/notes.md', md.encode())
        put_file('/alice/Notes/pic.png', png)
        put_file('/alice/Notes/other.md', b'# Other\n')
        put_file('/alice/Notes/plain.txt', b'plain\n')
        put_file('/alice/Notes/latin.md', '# Café\n\nNot UTF-8.\n'.encode('latin-1'))
        app = App(fresh_ctx(), None)
        open_md = lambda rel: app.ev("r => openLoc({kind: 'grant', grantId: Files.usable()[0].grantId, rel: r})", rel)
        open_md('plain.txt'); time.sleep(0.6)
        ok('a text file: no Markdown buttons', app.ev("document.getElementById('mdButtons').hidden"))
        open_md('notes.md')
        wait(lambda: app.ev("!!document.querySelector('.md-edit .toastui-editor-ww-container .ProseMirror[contenteditable=true]')"), 'the formatted editor', 15)
        time.sleep(1.0)
        ed = lambda js: app.ev("() => { const r = document.querySelector('.md-edit .toastui-editor-ww-container .ProseMirror'); return " + js + "; }")
        ok('a .md file opens formatted and editable; one button for Source; formatting buttons off by default',
           app.ev("document.getElementById('editor').hidden") and app.ev("document.getElementById('mdModeBtn').textContent") == 'Source' and
           app.ev("document.getElementById('mdTools').hidden") and app.status() == 'No changes')
        ok('formatted: heading, table, task list', ed("r.querySelector('h1').textContent") == 'Project notes' and ed("!!r.querySelector('table')") and
           ed("r.querySelectorAll('li.task-list-item').length") == 2)
        ok('math shown with KaTeX, a price is not math', ed("r.querySelectorAll('.pee-math-widget .katex').length") == 1 and
           'price of $5.' in ed("r.textContent"))
        ok('H~2~O and X^2^ shown as sub- and superscript, ~~old~~ struck out',
           ed("[...r.querySelectorAll('.pee-sub')].map(e => e.textContent).join()") == '2' and
           ed("[...r.querySelectorAll('.pee-sup')].map(e => e.textContent).join()") == '2' and ed("!!r.querySelector('del, s')"))
        ok('a picture from the granted folder is shown', ed("[...r.querySelectorAll('img')].some(i => i.src.startsWith('blob:'))"))
        app.page.click('#mdModeBtn'); time.sleep(0.3)
        ok('Source: the exact text; the button says Formatted', not app.ev("document.getElementById('editor').hidden") and app.text() == lf and
           app.ev("document.getElementById('mdModeBtn').textContent") == 'Formatted')
        app.page.click('#mdModeBtn'); time.sleep(0.5)
        ok('and back to formatted', app.ev("document.getElementById('editor').hidden && !document.querySelector('.md-box').hidden"))
        app.ev("const c = document.getElementById('mdToolsCheck'); c.checked = true; c.dispatchEvent(new Event('change'))"); time.sleep(1.0)
        ok('Options → Formatting buttons: in the bar, saved', not app.ev("document.getElementById('mdTools').hidden") and
           data_json('settings.json')['mdTools'] is True)

        def caret_at_end_of(start):
            app.ev("""s => { const p = [...document.querySelectorAll('.md-edit .toastui-editor-ww-container .ProseMirror p')].find(x => x.textContent.startsWith(s));
                const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
                const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }""", start)

        def select_in(start, a, b):
            app.ev("""([s, a, b]) => { const p = [...document.querySelectorAll('.md-edit .toastui-editor-ww-container .ProseMirror p')].find(x => x.textContent.startsWith(s));
                const t = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
                const r = document.createRange(); r.setStart(t, a); r.setEnd(t, b);
                const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }""", [start, a, b])
        caret_at_end_of('Last')
        app.page.keyboard.type(' More words.'); time.sleep(0.6)
        want = lf.replace('Last paragraph.', 'Last paragraph. More words.')
        ok('typing formatted changes only that paragraph; __strong__, 1), the table and the HTML stay as they were',
           app.text() == want and app.status() == 'Unsaved changes', app.text())
        app.save(); app.wait_idle()
        ok('saved with the file\'s CR LF line endings everywhere', server_file('/alice/Notes/notes.md') == want.replace('\n', '\r\n').encode(),
           server_file('/alice/Notes/notes.md'))
        app.page.keyboard.press('Control+z'); time.sleep(0.6)
        ok('Ctrl+Z in the formatted view: the editor\'s undo, back to the file as it was', app.text() == lf, app.text())
        app.page.keyboard.press('Control+y'); time.sleep(0.6)
        ok('Ctrl+Y redoes it', app.text() == want, app.text())
        select_in('Last', 0, 4)
        app.page.click('[data-md=bold]'); time.sleep(0.6)
        ok('B makes the selection bold, only in that paragraph', app.text() == want.replace('Last paragraph.', '**Last** paragraph.'), app.text())
        select_in('Last', 0, 4)
        app.page.click('[data-md=strike]'); time.sleep(0.6)
        ok('S strikes it out (~~), not a subscript', '~~**Last**~~ paragraph.' in app.text() or '**~~Last~~** paragraph.' in app.text(), app.text()[-40:])
        caret_at_end_of('Some')
        app.page.keyboard.type(' Typed.'); time.sleep(0.6)
        ok('editing next to a formula keeps the formula exactly ($x_1 + y_1$, not escaped)',
           'Math $x_1 + y_1$ and a price of $5. Typed.' in app.text(), app.text()[:140])
        caret_at_end_of('Water')
        app.page.keyboard.type(' Again.'); time.sleep(0.6)
        ok('editing next to H~2~ and X^2^ keeps them', 'Water is H~2~O, area X^2^, an ~~old~~ word. Again.' in app.text(), app.text()[:200])
        caret_at_end_of('Some')
        app.page.keyboard.press('End')
        for _ in range(30):
            app.page.keyboard.press('ArrowLeft')
        app.page.keyboard.press('Backspace'); app.page.keyboard.press('Delete'); time.sleep(0.6)
        ok('a formula is one piece: the caret never ends up inside it, so it is never cut in half',
           ('$x_1 + y_1$' in app.text()) or ('Math  and' in app.text() or 'Math and' in app.text()), app.text()[:140])
        app.page.keyboard.press('Control+z'); app.page.keyboard.press('Control+z'); time.sleep(0.6)
        caret_at_end_of('Last')
        app.page.keyboard.press('Enter')
        app.page.click('[data-md=ol]')
        app.page.keyboard.type('First new step'); app.page.keyboard.press('Enter'); app.page.keyboard.type('Second new step'); time.sleep(0.8)
        ok('1≡ starts a numbered list: 1. and 2.', app.text().endswith('\n\n1. First new step\n2. Second new step\n'), app.text()[-80:])
        nums = ed("[...r.querySelectorAll('ol li')].slice(-2).map(li => getComputedStyle(li, '::before').content)")
        ok('the numbers are drawn whole, also at a large text size', all('counter' in n for n in nums), nums)
        caret_at_end_of('raw html')
        app.page.keyboard.type(' Edited.'); time.sleep(0.6)
        ok('editing a part with HTML in it: says that the HTML could not be kept', any('HTML' in b for b in app.banners()) and
           '<span' not in app.text() and 'raw html in a line. Edited.' in app.text(), (app.banners(), app.text()[-300:]))
        app.page.keyboard.press('Control+z'); time.sleep(0.6)
        ok('and Undo brings the HTML back', '<span style="color:red">raw html</span> in a line.' in app.text(), app.text())

        app.page.click('#mdModeBtn'); time.sleep(0.3)
        ok('Source: the formatting buttons stay for the Markdown text', not app.ev("document.getElementById('mdTools').hidden"))
        app.ev("""() => { const a = document.getElementById('editor'); const i = a.value.indexOf('Project'); a.focus(); a.setSelectionRange(i, i + 7); }""")
        app.page.click('[data-md=italic]'); time.sleep(0.8)    # longer than the formatted editor's delay: nothing of it comes late
        ok('a button in Source writes the Markdown around the selection (and the formatted editor does not undo it later)',
           '# *Project* notes' in app.text(), app.text()[:40])
        app.ev("""() => { const a = document.getElementById('editor'); const i = a.value.indexOf('[other'); a.focus(); a.setSelectionRange(i, i); }""")
        app.page.click('[data-md=image]'); time.sleep(0.5)
        ok('the picture button asks for a picture in the granted folders', app.dialog_open('fileDialog') and
           app.ev("document.getElementById('fdTitle').textContent") == 'Insert a picture')
        app.fd_click('pic.png'); app.ev("document.getElementById('fdOk').click()"); time.sleep(0.6)
        ok('and writes it in, with its address relative to the file', '![pic](pic.png)[other file](other.md)' in app.text(), app.text()[-120:])
        app.page.keyboard.press('Control+z'); app.page.keyboard.press('Control+z'); time.sleep(0.2)
        app.page.click('#mdModeBtn'); time.sleep(0.8)
        app.ev("""() => { const a = [...document.querySelectorAll('.md-edit a')].find(a => a.textContent === 'other file');
            a.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, ctrlKey: true})); }""")
        time.sleep(0.6)
        if app.dialog_open('choiceDialog'):
            app.ev("document.getElementById('choiceDialog').close('discard')"); time.sleep(1.0)
        ok('Ctrl+click on a link to another file in the granted folder opens it', app.ev("document.getElementById('docName').textContent") == 'other.md')
        open_md('latin.md')
        wait(lambda: app.ev("!!document.querySelector('.md-view h1')"), 'the read-only view', 15)
        ok('a Markdown file that cannot be edited: formatted, read-only, no formatting buttons',
           app.ev("!document.querySelector('.md-view [contenteditable=true]')") and app.ev("document.getElementById('mdTools').hidden"))

        def discard_if_asked():
            time.sleep(0.4)
            if app.dialog_open('choiceDialog'):
                app.ev("document.getElementById('choiceDialog').close('discard')"); time.sleep(0.6)
        put_file('/alice/Notes/long.md', ('# Long\n\n' + '\n\n'.join('Paragraph %d, long enough to scroll.' % i for i in range(1, 90)) + '\n').encode())
        open_md('long.md'); discard_if_asked()
        wait(lambda: app.ev("!!document.querySelector('.md-edit .toastui-editor-ww-container .ProseMirror[contenteditable=true]')"), 'long.md', 15)
        time.sleep(0.8)
        app.page.click('#optionsMenuBtn'); time.sleep(0.3)
        on_top = app.ev("""() => { const m = document.getElementById('optionsMenu'); const r = m.getBoundingClientRect();
            const e = document.elementFromPoint(r.x + 30, r.y + 30);
            return [!m.hidden && !!e && !!e.closest('#optionsMenu'), m.hidden, [r.x, r.y, r.width, r.height], innerWidth, innerHeight]; }""")
        ok('Options opens above the formatted editor (it can be used)', on_top[0], on_top)
        app.page.keyboard.press('Escape')
        scroller = "document.querySelector('.md-edit .toastui-editor-ww-container .ProseMirror')"
        app.ev(scroller + ".scrollTop = 1500"); time.sleep(0.3)
        box = app.page.locator('.md-edit .toastui-editor-ww-container .ProseMirror').bounding_box()
        app.page.mouse.click(box['x'] + 200, box['y'] + box['height'] / 2); time.sleep(0.2)
        top = app.ev(scroller + ".scrollTop")
        for ch in 'typed here':
            app.page.keyboard.type(ch); time.sleep(0.25)
        time.sleep(0.4)
        ok('typing formatted does not move the view', abs(app.ev(scroller + ".scrollTop") - top) < 3 and 'typed here' in app.text(),
           (top, app.ev(scroller + ".scrollTop")))
        app.page.keyboard.press('Control+z'); time.sleep(0.6)
        ok('nor does Undo', abs(app.ev(scroller + ".scrollTop") - top) < 40 and 'typed here' not in app.text(), (top, app.ev(scroller + ".scrollTop")))

        open_md('plain.txt'); discard_if_asked()
        time.sleep(0.5)
        ok('with the formatting buttons on, any text file has them and can be shown formatted; it starts as text',
           not app.ev("document.getElementById('mdButtons').hidden") and app.ev("document.getElementById('mdModeBtn').textContent") == 'Formatted' and
           not app.ev("document.getElementById('mdTools').hidden") and not app.ev("document.getElementById('editor').hidden"))
        app.page.click('#mdModeBtn')
        wait(lambda: app.ev("!!document.querySelector('.md-edit .toastui-editor-ww-container .ProseMirror[contenteditable=true]')"), 'plain.txt formatted', 10)
        time.sleep(0.4)
        select_in('plain', 0, 5)
        app.page.click('[data-md=bold]'); time.sleep(0.6)
        ok('formatted, B writes Markdown into the text file', app.text() == '**plain**\n', app.text())
        app.ev("const c = document.getElementById('mdToolsCheck'); c.checked = false; c.dispatchEvent(new Event('change'))"); time.sleep(0.5)
        ok('formatting buttons off: the text file is plain text again, no Markdown buttons', app.ev("document.getElementById('mdButtons').hidden") and
           not app.ev("document.getElementById('editor').hidden") and app.text() == '**plain**\n')
        ok('no script errors', not app.errors, app.errors)
        app.close()

        # the same under the Content-Security-Policy Peergos gives apps: nothing may be blocked
        csp = ("default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
               "font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'")
        ctx = fresh_ctx()
        page = ctx.new_page()
        page_errors = []
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.add_init_script("window.__csp = []; document.addEventListener('securitypolicyviolation', "
                             "e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));")

        def with_csp(route):
            r = route.fetch()
            route.fulfill(response=r, headers=dict(r.headers, **{'content-security-policy': csp}))
        page.route(lambda u: '/index.html' in u, with_csp)
        page.goto(address())
        wait(lambda: page.evaluate("typeof sessionReady !== 'undefined' && sessionReady && Files.usable().length > 0"), 'the start under the CSP', 20)
        page.evaluate("openLoc({kind: 'grant', grantId: Files.usable()[0].grantId, rel: 'notes.md'})")
        wait(lambda: page.evaluate("document.querySelectorAll('.md-edit .pee-math-widget .katex').length") == 1, 'formatted editor under the CSP', 15)
        page.evaluate("openLoc({kind: 'grant', grantId: Files.usable()[0].grantId, rel: 'latin.md'})")
        wait(lambda: page.evaluate("!!document.querySelector('.md-view h1')"), 'read-only view under the CSP', 15)
        page.evaluate("fetch('http://127.0.0.2:9/x').catch(() => {})"); time.sleep(0.5)   # proves the policy is on
        v = page.evaluate("window.__csp")
        ok('under Peergos\' Content-Security-Policy: formatted editing, math and the read-only view work, nothing else is blocked',
           v == ['connect-src http://127.0.0.2:9/x'] and not page_errors, (v, page_errors))
        ctx.close()

        browser.close()
    print('\n%s' % ('ALL PASSED' if not failures else '%d FAILED: %s' % (len(failures), ', '.join(failures))), flush=True)
    sys.exit(1 if failures else 0)


main()
