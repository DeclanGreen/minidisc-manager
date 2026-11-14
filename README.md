# MiniDisc Manager

A Windows desktop app for Sony **NetMD** MiniDisc players (MZ-N505, MZ-N710, MZ-N10, MZ-N1 and others). Plug the player in over USB to:

- **Read discs.** See the disc title, track list, recording mode (SP/LP2/LP4) and lengths, plus a capacity bar.
- **Copy music to the disc.** Drag in MP3s (or FLAC, WAV, M4A, OGG…). The app decodes them and records them as ATRAC in **SP**, **LP2** or **LP4**. Track titles are filled in from the file tags ("Artist - Title"), and you can edit them before sending.
- **Edit the disc.** Rename the disc and tracks (double-click), drag tracks to reorder them, and delete tracks.
- **Erase the whole disc.** You type `ERASE` to confirm.
- **Album art.** Covers are looked up online from the disc title ("Artist - Album") on [MusicBrainz](https://musicbrainz.org) / the [Cover Art Archive](https://coverartarchive.org), with no account needed. Queued files show their embedded cover, or one looked up from their artist and album tags. Click the disc art to search with different words, choose your own image, remove it, or turn online lookup off. Art is cached on your PC and only appears in the app, since MiniDiscs can't store images.
- **Control the player.** Play, pause, stop, next and previous, with the playing track highlighted.
- **Check capacity first.** The app warns you before you queue more music than the disc can hold.

It's built on [netmd-js](https://github.com/cybercase/netmd-js), the open-source NetMD library behind Web MiniDisc.

## One-time setup

1. **Install Node.js** (LTS) from nodejs.org.
2. **Install the WinUSB driver for the player.** Windows can't talk to a NetMD player directly without it.
   - Plug in the player with a disc inserted.
   - Download **Zadig** from https://zadig.akeo.ie and run it.
   - Choose *Options → List All Devices*, pick your player (e.g. "Net MD Walkman"), choose **WinUSB** and click *Install / Replace Driver*.
   - Note: this replaces Sony's own driver, so SonicStage won't see the player afterwards. You can roll it back in Device Manager.
3. **Install the app's dependencies.** In this folder, run:
   ```
   npm install
   ```
4. **Optional: add LP2/LP4 support.** SP works straight away because the player encodes SP itself. LP2/LP4 need the PC to encode ATRAC3, which the free **atracdenc** encoder does. Get a Windows build of `atracdenc.exe` (https://github.com/dcherednik/atracdenc) and put it at `bin\atracdenc.exe` in this folder. The LP2/LP4 buttons switch on when it's found.

## Run

```
npm start
```

Click **Connect player**. Once you've connected once, the app also connects automatically when you plug the player in.

## Build an installer

```
npm run dist
```

This creates a Windows installer in `dist\`. If `bin\atracdenc.exe` is there, it's bundled in.

## Tips

- Leave the disc's write-protect tab closed. If it's open, the app shows the disc as write-protected.
- Use SP for the best quality. LP2 doubles the playing time with good quality, and LP4 is best kept for speech.
- Some players (older Sharps, MZ-N1) show LP2/LP4 tracks as "LP" with a slight start delay. That's normal.
- Tracks recorded with SonicStage show a 🔒. You can rename, move and delete them like any other track.
- If something goes wrong mid-transfer, open the **Activity log** at the bottom. Unplugging and replugging the player usually clears a stuck state.

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: USB device access (netmd-js), audio conversion (ffmpeg, atracdenc), IPC |
| `preload.js` | Safe bridge exposing `window.md` to the UI |
| `renderer/` | The interface (HTML/CSS/JS) |
| `bin/` | Optional `atracdenc.exe` for LP2/LP4 |

Licensed GPL-2.0-or-later, matching netmd-js.
