# CLAUDE.md

## Overview
MiniDisc Manager: an Electron desktop app for Sony NetMD players (the user's player is a Sony MZ-N707 with the WinUSB driver installed). Run it with `npm start`. See README.md for the feature list.

## Layout
- `main.js`: Electron main process. Handles NetMD over USB (netmd-js + node-usb WebUSB), audio conversion (ffmpeg-static, plus optional `bin/atracdenc.exe` for LP2/LP4), album art and lyrics lookups, and IPC.
- `lib/youtube.js`: official-video search and ranking. `lib/cd.js` + `lib/cdrip.cs`: audio CD reading (the C# helper is compiled on first use with the Windows .NET Framework `csc.exe`) and MusicBrainz disc ID lookup.
- `preload.js`: exposes `window.md` to the renderer. `renderer/`: UI (CSP blocks inline styles, so set styles via the CSSOM).
- node-usb defaults control transfers to a 1 s timeout (netmd-js passes none), which broke uploads with "transfer was cancelled". `main.js` patches `UsbDevice.prototype.controlTransferIn/Out` to default to 30 s. Keep that patch when upgrading `usb`.
- Uploads use our own `downloadTrack()` in `main.js`, not `netmd.download()`. netmd-js's encrypt worker exits after one track, so each track needs a new `Worker`. Its `prepareDownload()` also waits forever unless the state is 'ready'/'discBlank', and the MZ-N707 sometimes reports 0x56FF ("unknown"), especially after an interrupted transfer. Sending audio in that state stalls, hence the bounded wait and the 45 s stall watchdog.
- Uploads are verified on the real player (SP, several tracks in a row, Nov 2026).
- Device access is serialised through `exclusive()`, because NetMD handles one command at a time. Only one process can hold the player, so close the app before running standalone USB tests.

## Version control
- Remote: `origin` → https://github.com/DeclanGreen/minidisc-manager (**public**), branch `main`. Anything committed is visible to everyone.
- Releases: bump `version` in package.json, run `npm run dist` (with `bin/atracdenc.exe` present), then `gh release create vX.Y.Z dist/MiniDisc-Manager-Setup-X.Y.Z.exe`. Ask the user before publishing a release.
- Commit after each self-contained change with a short imperative subject, then push right away.
- `gh` is not on PATH. Call it as `"/c/Program Files/GitHub CLI/gh.exe"` from Git Bash.

## Testing
- No test suite. Check UI changes by launching Electron with a scratch script that requires `main.js`, injects mock state through `executeJavaScript`, and saves screenshots with `capturePage()`.
- Ask before running anything that writes to the user's MiniDisc (uploads, renames, deletes, erase).
- LP2/LP4 verified on the real player with atracdenc 0.2.3 (Nov 2026).
- Not yet verified on real hardware: reading a real CD (the PC has no CD drive).
