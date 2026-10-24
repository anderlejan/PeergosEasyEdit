#!/usr/bin/env python3
"""A stand-in for the part of Peergos that PeergosEasyEdit talks to, with faults on demand.

  python3 tests/mock_peergos.py [port]

Serves assets/ at the root (as the Peergos sandbox serves an app), the user's files at their
absolute paths (/alice/docs/notes.txt), the data API (/peergos-api/v0/data/<name>) and the
save dialog (/peergos-api/v0/save/<name>, saved into /alice/docs/).

Faults (POST /mock/config with JSON, every key optional):
  {"503": n}                  the next n requests answer 503, as after a service worker restart
  {"fail": {"PUT": 400}}      answer this status to every request of that method (file and data)
  {"failData": {"GET": 500}}  the same for the data API only
  {"failFile": {"PUT": 400}}  the same for files only (not the data API)
  {"hang": ["PUT"]}           never answer requests of these methods
  {"delay": {"PUT": 2.0}}     answer after this many seconds
  {"readBack": "garbage"}     GETs of a file answer different bytes than were written
  {"saveAs": 400}             the save dialog answers this status (as when it is cancelled)
  {"pickFolders": ["/alice/docs"]}  what the user grants in the next folder picker ([] = cancel)
  {"pickFile": "/alice/x.txt"}      what the user picks in the next file picker ("" = cancel)
  {"noGrants": true}          behave like a Peergos without granted folders (404 for /grants/)
Granted folders (/peergos-api/v0/folder/<id>/<path>) map onto FILES under the grant's path, as in Peergos 1.40:
GET of a folder lists it ({files:[{name,modified,size}], subFolders:[{name}]} with ?details=true), PUT creates
folders on the way, POST ?type=directory makes a folder, 403 without write, 404 for a missing file or stale grant.
POST /mock/reset clears faults; PUT /mock/file?path=... sets a file's bytes; GET /mock/file?path=...
returns them; GET /mock/log lists the requests seen.
"""
import json, os, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs, unquote

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
LOCK = threading.Lock()
FILES = {}       # absolute path -> bytes
DATA = {}        # data file name -> bytes
GRANTS = {}      # grant id -> {grantId, path, write, persist, stale}
FOLDERS = set()  # empty folders made through a grant
import itertools
NEXT_ID = itertools.count(1)
FAULTS = {}
LOG = []
TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, status, body=b'', ctype='application/octet-stream', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def handle_any(self):
        url = urlsplit(self.path)   # not urlparse: it would cut the path at ';'
        # the Peergos service worker decodes the path with decodeURI
        path = unquote(url.path)
        method = self.command
        if path.startswith('/mock/'):
            return self.mock(path, method, url)
        api = path.startswith('/peergos-api/')
        is_file = not api and not os.path.isfile(os.path.join(ROOT, path.lstrip('/')))
        if api or is_file:
            with LOCK:
                LOG.append([method, path])
                if FAULTS.get('503', 0) > 0:
                    FAULTS['503'] -= 1
                    self.body()
                    return self.send(503)
                hang = method in FAULTS.get('hang', [])
                delay = FAULTS.get('delay', {}).get(method, 0)
                fail = FAULTS.get('fail', {}).get(method)
                fail_data = FAULTS.get('failData', {}).get(method)
                if not path.startswith('/peergos-api/v0/data/'):
                    fail = fail or FAULTS.get('failFile', {}).get(method)
            if hang:
                self.body()
                time.sleep(3600)
                return
            if delay:
                time.sleep(delay)
            if fail and not path.startswith('/peergos-api/v0/save/'):
                self.body()
                return self.send(fail)
            if path.startswith('/peergos-api/v0/grants/'):
                return self.grants(path[len('/peergos-api/v0/grants/'):], method)
            if path.startswith('/peergos-api/v0/folders/'):
                return self.folders(parse_qs(url.query))
            if path.startswith('/peergos-api/v0/file-picker/'):
                with LOCK:
                    picked = FAULTS.pop('pickFile', '')
                return self.send(200, json.dumps([picked, True] if picked else ['', False]).encode(), 'application/json')
            if path.startswith('/peergos-api/v0/folder/'):
                return self.granted(path[len('/peergos-api/v0/folder/'):], method, parse_qs(url.query))
            if path.startswith('/peergos-api/v0/data/'):
                if fail_data:
                    self.body()
                    return self.send(fail_data)
                return self.data(path[len('/peergos-api/v0/data/'):], method)
            if path.startswith('/peergos-api/v0/save/'):
                data = self.body()
                status = FAULTS.get('saveAs')
                if status:
                    return self.send(status)
                with LOCK:
                    FILES['/alice/docs/' + path[len('/peergos-api/v0/save/'):]] = data
                return self.send(200)
            return self.file(path, method)
        if method != 'GET':
            return self.send(405)
        p = os.path.join(ROOT, path.lstrip('/') or 'index.html')
        with open(p, 'rb') as f:
            body = f.read()
        return self.send(200, body, TYPES.get(os.path.splitext(p)[1], 'application/octet-stream'))

    def file(self, path, method):
        with LOCK:
            if method == 'GET':
                if path not in FILES:
                    return self.send(404)
                data = FILES[path]
                if FAULTS.get('readBack') == 'garbage':
                    data = data + b'?'
                return self.send(200, data, 'text/plain', {'ETag': '"%d"' % hash(data)})
            if method == 'PUT':
                if path not in FILES:   # Peergos only overwrites the chosen file
                    return self.send(400)
                FILES[path] = self.body()
                return self.send(200)
        return self.send(400)

    def grants(self, rest, method):
        with LOCK:
            if FAULTS.get('noGrants'):
                return self.send(404)
            if method == 'GET' and not rest:
                out = [{k: v for k, v in g.items() if not (k == 'path' and g['stale'])} for g in GRANTS.values()]
                return self.send(200, json.dumps(out).encode(), 'application/json')
            if method == 'DELETE' and rest in GRANTS:
                del GRANTS[rest]
                return self.send(204)
        return self.send(400)

    def folders(self, q):
        with LOCK:
            if FAULTS.get('noGrants'):
                return self.send(404)
            paths = FAULTS.pop('pickFolders', [])
            write = q.get('write', ['false'])[0] == 'true'
            persist = q.get('persist', ['false'])[0] == 'true'
            added = []
            for p in paths:
                if p.count('/') < 2:          # the home folder itself is refused, as in Peergos 1.40
                    continue
                gid = 'g%d' % next(NEXT_ID)
                GRANTS[gid] = {'grantId': gid, 'path': p, 'write': write, 'persist': persist, 'granted': int(time.time() * 1000), 'stale': False}
                added.append(dict(GRANTS[gid]))
        return self.send(200, json.dumps(added).encode(), 'application/json')

    def granted(self, rest, method, q):
        gid, _, rel = rest.partition('/')
        rel = rel.strip('/')
        body = self.body() if method in ('PUT', 'POST') else b''
        with LOCK:
            g = GRANTS.get(gid)
            if not g:
                return self.send(400)
            if g['stale']:
                return self.send(404)
            if method != 'GET' and not g['write']:
                return self.send(403)
            full = g['path'] + ('/' + rel if rel else '')
            if method == 'GET':
                if full in FILES:
                    data = FILES[full]
                    if FAULTS.get('readBack') == 'garbage':
                        data = data + b'?'
                    return self.send(200, data, 'text/plain', {'ETag': '"%d"' % hash(data)})
                prefix = full + '/'
                kids = [k[len(prefix):] for k in list(FILES) + list(FOLDERS) if k.startswith(prefix)]
                if not kids and full not in FOLDERS and full != g['path']:
                    return self.send(404)
                files = sorted({k for k in kids if '/' not in k and prefix + k in FILES})
                subs = sorted({k.split('/')[0] for k in kids if '/' in k or prefix + k in FOLDERS})
                details = q.get('details', ['false'])[0] == 'true'
                listing = {'files': [{'name': f, 'modified': '2026-10-23T12:00:00.000Z', 'size': len(FILES[prefix + f])} if details else f for f in files],
                           'subFolders': [{'name': d, 'modified': '2026-10-23T12:00:00.000Z'} if details else d for d in subs]}
                return self.send(200, json.dumps(listing).encode(), 'text/plain')
            if method == 'PUT':
                created = full not in FILES
                FILES[full] = body
                return self.send(201 if created else 200)
            if method == 'POST' and q.get('type', [''])[0] == 'directory':
                FOLDERS.add(full)
                return self.send(201)
            if method == 'POST' and q.get('action', [''])[0] == 'rename':   # the new name is the body
                name = body.decode('utf-8')
                target = full.rsplit('/', 1)[0] + '/' + name
                # Peergos 1.40 answers 400 for a missing file and for a name that is taken, and changes nothing
                if full not in FILES or '/' in name or target in FILES or target in FOLDERS:
                    return self.send(400)
                FILES[target] = FILES.pop(full)
                return self.send(201)
            if method == 'DELETE':
                FILES.pop(full, None)
                return self.send(204)
        return self.send(400)

    def data(self, name, method):
        with LOCK:
            if method == 'GET':
                if name in DATA:
                    return self.send(200, DATA[name], 'application/json')
                kids = sorted(k[len(name) + 1:] for k in DATA if k.startswith(name + '/') and '/' not in k[len(name) + 1:])
                if kids:
                    return self.send(200, json.dumps({'files': kids, 'subFolders': []}).encode(), 'text/plain')
                return self.send(404)
            if method == 'DELETE':
                DATA.pop(name, None)
                return self.send(204)
            if method == 'PUT':
                created = name not in DATA
                DATA[name] = self.body()
                return self.send(201 if created else 200)
        return self.send(400)

    def mock(self, path, method, url):
        q = parse_qs(url.query)
        with LOCK:
            if path == '/mock/config':
                FAULTS.update(json.loads(self.body() or b'{}'))
                return self.send(200)
            if path == '/mock/reset':
                FAULTS.clear()
                FILES.clear()
                DATA.clear()
                GRANTS.clear()
                FOLDERS.clear()
                LOG.clear()
                return self.send(200)
            if path == '/mock/file':
                p = q['path'][0]
                if method == 'PUT':
                    FILES[p] = self.body()
                    return self.send(200)
                return self.send(200, FILES[p]) if p in FILES else self.send(404)
            if path == '/mock/data':
                n = q['name'][0]
                if method == 'PUT':
                    DATA[n] = self.body()
                    return self.send(200)
                return self.send(200, DATA[n]) if n in DATA else self.send(404)
            if path == '/mock/grant':        # a grant the user gave earlier: {"path", "write", "stale"}
                spec = json.loads(self.body() or b'{}')
                gid = 'g%d' % next(NEXT_ID)
                GRANTS[gid] = {'grantId': gid, 'path': spec['path'], 'write': spec.get('write', True), 'persist': True,
                               'granted': int(time.time() * 1000), 'stale': spec.get('stale', False)}
                return self.send(200, gid.encode())
            if path == '/mock/stale':
                GRANTS[q['id'][0]]['stale'] = True
                return self.send(200)
            if path == '/mock/datalist':
                return self.send(200, json.dumps(sorted(DATA)).encode(), 'application/json')
            if path == '/mock/log':
                return self.send(200, json.dumps(LOG).encode(), 'application/json')
        return self.send(404)

    do_GET = do_PUT = do_POST = do_DELETE = do_HEAD = do_PATCH = handle_any


def serve(port):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == '__main__':
    serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8790)
    print('mock Peergos on http://127.0.0.1:%s' % (sys.argv[1] if len(sys.argv) > 1 else 8790), flush=True)
    threading.Event().wait()
