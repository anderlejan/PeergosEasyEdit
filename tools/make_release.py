#!/usr/bin/env python3
"""Builds the installable Peergos app of the current version.

  python3 tools/make_release.py           release: needs a clean git tree; writes to RELEASE_OUT (default Releases/):
                                          PeergosEasyEdit-v<ver>.zip          (upload this to Peergos and Install it)
                                          PeergosEasyEdit <ver>/              (the same files unpacked, for Peergos 1.38)
                                          PeergosEasyEdit-Source-v<ver>.zip   (git archive of the same commit)
                                          SHA256SUMS-<ver>.txt
                                          and tags the commit v<ver>
  python3 tools/make_release.py --dev     test build to RELEASE_OUT/dev/ (replaced each time)
  options: --out DIR, --skip-tests

The app = peergos-app.json + assets/. It ships NO data/ folder: Peergos copies data/ into the app's private folder
on install, and an EMPTY data/ folder in an unpacked app makes the installation hang (Peergos web-ui
AppInstall.gatherDataFilesRecursively calls `this.` inside a plain function callback when a folder has no files),
so the build refuses empty folders. The app creates its notes and settings files itself.
A released version is never overwritten: the script refuses when its files exist. Fix → bump the version.
A release takes the app files from the commit, not from the disk, and refuses when the disk differs (a Windows checkout
can hold CRLF line endings that `git status` does not show), so the ZIP is reproducible from the tag.
"""
import hashlib, json, os, re, shutil, subprocess, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env  # noqa: E402

ROOT = env.ROOT
ARGS = sys.argv[1:]
DEV = '--dev' in ARGS
env.load()
OUT = os.path.abspath(ARGS[ARGS.index('--out') + 1]) if '--out' in ARGS else os.path.join(ROOT, os.environ['RELEASE_OUT'])
FIXED_TIME = (2026, 1, 1, 0, 0, 0)
NAME = 'PeergosEasyEdit'


def die(msg):
    print('REFUSED: ' + msg)
    sys.exit(1)


def git(*a):
    return subprocess.run(['git', '-C', ROOT] + list(a), capture_output=True, text=True, check=True).stdout


def check_manifest():
    with open(os.path.join(ROOT, 'peergos-app.json'), encoding='utf-8') as f:
        m = json.load(f)
    for k in ('displayName', 'description', 'launchable'):
        if k not in m:
            die('manifest: missing ' + k)
    if str(m.get('schemaVersion', '1')) != '1':
        die('manifest: schemaVersion must be 1')
    if len(m['displayName']) > 25 or not re.fullmatch(r'[A-Za-z0-9 _-]+', m['displayName']):
        die('manifest: displayName must be ≤ 25 chars of letters, digits, space, - and _')
    if m['displayName'] != NAME:
        die('manifest: displayName must stay "%s" (its lower-case form is the app identity: folder and data)' % NAME)
    if len(m['description']) > 100:
        die('manifest: description longer than 100 characters')
    if len(m.get('author', '')) > 32:
        die('manifest: author longer than 32 characters')
    if not re.fullmatch(r'\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?', m.get('version', '')):
        die('manifest: version must be major.minor.patch[-suffix]')
    if 'source' in m:
        die('manifest: leave "source" out – Peergos fills it in on install')
    icon = os.path.join(ROOT, 'assets', m.get('appIcon', ''))
    if not os.path.isfile(icon) or open(icon, 'rb').read(8) != b'\x89PNG\r\n\x1a\n':
        die('manifest: appIcon must be a PNG in assets/')
    return m


def check_version(ver):
    js = open(os.path.join(ROOT, 'assets', 'js', 'version.js'), encoding='utf-8').read()
    found = re.search(r"VERSION = '([^']+)'", js)
    if not found or found.group(1) != ver:
        die('assets/js/version.js (%s) does not match peergos-app.json (%s)' % (found and found.group(1), ver))
    log = open(os.path.join(ROOT, 'CHANGELOG.md'), encoding='utf-8').read()
    if not re.search(r'^## \[?%s\]?' % re.escape(ver), log, re.M):
        die('CHANGELOG.md has no section for ' + ver)


def check_tree():
    """Self-contained (the sandbox blocks external requests), no empty folders, no data/ folder."""
    if os.path.exists(os.path.join(ROOT, 'data')):
        die('a data/ folder must not ship with the app (see the docstring)')
    bad, empty = [], []
    for base, dirs, files in os.walk(os.path.join(ROOT, 'assets')):
        if not dirs and not files:
            empty.append(os.path.relpath(base, ROOT))
        for fn in files:
            if not fn.endswith(('.js', '.css', '.html')):
                continue
            p = os.path.join(base, fn)
            text = open(p, encoding='utf-8').read()
            if re.search(r'(?:src|href|url)\s*[=(]\s*["\']?(https?:)?//', text) or re.search(r"fetch\(\s*['\"`]https?://", text):
                bad.append(os.path.relpath(p, ROOT))
    if empty:
        die('empty folders (they make Peergos installs hang): ' + ', '.join(empty))
    if bad:
        die('external references in: ' + ', '.join(sorted(set(bad))))
    html = open(os.path.join(ROOT, 'assets', 'index.html'), encoding='utf-8').read()
    for src in re.findall(r'<script src="([^"]+)"', html) + re.findall(r'<link rel="stylesheet" href="([^"]+)"', html):
        if not os.path.isfile(os.path.join(ROOT, 'assets', src)):
            die('index.html loads a missing file: ' + src)


def run_tests():
    r = subprocess.run(['node', os.path.join(ROOT, 'tests', 'unit.test.js')], capture_output=True, text=True)
    print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr)
    if r.returncode != 0:
        die('unit tests failed:\n' + r.stdout[-3000:])
    for base, _, files in os.walk(os.path.join(ROOT, 'assets')):
        for f in files:
            if f.endswith('.js'):
                r = subprocess.run(['node', '--check', os.path.join(base, f)], capture_output=True, text=True)
                if r.returncode != 0:
                    die('syntax error in ' + f + ':\n' + r.stderr)


def app_files():
    files = ['peergos-app.json']
    for base, dirs, fs in os.walk(os.path.join(ROOT, 'assets')):
        dirs.sort()
        for fn in sorted(fs):
            files.append(os.path.relpath(os.path.join(base, fn), ROOT).replace(os.sep, '/'))
    return files


def read_disk(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return f.read()


def read_commit(commit):
    """Reader for the bytes git stores in `commit` – what the source ZIP and the tag contain."""
    def read(rel):
        return subprocess.run(['git', '-C', ROOT, 'cat-file', 'blob', '%s:%s' % (commit, rel)],
                              capture_output=True, check=True).stdout
    return read


def check_disk_matches(files, read):
    """A release is built from the commit. Files on disk that differ from it (e.g. CRLF line endings in a Windows
    checkout, which `* text=auto eol=lf` hides from `git status`) mean the checks above did not see what ships."""
    eol, other = [], []
    for rel in files:
        disk, committed = read_disk(rel), read(rel)
        if disk != committed:
            (eol if disk.replace(b'\r\n', b'\n') == committed else other).append(rel)
    msg = []
    if eol:
        msg.append('only line endings differ (CRLF on disk) in: %s\n  fix each with `git rm --cached <file>` and then '
                   '`git checkout HEAD -- <file>` (rewrites it from the commit with LF)' % ', '.join(eol))
    if other:
        msg.append('content differs from the commit in: %s – commit or undo these changes first' % ', '.join(other))
    if msg:
        die('files on disk differ from the commit HEAD:\n  ' + '\n  '.join(msg))


def build_zip(path, files, read=read_disk):
    with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:  # files only – no directory entries, so no empty folder can appear
            info = zipfile.ZipInfo(rel, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 3  # Unix, as the mode above; Python's default differs on Windows (0) and Linux (3)
            z.writestr(info, read(rel))
    with zipfile.ZipFile(path) as z:
        if z.testzip() is not None or sorted(z.namelist()) != sorted(files) or \
                any(z.read(rel) != read(rel) for rel in files):
            os.remove(path)
            die('the ZIP did not verify')


def build_folder(path, files, read=read_disk):
    for rel in files:
        dst = os.path.join(path, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(read(rel))


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    m = check_manifest()
    ver = m['version']
    check_version(ver)
    check_tree()
    if '--skip-tests' not in ARGS:
        run_tests()
    files = app_files()
    if DEV:
        d = os.path.join(OUT, 'dev')
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, '%s-v%s-dev.zip' % (NAME, ver))
        folder = os.path.join(d, '%s %s-dev' % (NAME, ver))
        if os.path.exists(path):
            os.remove(path)
        shutil.rmtree(folder, ignore_errors=True)
        build_zip(path, files)
        build_folder(folder, files)
        print('dev build: %s (%d files, %d bytes) and %s' % (path, len(files), os.path.getsize(path), folder))
        return
    commit = git('rev-parse', 'HEAD').strip()
    committed = set(git('ls-tree', '-r', '--name-only', commit).split('\n'))
    untracked = [f for f in files if f not in committed]
    if untracked:
        die('files in the app that are not committed: ' + ', '.join(untracked))
    read = read_commit(commit)
    check_disk_matches(files, read)
    if git('status', '--porcelain').strip():
        die('uncommitted changes – commit first (a release is built from a commit)')
    tag = 'v' + ver
    if tag in git('tag', '--list', tag).split():
        die('tag %s exists already – bump the version' % tag)
    os.makedirs(OUT, exist_ok=True)
    app_zip = os.path.join(OUT, '%s-%s.zip' % (NAME, tag))
    src_zip = os.path.join(OUT, '%s-Source-%s.zip' % (NAME, tag))
    folder = os.path.join(OUT, '%s %s' % (NAME, ver))
    sums = os.path.join(OUT, 'SHA256SUMS-%s.txt' % ver)
    for p in (app_zip, src_zip, folder, sums):
        if os.path.exists(p):
            die(os.path.basename(p) + ' exists already – released versions are never overwritten; bump the version')
    build_zip(app_zip, files, read)
    build_folder(folder, files, read)
    subprocess.run(['git', '-C', ROOT, 'archive', '--format=zip', '--prefix=%s-%s/' % (NAME, ver), '-o', src_zip, commit], check=True)
    with zipfile.ZipFile(src_zip) as z:
        listed = sorted(n[len('%s-%s/' % (NAME, ver)):] for n in z.namelist() if not n.endswith('/'))
    if listed != sorted(f for f in git('ls-tree', '-r', '--name-only', commit).split('\n') if f):
        os.remove(app_zip); os.remove(src_zip)
        die('the source ZIP does not list the same files as the commit')
    with open(sums, 'w', encoding='utf-8', newline='\n') as f:
        for p in (app_zip, src_zip):
            f.write('%s  %s\n' % (sha256(p), os.path.basename(p)))
    subprocess.run(['git', '-C', ROOT, 'tag', '-a', tag, '-m', '%s %s' % (NAME, ver), commit], check=True,
                   env=dict(os.environ, GIT_COMMITTER_DATE=git('log', '-1', '--format=%cI', commit).strip()))
    print('released %s from %s\n  %s (%d bytes)\n  %s (%d bytes)\n  %s\n  %s' % (
        ver, commit[:10], app_zip, os.path.getsize(app_zip), src_zip, os.path.getsize(src_zip), folder, sums))


if __name__ == '__main__':
    main()
