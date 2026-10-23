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
        self.page.wait_for_function("document.getElementById('status') !== null")
        time.sleep(0.6)

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg)

    def text(self):
        return self.ev("document.getElementById('editor').value")

    def type_text(self, t):
        self.ev("t => { const e = document.getElementById('editor'); e.value = t; e.dispatchEvent(new Event('input')); }", t)

    def status(self):
        return self.ev("document.getElementById('status').textContent")

    def banners(self):
        return self.ev("[...document.querySelectorAll('.banner')].map(b => b.className + ': ' + b.querySelector('p').textContent)")

    def click_banner(self, label):
        self.ev("l => [...document.querySelectorAll('.banner button')].find(b => b.textContent === l).click()", label)

    def save(self):
        self.ev("document.getElementById('saveBtn').click()")

    def wait_idle(self, timeout=20):
        wait(lambda: not self.status().startswith('Saving'), 'save to end', timeout)
        time.sleep(0.3)

    def readonly(self):
        return self.ev("document.getElementById('editor').readOnly")

    def close(self):
        self.page.close()


def reset():
    mock('/mock/reset')


def main():
    mock_peergos.serve(A.port)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not A.headed, executable_path=A.chromium)
        doc = '/alice/docs/notes.txt'

        def fresh_ctx(autosave=0):
            # sections 1-8 check exact moments, so autosave is off there (the app's default is 5 s)
            c = browser.new_context()
            c.add_init_script("window.PEE_SAVE_TIMEOUT_MS = 4000; window.PEE_SLOW_SAVE_MS = 1500; "
                              "window.PEE_AUTO_MAX_WAIT_MS = 1500; window.PEE_AUTO_RETRY_MS = 2000; "
                              "localStorage.setItem('peergoseasyedit.settings', JSON.stringify({autoSave: %d}));" % autosave)
            return c

        print('1. open and save', flush=True)
        reset(); put_file(doc, b'Line one\nLine two\n')
        ctx = fresh_ctx(); app = App(ctx, doc)
        ok('file text shown', app.text() == 'Line one\nLine two\n', app.text())
        ok('editable after loading', not app.readonly())
        ok('Save disabled while nothing changed', app.ev("document.getElementById('saveBtn').disabled"))
        app.type_text('Line one\nLine two\nthree\n')
        ok('unsaved changes shown', app.status() == 'Unsaved changes' and app.ev("document.getElementById('docName').classList.contains('dirty')"), app.status())
        app.save(); app.wait_idle()
        ok('server has the text', server_file(doc) == b'Line one\nLine two\nthree\n', server_file(doc))
        ok('status says saved and checked', app.status().startswith('Saved ✓'), app.status())
        app.ev("document.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true}))")
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
        app.save(); app.wait_idle(40)
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
        mock('/mock/reset'); put_file(doc, b'never reaches peergos\n')
        config(hang=['PUT']); app.type_text('hangs\n'); app.save()
        wait(lambda: 'not answered' in app.status(), 'slow status', 5)
        ok('a slow save says so', True)
        app.wait_idle(10)
        ok('a save without answer ends in an error', any('did not answer' in b for b in app.banners()), app.banners())
        ok('no answer: text kept, unsaved', app.text() == 'hangs\n' and app.status() == 'Unsaved changes', app.status())
        mock('/mock/reset'); put_file(doc, b'never reaches peergos\n')
        config(readBack='garbage'); app.type_text('checked\n'); app.save(); app.wait_idle()
        ok('different read-back is an error, not "saved"', any('different content' in b for b in app.banners()) and app.status() == 'Unsaved changes', (app.banners(), app.status()))
        mock('/mock/reset'); put_file(doc, b'x\n')
        config(delay={'PUT': 1.5}); app.type_text('first\n'); app.save()
        time.sleep(0.5); app.type_text('first\nsecond, typed while saving\n')
        app.wait_idle()
        ok('typing during a save is not replaced', app.text() == 'first\nsecond, typed while saving\n', app.text())
        ok('server has what was saved; the rest stays unsaved', server_file(doc) == b'first\n' and app.status() == 'Unsaved changes', (server_file(doc), app.status()))
        config(delay={}); app.close()

        print('4. a file that could not be read is never shown empty or saved over', flush=True)
        reset(); put_file(doc, b'precious\n'); config(fail={'GET': 500})
        ctx.close(); ctx = fresh_ctx()   # no kept copy of earlier sections for this file
        app = App(ctx, doc)
        ok('error banner', any('could not be opened' in b for b in app.banners()), app.banners())
        ok('editor read-only, Save off', app.readonly() and app.ev("document.getElementById('saveBtn').disabled"))
        app.ev("document.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true}))"); time.sleep(0.5)
        ok('file untouched', server_file(doc) == b'precious\n')
        config(fail={}); app.click_banner('Try again'); time.sleep(0.8)
        ok('Try again opens it', app.text() == 'precious\n' and not app.readonly(), app.text())
        app.close()
        app = App(ctx, '/alice/docs/missing.txt')
        ok('missing file: says so, Save off', any('not found' in b for b in app.banners()) and app.ev("document.getElementById('saveBtn').disabled"), app.banners())
        app.close()

        print('5. names Peergos passes on changed', flush=True)
        for name in ['C++ notes.txt', 'a&b.txt', 'x&theme=y.txt', 'hash#1.txt', 'pct%41.txt']:
            path = '/alice/docs/' + name
            put_file(path, b'content of ' + name.encode())
            app = App(ctx, path)
            ok('%s: not opened, explained' % name, any('Rename the file' in b for b in app.banners()) and app.readonly(), app.banners())
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
        reset(); ctx.close(); ctx = fresh_ctx()
        put_file(doc, b'\xef\xbb\xbfWindows\r\nlines\r\n')
        app = App(ctx, doc)
        ok('no question about earlier copies', not app.banners(), app.banners())
        ok('shown without the BOM, with \\n', app.text() == 'Windows\nlines\n', repr(app.text()))
        app.type_text('Windows\nlines\nmore\n'); app.save(); app.wait_idle()
        ok('BOM and CRLF kept', server_file(doc) == b'\xef\xbb\xbfWindows\r\nlines\r\nmore\r\n', server_file(doc))
        app.close()
        put_file(doc, 'Žluťoučký kůň\n'.encode('cp1250'))
        app = App(ctx, doc)
        ok('not UTF-8: read-only with a message', app.readonly() and any('not UTF-8' in b for b in app.banners()), app.banners())
        app.save(); time.sleep(0.8)
        ok('not UTF-8: file never written', server_file(doc) == 'Žluťoučký kůň\n'.encode('cp1250'), server_file(doc))
        ok('not UTF-8: Save makes a UTF-8 copy', server_file('/alice/docs/notes (copy).txt') == 'Žluťoučký kůň\n'.encode('cp1250').decode('utf-8', 'replace').encode(), server_file('/alice/docs/notes (copy).txt'))
        app.close()

        print('7. text kept in the browser is offered back', flush=True)
        reset(); put_file(doc, b'base\n')
        ctx2 = fresh_ctx()
        app = App(ctx2, doc)
        app.type_text('base\nnever saved\n'); time.sleep(0.8)
        app.close()
        app = App(ctx2, doc)
        ok('offer to restore', any('were not saved' in b for b in app.banners()), app.banners())
        ok('read-only until decided', app.readonly())
        app.click_banner('Restore them')
        ok('restored and unsaved', app.text() == 'base\nnever saved\n' and app.status() == 'Unsaved changes', app.status())
        app.click_banner('Undo')
        ok('undo gives the file text back', app.text() == 'base\n')
        app.type_text('base\nsaved now\n'); app.save(); app.wait_idle()
        app.close()
        put_file(doc, b'base\n')   # e.g. a stale or truncated read, or a change elsewhere
        app = App(ctx2, doc)
        ok('notices the file is not what was saved', any('not what you saved' in b for b in app.banners()), app.banners())
        app.click_banner('Show my saved version')
        ok('shows the saved version', app.text() == 'base\nsaved now\n')
        app.close()
        app = App(ctx2, doc)
        ok('the shown saved version counts as unsaved', any('were not saved' in b for b in app.banners()), app.banners())
        app.click_banner('Discard them')
        ok('discarded: the file version stays', app.text() == 'base\n' and not app.readonly())
        app.close()
        app = App(ctx2, doc)
        app.type_text('base\nv2\n'); app.save(); app.wait_idle(); app.close()
        put_file(doc, b'base\n')
        app = App(ctx2, doc)
        app.click_banner('Keep the file as it is')
        ok('kept the file version', app.text() == 'base\n' and not app.readonly())
        app.close()
        app = App(ctx2, doc)
        ok('no question once decided', not app.banners(), app.banners())
        app.close()
        app = App(ctx2, None)
        app.type_text('a new text\n'); time.sleep(0.8); app.close()
        app = App(ctx2, None)
        ok('new text without a file is offered back', any('were not saved' in b for b in app.banners()), app.banners())
        app.click_banner('Restore them')
        app.save(); app.wait_idle()
        ok('Save without a file goes through the save dialog', server_file('/alice/docs/untitled.txt') == b'a new text\n', server_file('/alice/docs/untitled.txt'))
        app.close()
        app = App(ctx2, None)
        ok('saved new text is not offered again', not app.banners(), app.banners())
        app.close()
        config(saveAs=400)
        app = App(ctx2, None); app.type_text('x'); app.save(); time.sleep(0.6)
        ok('cancelled save dialog: still unsaved', app.status() == 'Unsaved changes', app.status())
        app.close(); ctx2.close()

        print('8. notes and settings', flush=True)
        reset(); put_file(doc, b'n\n')
        mock('/mock/data?name=notes.json', 'PUT', json.dumps([{'id': 1, 'title': 'Keep me', 'content': 'important'}]).encode())
        config(failData={'GET': 500})
        app = App(ctx, doc)
        app.ev("document.getElementById('notesBtn').click()")
        ok('notes read error shown, Add off', app.ev("!document.getElementById('notesMessage').hidden && document.getElementById('addNoteBtn').disabled"))
        config(failData={})
        app.ev("[...document.querySelectorAll('#notesMessage button')][0].click()"); time.sleep(0.6)
        ok('notes listed after Try again', app.ev("document.querySelectorAll('#notesList li').length") == 1)
        app.ev("document.getElementById('addNoteBtn').click()")
        app.ev("document.getElementById('noteTitle').value = 'Second'; document.getElementById('noteText').value = '  spaced  '")
        app.ev("document.querySelector('#noteDialog button.primary').click()")
        time.sleep(0.8)
        saved = json.loads(mock('/mock/data?name=notes.json', 'GET'))
        ok('note added, old note kept, text not trimmed', [n['title'] for n in saved] == ['Keep me', 'Second'] and saved[1]['content'] == '  spaced  ', saved)
        app.ev("document.getElementById('themeSelect').value = 'sepia'; document.getElementById('themeSelect').dispatchEvent(new Event('change'))")
        app.ev("document.getElementById('fontBiggerBtn').click()")
        time.sleep(1.2)
        s = json.loads(mock('/mock/data?name=settings.json', 'GET'))
        ok('settings saved at once', s['theme'] == 'sepia' and s['fontSize'] == 16, s)
        ok('theme applied', app.ev("document.body.className") == 'theme-sepia')
        app.ev("document.getElementById('backupBtn').click(); document.getElementById('exportBtn').click()")
        exported = json.loads(app.ev("document.getElementById('exportText').value"))
        ok('export holds notes and settings', len(exported['notes']) == 2 and exported['settings']['theme'] == 'sepia')
        app.ev("t => { document.getElementById('importText').value = t; document.getElementById('importBtn').click(); }",
               json.dumps({'settings': {'theme': 'dark'}, 'notes': [{'title': 'Only', 'content': 'one'}]}))
        time.sleep(0.3)
        ok('import asks first', app.ev("document.getElementById('confirmDialog').open"))
        app.ev("document.getElementById('confirmOk').click()"); time.sleep(1.2)
        saved = json.loads(mock('/mock/data?name=notes.json', 'GET'))
        ok('import replaced notes and settings', [n['title'] for n in saved] == ['Only'] and app.ev("document.body.className") == 'theme-dark', saved)
        ok('no script errors', not app.errors, app.errors)
        app.close()

        print('9. autosave', flush=True)
        reset(); put_file(doc, b'start\n')
        ctx3 = fresh_ctx(autosave=2)
        app = App(ctx3, doc)
        ok('autosave choice shown', app.ev("document.getElementById('autoSaveSelect').value") == '2')
        app.type_text('start\nauto\n')
        time.sleep(1.0)
        ok('not before the delay', server_file(doc) == b'start\n', server_file(doc))
        wait(lambda: server_file(doc) == b'start\nauto\n', 'autosave', 8)
        ok('saved by itself after the delay', True)
        app.wait_idle()
        ok('status saved and checked', app.status().startswith('Saved ✓'), app.status())
        seen = []
        for i in range(8):           # typing on for 3.2 s: autosave must not wait for a pause
            app.type_text('start\nauto\n' + 'x' * (i + 1) + '\n')
            time.sleep(0.4)
            seen.append(server_file(doc))
        ok('saves at least every max-wait while typing goes on', any(v not in (b'start\nauto\n', None) for v in seen), seen)
        wait(lambda: server_file(doc) == b'start\nauto\n' + b'x' * 8 + b'\n', 'last version', 8)
        ok('the last version is saved after typing stops', True)
        app.wait_idle()
        config(fail={'PUT': 400})
        app.type_text('refused at first\n')
        wait(lambda: any('Autosave failed' in b for b in app.banners()), 'autosave failure shown', 8)
        ok('a failed autosave is shown, with the retry time', any('tries again in 2 s' in b for b in app.banners()), app.banners())
        config(fail={})
        wait(lambda: server_file(doc) == b'refused at first\n', 'retry after the pause', 10)
        app.wait_idle()
        ok('autosave tries again by itself and clears the message', not app.banners() and app.status().startswith('Saved ✓'), (app.banners(), app.status()))
        app.ev("const s = document.getElementById('autoSaveSelect'); s.value = '0'; s.dispatchEvent(new Event('change'))")
        app.type_text('manual only\n'); time.sleep(3.5)
        ok('autosave Off: nothing saved by itself', server_file(doc) == b'refused at first\n' and app.status() == 'Unsaved changes', app.status())
        time.sleep(0.8)
        ok('the Off choice is saved in the settings', json.loads(mock('/mock/data?name=settings.json', 'GET'))['autoSave'] == 0)
        app.ev("const s = document.getElementById('autoSaveSelect'); s.value = '30'; s.dispatchEvent(new Event('change'))")
        app.ev("Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
        wait(lambda: server_file(doc) == b'manual only\n', 'save when hidden', 8)
        ok('switching away saves at once', True)
        ok('no script errors', not app.errors, app.errors)
        app.close()
        mock('/mock/reset')
        app = App(ctx3, None)
        app.ev("const s = document.getElementById('autoSaveSelect'); s.value = '2'; s.dispatchEvent(new Event('change'))")
        app.type_text('new text\n'); time.sleep(3.5)
        log = json.loads(mock('/mock/log', 'GET'))
        ok('a text without a file is never autosaved (no name dialog)', not any(p.startswith('/peergos-api/v0/save/') for _, p in log), log)
        app.close(); ctx3.close()

        browser.close()
    print('\n%s' % ('ALL PASSED' if not failures else '%d FAILED: %s' % (len(failures), ', '.join(failures))), flush=True)
    sys.exit(1 if failures else 0)


main()
