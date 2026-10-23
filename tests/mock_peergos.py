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
  {"hang": ["PUT"]}           never answer requests of these methods
  {"delay": {"PUT": 2.0}}     answer after this many seconds
  {"readBack": "garbage"}     GETs of a file answer different bytes than were written
  {"saveAs": 400}             the save dialog answers this status (as when it is cancelled)
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
            if hang:
                self.body()
                time.sleep(3600)
                return
            if delay:
                time.sleep(delay)
            if fail and not path.startswith('/peergos-api/v0/save/'):
                self.body()
                return self.send(fail)
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

    def data(self, name, method):
        with LOCK:
            if method == 'GET':
                return self.send(200, DATA[name], 'application/json') if name in DATA else self.send(404)
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
