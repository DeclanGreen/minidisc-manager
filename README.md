# RetroDisc

A free desktop app for Windows and Mac for Sony **NetMD** MiniDisc players (the USB "Net MD" Walkmans and decks from about 2001–2005, such as the MZ-N505, MZ-N707, MZ-N710, MZ-N10 and MZ-N1). Plug the player in over USB to:

- **Read discs.** See the disc title, track list, recording mode (SP/LP2/LP4) and lengths, plus a capacity bar and a MiniDisc-style pie chart showing how much of the disc each track takes (hover a slice for details, click it to select the track). Each row in the track list also shows its share of the disc, and the disc's album art sits in the middle of the pie like a printed label. A button beside the graphic switches it to an old black vinyl record that spins like a turntable while a track plays.
- **Print an inlay.** **Print inlay…** opens a printable card for the case: a cover with the album art and pie chart, a numbered track list with times, and a spine strip. Print it at 100% scale (or choose "Microsoft Print to PDF"), then cut along the dashed lines. It is sized for a standard MiniDisc case insert (about 68 × 72 mm), but cases vary, so test one first.
- **Copy music to the disc.** Drag in MP3s (or FLAC, WAV, M4A, OGG…). The app decodes them and records them as ATRAC in **SP**, **LP2** or **LP4**. Track titles are filled in from the file tags ("Artist - Title"), and you can edit them before sending.
- **Import from CD** *(experimental, not yet tested with a real CD drive)*. Put an audio CD in your PC's drive (a USB drive is fine) and click **Import from CD…** in the Transfer tab. The app identifies the CD on MusicBrainz, fills in the album, track names and cover art, and lets you choose tracks and edit names. It can also name the MiniDisc after the album. Tracks are read straight from the CD at full quality during the transfer, with no MP3 step in between. If a scratched sector won't read, it's replaced with silence and noted in the Activity log. The CD reader is a small helper built automatically on first use with the C# compiler that comes with Windows, so **CD import is Windows-only** for now.
- **Bulk tools.** The Transfer tab has one-click helpers for the queue: **Tidy titles** (strips track numbers, underscores and "(Official Video)" tags, fixes ALL CAPS), **Sort A–Z / Z–A**, **Number** (adds 01, 02, 03…) and **Fit to disc** (picks the best mode that fits, or offers to trim the queue).
- **Folders and playlists.** Drop a folder (sub-folders included, in name order) or an `.m3u`, `.m3u8` or `.pls` playlist on the Transfer tab, or use **Add folder…** / **Add playlist…**. Every track is queued in order, missing files and web streams are skipped, and the capacity bar and **Fit to disc** work as usual.
- **Export and import titles.** **Export list…** saves the disc title and track list to a CSV file (a back-up you can open in Excel). Edit the titles there, then use **Import titles…** to rename the disc and tracks to match. Row `0` is the disc title, and rows are matched by track number. You see a summary and confirm before anything is renamed.
- **Edit the disc.** Rename the disc and tracks (double-click), drag tracks to reorder them, and delete tracks.
- **Erase the whole disc.** You type `ERASE` to confirm.
- **Album art.** Covers are looked up online from the disc title ("Artist - Album") on [MusicBrainz](https://musicbrainz.org) / the [Cover Art Archive](https://coverartarchive.org), with no account needed. Queued files show their embedded cover, or one looked up from their artist and album tags. Click the disc art to search with different words, choose your own image, remove it, or turn online lookup off. Art is cached on your PC and only appears in the app, since MiniDiscs can't store images.
- **Lyrics.** The **Lyrics** tab shows words for the selected track, or for whatever the player is playing. Lyrics come free from [LRCLIB](https://lrclib.net), with [lyrics.ovh](https://lyrics.ovh) as a backup. When LRCLIB has *synced* lyrics, the current line is highlighted and scrolls along as the MiniDisc plays. The artist is taken from the track title ("Artist - Song") or from the disc title. If the lyrics are wrong, click **Wrong lyrics?** to search with different words, and the app remembers the fix. Lyrics are cached on your PC. Lyrics sites are crowd-sourced, so they're occasionally wrong.
- **Music videos.** The **Video** tab finds the official YouTube video for the selected or playing track and plays it right in the app, preferring the artist's own or VEVO channel. Other matches are listed underneath if the first pick is wrong. Choosing a video from the list pauses the MiniDisc so they don't play over each other. The search reads YouTube's public results page with no API key, so it could break if YouTube changes that page.
- **Spotify.** The **Spotify** tab finds the disc's album on Spotify through MusicBrainz, with **Open in Spotify app** and **Open in browser** buttons and Spotify's preview player. If there's no exact album link, it opens a Spotify search instead.
- **Control the player.** Play, pause, stop, next and previous, with the playing track highlighted.
- **Check capacity first.** The app warns you before you queue more music than the disc can hold.

It's built on [netmd-js](https://github.com/cybercase/netmd-js), the open-source NetMD library behind Web MiniDisc.

## Install

You need a NetMD player with its USB cable, and either Windows 10 or 11 (64-bit) or a Mac running macOS 12 or later (Apple Silicon or Intel).

### Mac

1. **Download the disk image** from the [Releases page](https://github.com/DeclanGreen/retrodisc/releases): `RetroDisc-x.y.z-mac-arm64.dmg` for Apple Silicon (M1 and later) or `RetroDisc-x.y.z-mac-x64.dmg` for Intel Macs.
2. **Open it and drag RetroDisc into Applications.**
3. **First launch:** the app isn't signed with a paid Apple certificate, so macOS will refuse a normal double-click. Right-click (or Control-click) RetroDisc, choose **Open**, then **Open** again. If macOS says the app is "damaged", run `xattr -cr /Applications/RetroDisc.app` in Terminal and try again.
4. **Plug in the player** with a disc inserted and click **Connect player**. No USB driver is needed on a Mac.

LP2/LP4 need the atracdenc encoder, which is built into the Mac download when it could be compiled; if the LP2/LP4 buttons are greyed out, only SP is available. Audio CD import isn't available on the Mac yet.

### Windows

1. **Download the installer.** Go to the [Releases page](https://github.com/DeclanGreen/retrodisc/releases), open the latest release and download `RetroDisc-Setup-x.y.z.exe`.
2. **Run it.** Windows will probably show a blue **"Windows protected your PC"** warning, because the installer isn't signed with a paid certificate. Click **More info**, then **Run anyway**. Choose where to install, and it adds Start menu and desktop shortcuts.
3. **Install the USB driver** (once per PC). See the next section.
4. **Open RetroDisc**, plug in the player with a disc inserted, and click **Connect player**.

LP2 and LP4 work straight away, because the installer includes the encoder they need.

### Install the USB driver (once per PC)

Windows can't talk to a NetMD player until it has the generic **WinUSB** driver. Zadig is a free tool that installs it in a few clicks:

1. Plug in the player with a disc inserted.
2. Download **Zadig** from https://zadig.akeo.ie and run it.
3. Choose **Options → List All Devices**, pick your player from the list (e.g. "Net MD Walkman"), make sure **WinUSB** is selected on the right, and click **Install Driver** (or **Replace Driver**).
4. Wait for it to finish, then unplug the player and plug it back in.

This replaces Sony's own driver, so SonicStage won't see the player afterwards. To undo it, open Device Manager, right-click the player, and choose **Uninstall device**.

### Tested with

So far it has only been tested with a **Sony MZ-N707** on Windows 11. The Mac build is new and **has not been tested on a real Mac yet**. Other NetMD players should work, because the underlying library (netmd-js) supports them, but haven't been tried with this app. If you try another model, please open an issue saying whether it worked.

## Build from source

For developers. You don't need this to use the app.

1. **Install Node.js** (LTS) from nodejs.org.
2. **Install the USB driver** as described above.
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

The Mac app can only be built on a Mac: run `npm run dist:mac` there (put an `atracdenc` binary in `bin/` first for LP2/LP4). Or use the **Build macOS app** workflow in GitHub Actions, which does this on GitHub's Mac runners and attaches the `.dmg` files to a release.

## Tips

- Leave the disc's write-protect tab closed. If it's open, the app shows the disc as write-protected.
- Use SP for the best quality. LP2 doubles the playing time with good quality, and LP4 is best kept for speech.
- Some players (older Sharps, MZ-N1) show LP2/LP4 tracks as "LP" with a slight start delay. That's normal.
- Tracks recorded with SonicStage show a 🔒. You can rename, move and delete them like any other track.
- If something goes wrong mid-transfer, open the **Activity log** at the bottom. Unplugging and replugging the player usually clears a stuck state.

## Good to know

- The app looks things up on free online services: MusicBrainz and the Cover Art Archive (album details and art), LRCLIB and lyrics.ovh (lyrics), YouTube and Spotify. It sends them only search terms: artist, album and track names, or a CD's disc ID. You can turn off album art lookups in the disc art window (click the disc art), and lyrics lookups in the Lyrics tab.
- The Video tab finds videos by reading YouTube's public search results page. That isn't an official YouTube service, so it may stop working if YouTube changes the page.
- This project isn't affiliated with Sony. "Sony", "MiniDisc", "NetMD" and "ATRAC" are Sony trademarks.

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: USB device access (netmd-js), audio conversion (ffmpeg, atracdenc), IPC |
| `preload.js` | Safe bridge exposing `window.md` to the UI |
| `renderer/` | The interface (HTML/CSS/JS) |
| `lib/` | YouTube search, audio CD reading and MusicBrainz disc lookup |
| `bin/` | `atracdenc.exe` for LP2/LP4 (downloaded separately, see above) and its licence |

## Licence

RetroDisc is free software under the GNU General Public License v2.0 or later (see [LICENSE](LICENSE)), matching netmd-js. The installer bundles FFmpeg (GPL-3.0), atracdenc (LGPL-2.1), Electron (MIT) and other open-source components. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for their licences and source code links.
