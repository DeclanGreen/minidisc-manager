# CLAUDE.md

## Overview
MiniDisc Manager: an Electron desktop app for Sony NetMD players (the user's player is a Sony MZ-N707 with the WinUSB driver installed). Run it with `npm start`. See README.md for the feature list.

## Layout
- `main.js`: Electron main process. Handles NetMD over USB (netmd-js + node-usb WebUSB), audio conversion (ffmpeg-static, plus optional `bin/atracdenc.exe` for LP2/LP4), album art and lyrics lookups, and IPC.
- `lib/youtube.js`: official-video search and ranking. `lib/cd.js` + `lib/cdrip.cs`: audio CD reading (the C# helper is compiled on first use with the Windows .NET Framework `csc.exe`) and MusicBrainz disc ID lookup.
- `preload.js`: exposes `window.md` to the renderer. `renderer/`: UI (CSP blocks inline styles, so set styles via the CSSOM).
- node-usb defaults control transfers to a 1 s timeout (netmd-js passes none), which broke uploads with "transfer was cancelled". `main.js` patches `UsbDevice.prototype.controlTransferIn/Out` to default to 30 s. Keep that patch when upgrading `usb`.
- Device access is serialised through `exclusive()`, because NetMD handles one command at a time. Only one process can hold the player, so close the app before running standalone USB tests.

## Version control
- Remote: `origin` → https://github.com/DeclanGreen/minidisc-manager (private), branch `main`.
- Commit after each self-contained change with a short imperative subject, then push right away.
- `gh` is not on PATH. Call it as `"/c/Program Files/GitHub CLI/gh.exe"` from Git Bash.

## Testing
- No test suite. Check UI changes by launching Electron with a scratch script that requires `main.js`, injects mock state through `executeJavaScript`, and saves screenshots with `capturePage()`.
- Ask before running anything that writes to the user's MiniDisc (uploads, renames, deletes, erase).
- Not yet verified on real hardware: uploading to the disc, LP2/LP4 encoding, and reading a real CD (the PC has no CD drive).
