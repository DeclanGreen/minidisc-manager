# CLAUDE.md

## Overview
RetroDisc: an Electron desktop app for Sony NetMD players (the user's player is a Sony MZ-N707 with the WinUSB driver installed). Run it with `npm start`. See README.md for the feature list.

## Layout
- `main.js`: Electron main process. Handles NetMD over USB (netmd-js + node-usb WebUSB), audio conversion (ffmpeg-static, plus optional `bin/atracdenc.exe` for LP2/LP4), album art and lyrics lookups, and IPC.
- `lib/youtube.js`: official-video search and ranking. `lib/cd.js` + `lib/cdrip.cs`: audio CD reading (the C# helper is compiled on first use with the Windows .NET Framework `csc.exe`) and MusicBrainz disc ID lookup.
- `preload.js`: exposes `window.md` to the renderer. `renderer/`: UI (CSP blocks inline styles, so set styles via the CSSOM).
- node-usb defaults control transfers to a 1 s timeout (netmd-js passes none), which broke uploads with "transfer was cancelled". `main.js` patches `UsbDevice.prototype.controlTransferIn/Out` to default to 30 s. Keep that patch when upgrading `usb`.
- Uploads use our own `downloadTrack()` in `main.js`, not `netmd.download()`. netmd-js's encrypt worker exits after one track, so each track needs a new `Worker`. Its `prepareDownload()` also waits forever unless the state is 'ready'/'discBlank', and the MZ-N707 sometimes reports 0x56FF ("unknown"), especially after an interrupted transfer. Sending audio in that state stalls, hence the bounded wait and the 45 s stall watchdog.
- Uploads are verified on the real player (SP, several tracks in a row, Nov 2026).
- Device access is serialised through `exclusive()`, because NetMD handles one command at a time. Only one process can hold the player, so close the app before running standalone USB tests.

## Version control
- Remote: `origin` → https://github.com/DeclanGreen/retrodisc (**public** since 15 Nov 2026, at the user's request; it had been briefly private). Ask before changing visibility again.
- Releases: bump `version` in package.json, run `npm run dist` (with `bin/atracdenc.exe` present), then `gh release create vX.Y.Z dist/RetroDisc-Setup-X.Y.Z.exe`. Ask the user before publishing a release.
- Mac: cannot be built on this Windows PC (native `usb` and `ffmpeg-static` binaries are per-platform). `.github/workflows/build-mac.yml` builds the `.dmg` files on a macOS runner and attaches them when a release is published (or run it by hand). The Mac build is ad-hoc signed (`identity: "-"`), not notarized, and has not been tested on real hardware. CD import is Windows-only (`lib/cd.js` needs csc.exe). Pushing workflow files needs the `workflow` scope on the gh token.
- Promo page: `promo/facebook-page.html` is the source of the published page https://claude.ai/artifact/MkDfnZpQrFB49JQ2ZYuFNx (features, Mac-untested note, copy-ready Facebook post with a `[add your link here]` placeholder to fill with the Releases page link). Republish that file with the Artifact tool to update it, and keep it in step with the README feature list.
- Pushing: git uses Git Credential Manager, which lacks the `workflow` scope, so pushes that touch `.github/workflows` are rejected. Push with the gh token instead: `git -c credential.helper= -c "credential.helper=!\"/c/Program Files/GitHub CLI/gh.exe\" auth git-credential" push`. gh itself already has the `workflow` scope.
- Disc graphic (`renderTrackMap` in `renderer/app.js`): an SVG ring/pie with one slice per track sized by `trackShares()` (LP2/LP4 and mono count as less disc space), or a black vinyl look (default, remembered in localStorage as `retrodisc.pieStyle`) that spins at 33 1/3 rpm while `S.pos.playing`. The spin angle lives in `SPIN`, outside the SVG, because the SVG is rebuilt on every `render()`. Print inlay builds a standalone HTML page in `main.js` (`buildInlayHtml`, no CSP so it can have inline styles) and opens it in a preview window. Card size (68 x 72 mm) is a guess, not measured from a real case.
- Tonearm (vinyl look): `ARM`, `armAngleFor()`, `armTarget()`, `applyArm()` and `spinFrame()` in `renderer/app.js`. The pivot is at the top right of the 200x160 viewBox; the stylus is placed by intersecting a circle of the arm length with the circle of the wanted groove radius and taking the LOWER intersection (the stylus plays the lower half of the record). Groove radius comes from the same bands the record is drawn with: the music is cut across the whole groove area in proportion to each track's disc space, so the stylus travels rim to label over the whole disc. The arm creeps with `playerPos()` inside the playing track's band and swings back to its rest angle (98 degrees) when `S.playingTrack` is null. Neighbouring tracks are only ~2 px apart on a 20-track disc, which is why the track gaps are drawn as visible shiny rings.
- Play: `window.md.transport('play', index)` calls `gotoTrack(index)` (0-based) then `play()`. The renderer only passes an index when the player is stopped and exactly one track is selected; if it is playing or paused, Play just carries on. Before this, Play resumed wherever the player last stopped, so selecting a track did nothing.
- Testing against the real player: close the installed RetroDisc first (only one process can hold the player), then run a scratch script that requires `main.js`, clicks the real transport buttons and captures screenshots. `S`, `ARM`, `render()` and `playerPos()` are reachable through `executeJavaScript`.
- Software eject: netmd-js has `ejectDisc()`/`canEjectDisc()`, but the user's MZ-N707 answers `canEjectDisc: false` (checked 16 Nov 2026), so there is no Eject button. Only tray-loading decks would support it.
- Releases so far: v0.1.0, v0.2.0, v0.3.0 (pie chart), v0.4.0 (album art in the pie, Print inlay, vinyl look), v0.5.0 (tonearm, Play starts the selected track). The Mac workflow failed for v0.3.0 only because GitHub could not get a macOS arm64 runner; re-run it later if that happens again.
- Ideas not built yet: volume levelling when sending, splitting a long file into tracks at silences, a disc library, fades/trim silence, download from disc (NetMD players like the MZ-N707 can't upload audio, only the Hi-MD MZ-RH1 can), Mac CD import, code signing/notarization, a v0.2.0 test install on a clean PC and on a real Mac.
- Commit after each self-contained change with a short imperative subject, then push right away.
- `gh` is not on PATH. Call it as `"/c/Program Files/GitHub CLI/gh.exe"` from Git Bash.

## Testing
- No test suite. Check UI changes by launching Electron with a scratch script that requires `main.js`, injects mock state through `executeJavaScript`, and saves screenshots with `capturePage()`.
- Ask before running anything that writes to the user's MiniDisc (uploads, renames, deletes, erase).
- LP2/LP4 verified on the real player with atracdenc 0.2.3 (Nov 2026).
- Not yet verified on real hardware: reading a real CD (the PC has no CD drive).
