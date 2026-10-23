#!/usr/bin/env python3
"""PeergosEasyEdit on a REAL local throw-away Peergos server (never a real account).

Works with 1.0.5 (to reproduce the old data loss) and 1.1.0+. Ground truth for every check is the file as
stored on the server, read with PG.java through the Peergos Java API - not through the app.

  python3 tests/peergos/real_server.py --zip <zip in /<user>/apps> --scenario S [--install]

Server, user, password and jar come from the environment or .env (see .env.example): PEERGOS_URL,
PEERGOS_TEST_USER, PEERGOS_TEST_PASSWORD, PEERGOS_JAR.

Scenarios: control (open, edit, save), autosave (no Save pressed, also after a worker stop), sw-stop (stop the sandbox service worker - what the browser does when
idle - then save), names (file names with + and &), stale (file changed elsewhere, read again), upgrade
(version, notes, settings after installing over an older version), pct (a name with % - Peergos cannot open it).
Setup: see tests/README.md.
"""
import argparse, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = tempfile.mkdtemp(prefix='pee-')
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import env  # noqa: E402
env.load()
ap = argparse.ArgumentParser()
ap.add_argument('--url', default=os.environ['PEERGOS_URL'])
ap.add_argument('--zip', required=True)
ap.add_argument('--scenario', required=True)
ap.add_argument('--install', action='store_true')
ap.add_argument('--display', default='PeergosEasyEdit')
ap.add_argument('--jar', default=os.environ['PEERGOS_JAR'])
ap.add_argument('--chromium', default=os.environ.get('CHROMIUM'))
A = ap.parse_args()
USER, PW, APP = os.environ['PEERGOS_TEST_USER'], os.environ['PEERGOS_TEST_PASSWORD'], 'peergoseasyedit'

VUE = """(window.__pgVue || (window.__pgVue = {
 root() { const a = document.querySelector('#app'); return a && a._vnode && a._vnode.component ? a._vnode.component.proxy : null; },
 children(c) { const out = []; const walk = v => { if (v == null || typeof v !== 'object') return;
   if (Array.isArray(v)) { v.forEach(walk); return; }
   if (v.component) { if (v.component.proxy) out.push(v.component.proxy); else walk(v.component.subTree); return; }
   if (v.suspense) { walk(v.suspense.activeBranch); return; } walk(v.children); }; walk(c.$.subTree); return out; },
 shown(c) { return c.$el != null && c.$el.nodeType === 1 && document.contains(c.$el); },
 find(method) { const q = []; const r = this.root(); if (r) q.push(r);
   while (q.length) { const c = q.shift(); if (typeof c[method] === 'function' && this.shown(c)) return c; q.push(...this.children(c)); } return null; }
}))"""


def wait(fn, what, timeout=120, every=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:
            last = e
        time.sleep(every)
    raise TimeoutError('timed out waiting for ' + what + ' (last: %r)' % (last,))


def server_text(path):
    out = os.path.join(WORK, 'cat.out')
    r = subprocess.run(['java', '-cp', A.jar, os.path.join(HERE, 'PG.java'), A.url, USER, 'cat', path, out],
                       capture_output=True, text=True, timeout=300)
    if 'MISSING' in r.stdout:
        return None
    if not r.stdout.startswith('cat '):
        raise RuntimeError(r.stdout + r.stderr)
    return open(out, 'rb').read().decode('utf-8', 'replace')


def login(page):
    page.goto(A.url + '/')
    wait(lambda: page.evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Sign in' && !b.disabled)"), 'sign in button', 300)
    page.evaluate("""([u, p]) => { const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        s.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true})); };
        set(document.querySelector('input[name=username]'), u); set(document.querySelector('input[name=password]'), p);
        [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign in').click(); }""", [USER, PW])
    wait(lambda: page.evaluate("/upgrade/i.test(document.body.innerText)"), 'sign in to complete', 300)


def drive(page):
    for _ in range(5):
        if page.evaluate("() => { const c = " + VUE + ".find('downloadFile'); if (c) { window.__drive = c; return true; } return false; }"):
            break
        page.evaluate("() => { const b = [...document.querySelectorAll('button, a')].find(x => x.textContent.trim() === 'Drive'); if (b) b.click(); }")
        time.sleep(2)
    wait(lambda: page.evaluate("window.__drive && window.__drive.currentDir && !window.__drive.showSpinner"), 'drive listing', 180)


def install(page):
    drive(page)
    page.evaluate("p => window.__drive.changePath(p)", '/%s/apps/%s' % (USER, A.zip))
    wait(lambda: page.evaluate("!window.__drive.showSpinner && window.__drive.files.some(f => f.getName() === 'peergos-app.json')"), 'app listing', 180)

    def open_menu():
        page.evaluate("""() => { window.__drive.closeMenu && window.__drive.closeMenu();
            const card = [...document.querySelectorAll('.grid-card, .drive-table tbody tr')].find(c => c.textContent.includes('peergos-app.json'));
            card.querySelector('[aria-label=menu]').click(); }""")
        time.sleep(1.5)
        return page.evaluate("(() => { const e = document.querySelector('#app-install'); return !!e && e.getClientRects().length > 0; })()")
    wait(open_menu, 'Install in the menu', 60, 0.1)
    page.evaluate("document.querySelector('#app-install').click()")
    dialog = "[...document.querySelectorAll('.app-install-container, .pg-dialog')].find(x => x.textContent.includes('App Installation'))"
    wait(lambda: page.evaluate("(() => { const x = " + dialog + "; return !!x && x.textContent.includes(%r); })()" % A.display), 'install dialog', 60)
    page.evaluate("[...(" + dialog + ").querySelectorAll('button')].find(b => b.textContent.trim() === 'Install').click()")

    def finished():
        page.evaluate("() => { const c = " + VUE + ".find('confirmReplaceAppInstall'); if (c && c.showConfirm) c.confirm_consumer_func(); }")
        return page.evaluate("!(" + dialog + ")")
    wait(finished, 'install to finish', 180)
    print('installed', A.zip, flush=True)


def app_frame(page):
    outer = page.query_selector('#sandboxId')
    fo = outer and outer.content_frame()
    inner = fo and fo.query_selector('#appSandboxId')
    fi = inner and inner.content_frame()
    return fi if fi and '/index.html' in fi.url else None


def open_file(page, folder, name):
    drive(page)
    page.evaluate("p => window.__drive.changePath(p)", folder)
    wait(lambda: page.evaluate("n => !window.__drive.showSpinner && window.__drive.files.some(f => f.getName() === n)", name), 'file ' + name, 120)
    page.evaluate("([n, a]) => window.__drive.openInApp({filename: n}, a)", [name, APP])
    f = wait(lambda: (lambda fr: fr if fr and fr.evaluate("!!(document.getElementById('editorText')||document.getElementById('editor'))") else None)(app_frame(page)), 'the app to start', 120)
    time.sleep(3)  # let the app's own load finish
    return f


def close_app(page):
    page.evaluate("() => { const c = " + VUE + ".find('closeSandbox'); if (c) c.closeSandbox(); }")
    wait(lambda: page.evaluate("!document.querySelector('#sandboxId')"), 'app to close', 60)


def editor_state(f):
    return f.evaluate("({text: (document.getElementById('editorText')||document.getElementById('editor')).value, status: (document.getElementById('statusMsg')||document.getElementById('status')||{}).textContent || '', url: location.href, banners: [...document.querySelectorAll('.banner p')].map(b => b.textContent)})")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=A.chromium)
        ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = ctx.new_page()
        log = []
        ctx.on('response', lambda r: log.append('%s %s %s' % (r.request.method, r.status, r.url.split('?')[0][-70:])) if 'localhost' in r.url and ('docs' in r.url or 'peergos-api' in r.url) else None)
        ctx.on('request', lambda r: log.append('-> %s %s' % (r.method, r.url.split('?')[0][-70:])) if 'localhost' in r.url and r.method != 'GET' else None)
        ctx.on('requestfailed', lambda r: log.append('FAILED %s %s %s' % (r.method, r.url[-90:], r.failure)))
        ctx.on('response', lambda r: log.append('%s %s %s' % (r.request.method, r.status, r.url[-90:])) if 'index.html' in r.url else None)
        page.on('console', lambda m: log.append('console.%s: %s' % (m.type, m.text[:200])) if m.type in ('warning', 'error') else None)
        login(page)
        if A.install:
            install(page)
        cdp = ctx.new_cdp_session(page)
        cdp.send('ServiceWorker.enable')

        if A.scenario in ('control', 'sw-stop'):
            path = '/%s/docs/notes.txt' % USER
            before = server_text(path)
            f = open_file(page, '/%s/docs' % USER, 'notes.txt')
            st = editor_state(f)
            print('loaded in editor: %r' % st['text'], flush=True)
            new_text = st['text'] + 'Edit at %s\n' % time.strftime('%H:%M:%S')
            f.evaluate("t => { const e = (document.getElementById('editorText')||document.getElementById('editor')); e.value = t; e.dispatchEvent(new Event('input', {bubbles: true})); }", new_text)
            if A.scenario == 'sw-stop':
                cdp.send('ServiceWorker.stopAllWorkers')
                print('stopped all service workers (what the browser does after inactivity)', flush=True)
                time.sleep(2)
            del log[:]
            f.evaluate("(document.getElementById('saveFileBtn')||document.getElementById('saveBtn')).click()")
            time.sleep(8)
            st2 = editor_state(f)
            print('after Save: status=%r, editor still has the edit: %s, banners=%r' % (st2['status'], new_text in st2['text'], st2.get('banners')), flush=True)
            print('  requests/console during save:', *log, sep='\n    ', flush=True)
            after = server_text(path)
            print('server before: %r' % before)
            print('server after : %r' % after)
            print('RESULT: %s' % ('SAVED' if after == new_text else 'NOT SAVED (edit lost unless saved again)'), flush=True)
            close_app(page)

        if A.scenario == 'stale':
            path = '/%s/docs/notes.txt' % USER
            f = open_file(page, '/%s/docs' % USER, 'notes.txt')
            for label, content in [('grown', 'X' * 50 + '\nmore lines written elsewhere\n' * 5), ('shrunk', 'short\n')]:
                open(os.path.join(WORK, 'ext.txt'), 'w').write(content)
                subprocess.run(['java', '-cp', A.jar, os.path.join(HERE, 'PG.java'), A.url, USER, 'put', '/%s/docs' % USER, 'notes.txt', os.path.join(WORK, 'ext.txt')], capture_output=True, timeout=300)
                for i in range(3):
                    got = f.evaluate("p => fetch(p).then(async r => ({status: r.status, len: r.headers.get('content-length'), text: await r.text()}))", path)
                    print('%s on server (%d bytes); app read #%d: status %s, %s bytes, complete=%s, text=%r' % (label, len(content), i + 1, got['status'], got['len'], got['text'] == content, got['text'][:60]), flush=True)
                    time.sleep(3)
            close_app(page)

        if A.scenario == 'autosave':   # 1.1.0+, default autosave (5 s); Save is never pressed
            path = '/%s/docs/notes.txt' % USER
            f = open_file(page, '/%s/docs' % USER, 'notes.txt')
            print('autosave choice:', f.evaluate("document.getElementById('autoSaveSelect').value"), flush=True)
            for label, stop in [('plain', False), ('after the service worker was stopped', True)]:
                text = editor_state(f)['text'] + 'auto %s %s\n' % (label, time.strftime('%H:%M:%S'))
                if stop:
                    cdp.send('ServiceWorker.stopAllWorkers')
                    time.sleep(2)
                del log[:]
                f.evaluate("t => { const e = document.getElementById('editor'); e.value = t; e.dispatchEvent(new Event('input', {bubbles: true})); }", text)
                time.sleep(12)
                st = editor_state(f)
                after = server_text(path)
                print('[%s] status=%r banners=%r' % (label, st['status'], st['banners']), flush=True)
                print('  requests:', *[l for l in log if 'docs' in l and ('PUT' in l or 'GET' in l) and 'FAILED' not in l], sep='\n    ')
                print('  RESULT: %s' % ('SAVED BY AUTOSAVE' if after == text else 'NOT SAVED: %r' % after), flush=True)
            close_app(page)

        if A.scenario == 'upgrade':
            f = open_file(page, '/%s/docs' % USER, 'notes.txt')
            info = f.evaluate("""() => ({version: VERSION, theme: document.body.className, wrap: document.getElementById('editor').classList.contains('wrap'),
                notes: [...document.querySelectorAll('#notesList .note-title')].map(e => e.textContent), notesError: !document.getElementById('notesMessage').hidden,
                isolated: window.crossOriginIsolated, banners: [...document.querySelectorAll('.banner p')].map(b => b.textContent)})""")
            print('app after upgrade:', info)
            close_app(page)

        if A.scenario == 'pct':
            sw_log = []
            def on_sw(w):
                sw_log.append('service worker: ' + w.url)
            ctx.on('serviceworker', on_sw)
            del log[:]
            drive(page)
            page.evaluate("p => window.__drive.changePath(p)", '/%s/docs' % USER)
            wait(lambda: page.evaluate("n => !window.__drive.showSpinner && window.__drive.files.some(f => f.getName() === n)", '100% done.txt'), 'file', 120)
            page.evaluate("([n, a]) => window.__drive.openInApp({filename: n}, a)", ['100% done.txt', APP])
            time.sleep(20)
            outer = page.query_selector('#sandboxId'); fo = outer and outer.content_frame()
            inner = fo and fo.query_selector('#appSandboxId')
            print('app iframe src:', inner and inner.get_attribute('src'))
            fi = inner and inner.content_frame()
            print('app frame url:', fi and fi.url)
            print('app frame has the editor:', bool(fi and fi.evaluate("!!document.getElementById('editorText')")))
            print('in Node/V8: decodeURI of the path param ->', subprocess.run(['node', '-e', 'try { decodeURI("/user/docs/100% done.txt"); console.log("ok") } catch (e) { console.log(e.name + ": " + e.message) }'], capture_output=True, text=True).stdout.strip())
            print('requests/console:', *[l for l in log if 'done' in l or 'index.html' in l or 'FAILED' in l][:10], sep='\n    ')
            print('chromium', browser.version)

        if A.scenario == 'names':
            for name in ['C++ notes.txt', 'a&b.txt']:
                path = '/%s/docs/%s' % (USER, name)
                f = open_file(page, '/%s/docs' % USER, name)
                st = editor_state(f)
                q = st['url'].split('?', 1)[1].split('&theme=')[0]
                print('\n[%s] app got %s ; editor shows %r ; banners=%r' % (name, q, st['text'], st.get('banners')), flush=True)
                new_text = 'Changed %s\n' % time.strftime('%H:%M:%S')
                f.evaluate("t => { const e = (document.getElementById('editorText')||document.getElementById('editor')); e.value = t; e.dispatchEvent(new Event('input', {bubbles: true})); }", new_text)
                del log[:]
                f.evaluate("(document.getElementById('saveFileBtn')||document.getElementById('saveBtn')).click()")
                time.sleep(30)
                print('  status line after 30 s: %r' % editor_state(f)['status'], flush=True)
                print('  requests/console during save:', *log, sep='\n    ', flush=True)
                after = server_text(path)
                print('  server file now: %r -> %s' % (after, 'SAVED' if after == new_text else 'NOT SAVED'), flush=True)
                close_app(page)
        browser.close()


main()
