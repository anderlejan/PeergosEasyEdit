#!/usr/bin/env python3
"""Checks (and if missing, fetches) the third-party files in assets/vendor against tools/vendor.json.

  python3 tools/fetch_vendor.py           check every file's SHA-256; download the missing ones
  python3 tools/fetch_vendor.py --check   check only, download nothing

A file that is there with other bytes is never replaced: the check fails and names it.
"""
import hashlib, json, os, sys, tempfile, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, 'assets', 'vendor')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    check_only = '--check' in sys.argv[1:]
    with open(os.path.join(ROOT, 'tools', 'vendor.json'), encoding='utf-8') as f:
        files = json.load(f)['files']
    bad = []
    for e in files:
        path = os.path.join(VENDOR, e['path'])
        if os.path.exists(path):
            with open(path, 'rb') as f:
                if sha256(f.read()) != e['sha256']:
                    bad.append(e['path'] + ': other bytes than pinned')
            continue
        if check_only:
            bad.append(e['path'] + ': missing')
            continue
        req = urllib.request.Request(e['url'], headers={'User-Agent': 'fetch_vendor'})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        if sha256(data) != e['sha256']:
            bad.append(e['path'] + ': download from ' + e['url'] + ' has other bytes than pinned')
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
        print('fetched ' + e['path'])
    listed = {e['path'] for e in files}
    for base, _, names in os.walk(VENDOR):
        for n in names:
            rel = os.path.relpath(os.path.join(base, n), VENDOR).replace(os.sep, '/')
            if rel not in listed and rel != 'README.txt':
                bad.append(rel + ': not in tools/vendor.json')
    if bad:
        print('vendor check FAILED:\n  ' + '\n  '.join(bad))
        sys.exit(1)
    print('vendor files: %d, all as pinned' % len(files))


if __name__ == '__main__':
    main()
