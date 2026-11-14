# MiniDisc Manager

A Windows desktop app for Sony **NetMD** MiniDisc players (MZ-N505, MZ-N710, MZ-N10, MZ-N1 and others). Plug the player in over USB to:

- **Read discs.** See the disc title, track list, recording mode (SP/LP2/LP4) and lengths, plus a capacity bar.
- **Copy music to the disc.** Drag in MP3s (or FLAC, WAV, M4A, OGG…). The app decodes them and records them as ATRAC in **SP**, **LP2** or **LP4**. Track titles are filled in from the file tags ("Artist - Title"), and you can edit them before sending.
- **Import from CD.** Put an audio CD in your PC's drive (a USB drive is fine) and click **Import from CD…** in the Transfer tab. The app identifies the CD on MusicBrainz, fills in the album, track names and cover art, and lets you choose tracks and edit names. It can also name the MiniDisc after the album. Tracks are read straight from the CD at full quality during the transfer, with no MP3 step in between. If a scratched sector won't read, it's replaced with silence and noted in the Activity log. The CD reader is a small helper built automatically on first use with the C# compiler that comes with Windows.
- **Edit the disc.** Rename the disc and tracks (double-click), drag tracks to reorder them, and delete tracks.
- **Erase the whole disc.** You type `ERASE` to confirm.
- **Album art.** Covers are looked up online from the disc title ("Artist - Album") on [MusicBrainz](https://musicbrainz.org) / the [Cover Art Archive](https://coverartarchive.org), with no account needed. Queued files show their embedded cover, or one looked up from their artist and album tags. Click the disc art to search with different words, choose your own image, remove it, or turn online lookup off. Art is cached on your PC and only appears in the app, since MiniDiscs can't store images.
- **Lyrics.** The **Lyrics** tab shows words for the selected track, or for whatever the player is playing. Lyrics come free from [LRCLIB](https://lrclib.net), with [lyrics.ovh](https://lyrics.ovh) as a backup. When LRCLIB has *synced* lyrics, the current line is highlighted and scrolls along as the MiniDisc plays. The artist is taken from the track title ("Artist - Song") or from the disc title. If the lyrics are wrong, click **Wrong lyrics?** to search with different words, and the app remembers the fix. Lyrics are cached on your PC. Lyrics sites are crowd-sourced, so they're occasionally wrong.
- **Music videos.** The **Video** tab finds the official YouTube video for the selected or playing track and plays it right in the app, preferring the artist's own or VEVO channel. Other matches are listed underneath if the first pick is wrong. Choosing a video from the list pauses the MiniDisc so they don't play over each other. The search reads YouTube's public results page with no API key, so it could break if YouTube changes that page.
- **Spotify.** The **Spotify** tab finds the disc's album on Spotify through MusicBrainz, with **Open in Spotify app** and **Open in browser** buttons and Spotify's preview player. If there's no exact album link, it opens a Spotify search instead.
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
4. **Optional: add LP2/LP4 support.** SP works straight away because the player encodes SP itself. LP2/LP4 need the PC to encode ATRAC3, which the free **atracdenc** encoder does. Download the official Windows build (`atracdenc-win-x86_0.2.3.zip` from https://github.com/dcherednik/atracdenc/releases) and copy `x86\atracdenc.exe` to `bin\atracdenc.exe` in this folder. The app runs it as `-e atrac3` for LP2 (132 kbps) and `-e atrac3 --bitrate 64` for LP4 (66 kbps joint stereo). The LP2/LP4 buttons switch on when it's found.

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
