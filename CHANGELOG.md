# Changelog

## Unreleased
Fixed
- The Notes button did not hide the notes panel (it was always shown).
- A white border around the app: Peergos' frame page kept the browser's default margin.

Added
- **Options** menu (theme, font, autosave, line wrapping, line numbers, notes panel, backup, help, about) and a
  **File** menu, so everything fits in one compact bar.
- Optional line numbers, also for wrapped lines.
- Six more themes: amber on black, Solarized light and dark, Nord, blue (classic), high contrast.
- **Show all** in the notes panel: every note in one window, tick the ones to copy, or copy all.
- **Open…** and **Save as…** browse the folders you let the editor use (Peergos asks once, on any device), with
  new folders; Peergos' file picker for any other file. Names with `+ & # %` work there.
- Starts from the launcher with the full editor: New text, Open…, recent files and unsaved texts.
- Optional **tabs**; the tabs left open come back the next time, on any device.
- **Recent files** in the File menu (5, 10 or 20, or off); a file deleted or moved meanwhile is marked as not found.
- Before saving, the editor checks that the file was not changed or deleted elsewhere since it was opened, and
  asks what to do instead of overwriting.

Changed
- The notes panel and line numbers are remembered like the other settings. Slightly darker button colours in the
  dark theme for better contrast.
- Nothing is kept on the device any more: text not yet saved is kept as a draft in the app's Peergos folder
  (encrypted, on every device) instead of in the browser. Unsaved texts kept in the browser by 1.1.0 are moved
  there on the first start, then deleted from the browser. Settings are read only from Peergos.

## 1.1.0
Rewritten from scratch; the same notes and settings – an upgrade keeps them.

Fixed
- Text could be lost without a message: when Peergos had been idle for a while, the browser stopped the sandbox's
  service worker and the next save was answered 503 – the editor cleared "Saving file…" as if it had worked. Such
  requests are now sent again, and "Saved ✓" is shown only after the file was read back with exactly the bytes sent.
  Every failure stays on screen with **Try again** and **Save as…**.
- After saving, the editor replaced the text with what Peergos sent back, so a bad read (or typing during the
  save) could become the new text. The text in the editor is never replaced now.
- A file that could not be read opened as an empty text that could then be saved over the real one. It now shows
  the error with **Try again** and saves nothing until the file has been read.
- Files whose names hold `+`, `&`, `#` or `%` opened empty and could not be saved: Peergos passes such names to apps
  changed. The editor detects this and asks to rename the file instead.
- Files that are not UTF-8 were changed on saving (undecodable bytes replaced); they open read-only now. Windows
  line endings (CR LF) and the UTF-8 byte order mark are kept.
- Notes that could not be read were treated as "no notes" and the next change replaced them; settings and notes
  are now treated as empty only when Peergos says they do not exist.
- Note titles and texts are shown as text (they were inserted as HTML in the change log).

Added
- **Autosave**, after 2, 5 (default), 10 or 30 s without typing, or off; at least every 30 s while typing, and
  when switching away. Checked like a manual save; after a failure it tries again 30 s later.
- A copy of the text is kept in this browser while it is not saved; changes that never reached the file are
  offered back when it is opened again, and a file that is not what was last saved here is pointed out.
- **Save as…**, Ctrl+S, an "Unsaved changes" mark, a message while Peergos is slow to answer.
- Started from the launcher without a file, the editor saves through Peergos' save dialog.

Changed
- Settings apply and are saved at once (no Save Settings button, no restart).
- Help and history are part of the app; the app ships no `data/` folder (an upgrade keeps the old one untouched).
- The note change log in the history is gone.
- New code, styles and tests (unit, browser with a mock Peergos that injects failures, real local Peergos);
  free software under the GPL, version 3 or later.

## 1.0.5
- Last version before the clean-up (not on GitHub).
