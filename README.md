# PeergosEasyEdit

A simple text editor as a [Peergos](https://peergos.org) custom app, for the text files in your Peergos drive.

- **Saving you can trust:** "Saved ✓" appears only after Peergos accepted the file and reading it back gave
  exactly the bytes that were sent. Every failure stays on screen with **Try again** and **Save as…**.
- **Autosave** after 2, 5 (default), 10 or 30 seconds without typing, or off; at least every 30 seconds while you
  keep typing, and when you switch to another window.
- **Nothing lost when something fails:** while text is not saved, a copy is kept in this browser and offered back
  when the file is opened again. A file that could not be read is never shown empty and cannot be saved over.
- UTF-8 text; Windows line endings and the byte order mark are kept; files in other encodings open read-only.
- **Save as…**, Ctrl+S, an "Unsaved changes" mark. Started from the launcher without a file, it saves through
  Peergos' save dialog.
- Themes (light, dark, green on black, sepia), text size, font, line wrapping – applied and saved at once.
- Notes about anything, kept in the app's private folder in Peergos, with export and import.

The app needs two Peergos permissions: **edit the file chosen by the user** (the file you open with it) and
**store app data** (its own private folder for notes and settings). It makes no network requests outside Peergos
(the Peergos sandbox would block them anyway).

## Install

1. Download `PeergosEasyEdit-v<version>.zip` from the [latest release](../../releases/latest).
2. In Peergos, upload the ZIP to your drive and click it to open it (Peergos shows what is inside).
3. Open the menu (⋮) of `peergos-app.json` → **Install** → confirm. Installing a newer version over an older one
   keeps your notes and settings.
4. Open a text file from your drive with PeergosEasyEdit, or start it from the Peergos app launcher.

Peergos 1.38 and older cannot install from inside a ZIP: unpack it, upload the folder, then use the menu of
`peergos-app.json` → **Install App**.

Peergos passes file names with `+`, `&`, `#` or `%` to apps changed; the editor then asks you to rename the file
instead of opening it. Peergos cannot open files with `%` in the name in any app at the moment.

## Development

The app is plain HTML, CSS and JavaScript – no build step, no dependencies at run time.

```
peergos-app.json        Peergos app manifest
assets/index.html       entry point, help and history
assets/js/              the app: peergos (requests to Peergos), text (encoding, line endings), backup (copy in
                        the browser), app (editor, saving, autosave, settings, notes), version
assets/css/             styles
tests/                  unit tests (Node), browser tests (Playwright + a mock Peergos), real Peergos scenarios
tools/                  release build, settings loader
```

Settings for the tools and tests come from environment variables, or from a local `.env` file (copy
`.env.example`; `.env` is never committed). The app itself has no settings or secrets.

```sh
node tests/unit.test.js                 # text encoding, line endings, file-name checks
python3 tests/browser_test.py           # the whole app against tests/mock_peergos.py (needs Playwright + Chromium)
python3 tests/mock_peergos.py           # try the app at http://127.0.0.1:8790/index.html?username=test&pgi=t
python3 tools/make_release.py --dev     # test build: ZIP + unpacked folder in Releases/dev/
python3 tools/make_release.py           # release build from a clean, committed tree; tags v<version>
```

`tests/mock_peergos.py` answers like Peergos and can fail on demand: 503 as after a restart of the sandbox's
service worker, refusals, requests that are never answered, a read-back that differs, failed reads. Every
"saved" check in the browser tests looks at the bytes the mock holds.

### Testing in a real Peergos

Use a throw-away local server, never a real account:

```sh
java -jar Peergos.jar pki-init -port 8777 -proxy-target /ip4/127.0.0.1/tcp/8003 -log-to-console false \
     -useIPFS false -max-users 100 peergos.password <admin password> pki.keygen.password x pki.keyfile.password y \
     default-quota 4294967296 PEERGOS_PATH <empty folder> -admin-usernames peergos -max-daily-signups 10000
java -cp Peergos.jar tests/peergos/Setup.java http://localhost:8777 testuser     # PEERGOS_TEST_PASSWORD from the environment
printf 'mkdir apps\nmkdir docs\ncd apps\nput PeergosEasyEdit-v1.1.0.zip\nexit\n' | \
     java -jar Peergos.jar shell -username testuser -PEERGOS_PASSWORD "$PEERGOS_TEST_PASSWORD" -peergos-url http://localhost:8777
java -cp Peergos.jar tests/peergos/PG.java http://localhost:8777 testuser put /testuser/docs notes.txt <a text file>
python3 tests/peergos/real_server.py --zip PeergosEasyEdit-v1.1.0.zip --scenario control --install
python3 tests/peergos/real_server.py --zip PeergosEasyEdit-v1.1.0.zip --scenario sw-stop
python3 tests/peergos/real_server.py --zip PeergosEasyEdit-v1.1.0.zip --scenario autosave
```

`sw-stop` stops the sandbox's service worker through the Chrome DevTools Protocol – what the browser does after a
while without activity – and saves; `autosave` does the same without pressing Save. `PG.java` reads the file on
the server through the Peergos Java API, so the checks do not depend on the app.

## Licence

PeergosEasyEdit is free software under the GNU General Public License, version 3 or later (see `LICENSE`).
