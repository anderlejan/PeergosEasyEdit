# PeergosEasyEdit

A simple text editor as a [Peergos](https://peergos.org) custom app, for the text files in your Peergos drive.

- **Saving you can trust:** "Saved ✓" appears only after Peergos accepted the file and reading it back gave
  exactly the bytes that were sent. Every failure stays on screen with **Try again** and **Save as…**.
- **Autosave** after 2, 5 (default), 10 or 30 seconds without typing, or off; at least every 30 seconds while you
  keep typing, and when you switch to another window.
- **Nothing lost when something fails:** text that is not in its file yet is kept as a draft in Peergos and
  offered back, on any device. A file that could not be read is never shown empty and cannot be saved over. A
  file changed or deleted elsewhere since it was opened is never overwritten without asking.
- **Nothing on the device:** no texts, drafts, file names or settings in browser storage – everything the editor
  keeps is in Peergos, encrypted.
- **File menu:** New, Open…, recent files, Save (Ctrl+S), Save as…, Close. **Open…** and **Save as…** browse the
  folders you let the editor use (Peergos asks once and remembers them); any other file can be picked with
  Peergos' file picker.
- Starts from the Peergos launcher with the full editor; optional **tabs** that come back the next time, on any
  device; **recent files** (how many is up to you), with files that are gone marked as such.
- UTF-8 text; Windows line endings and the byte order mark are kept; files in other encodings open read-only.
- Ten themes, text size, font, line wrapping, optional line numbers – under **Options**, applied and saved at once
  in Peergos.
- Notes about anything, kept in the app's private folder in Peergos, with **Show all** to read or copy them
  together, and export and import.

The app needs two Peergos permissions: **edit the file chosen by the user** (the file you open with it) and
**store app data** (its own private folder for notes, settings, drafts, open tabs and recent files). Folders for
Open… and Save as… are granted separately, when you choose **Add folders…**. It makes no network requests outside
Peergos (the Peergos sandbox would block them anyway).

## Install

1. Download `PeergosEasyEdit-v<version>.zip` from the [latest release](../../releases/latest).
2. In Peergos, upload the ZIP to your drive and click it to open it (Peergos shows what is inside).
3. Open the menu (⋮) of `peergos-app.json` → **Install** → confirm. Installing a newer version over an older one
   keeps your notes and settings.
4. Open a text file from your drive with PeergosEasyEdit, or start it from the Peergos app launcher.

Updating from 1.1.0: unsaved texts that 1.1.0 kept in the browser are moved to drafts in Peergos on the first
start, then deleted from the browser.

Peergos 1.38 and older cannot install from inside a ZIP: unpack it, upload the folder, then use the menu of
`peergos-app.json` → **Install App**.

Peergos passes file names with `+`, `&`, `#` or `%` to apps changed when you open them from the Drive; the editor
then does not open the file and offers **Open…**, where such names work. Peergos cannot open files with `%` in the
name from the Drive in any app at the moment.

## Development

The app is plain HTML, CSS and JavaScript – no build step, no dependencies at run time.

```
peergos-app.json        Peergos app manifest
assets/index.html       entry point, help and history
assets/js/              the app: peergos (requests to Peergos), text (encoding, line endings), store (the app's
                        Peergos folder: drafts, settings, tabs), files (locations, granted folders, Open/Save as
                        dialog), docs (loading, saving, autosave, conflicts, drafts), app (menus, tabs, recent
                        files, settings, notes), version
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

Releases: a push to `main` that changes the version in `peergos-app.json` makes `.github/workflows/release.yml`
run the tests, build the release with `tools/make_release.py`, push the tag and create a draft release with the
app ZIP, the source ZIP and `SHA256SUMS-<version>.txt`. The release notes come from `release-notes/v<version>.md`
(or the version's section of `CHANGELOG.md`). The draft is published by hand after checking it.

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
python3 tests/peergos/real_server.py --zip PeergosEasyEdit-v1.1.0.zip --scenario v12
```

`sw-stop` stops the sandbox's service worker through the Chrome DevTools Protocol – what the browser does after a
while without activity – and saves; `autosave` does the same without pressing Save. `v12` grants a folder through Peergos' own picker,
opens and saves through it, saves as into a new folder, keeps a new text in a tab and starts the editor again
from the launcher. `PG.java` reads the file on
the server through the Peergos Java API, so the checks do not depend on the app.

## Licence

PeergosEasyEdit is free software under the GNU General Public License, version 3 or later (see `LICENSE`).
