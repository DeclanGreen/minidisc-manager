# Third-party notices

MiniDisc Manager is free software, licensed under the GNU General Public License v2.0 or later (see `LICENSE`). Its full source code is in this repository.

The Windows installer bundles the third-party software listed below. Each component keeps its own licence. In an installed copy, the licence files are under `resources\app\node_modules\<package>\`, `resources\bin\` and the install folder itself.

## Main components

| Component | Used for | Licence | Source |
| --- | --- | --- | --- |
| [netmd-js](https://github.com/cybercase/netmd-js) 4.4.1 | Talking to NetMD players over USB | GPL-2.0 | https://github.com/cybercase/netmd-js |
| [FFmpeg](https://ffmpeg.org) 6.1.1 (gyan.dev "essentials" build, via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 5.3.0) | Decoding MP3/FLAC/M4A/etc. | GPL-3.0 (binary), GPL-3.0-or-later (ffmpeg-static) | https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 (licence and build details: `node_modules\ffmpeg-static\ffmpeg.exe.LICENSE` / `.README`) |
| [atracdenc](https://github.com/dcherednik/atracdenc) 0.2.3 (official Windows build) | Encoding ATRAC3 for LP2/LP4 | LGPL-2.1 | https://github.com/dcherednik/atracdenc/releases/tag/0.2.3 (licence: `bin\atracdenc-LICENSE.txt`) |
| [Electron](https://www.electronjs.org) 45 | Application runtime (includes Chromium and Node.js) | MIT, plus the Chromium licences | `LICENSE.electron.txt` and `LICENSES.chromium.html` in the install folder |
| [node-usb](https://github.com/node-usb/node-usb) 3.3.0 | USB access | MIT | https://github.com/node-usb/node-usb |
| [music-metadata](https://github.com/borewit/music-metadata) 12.5.0 | Reading tags and embedded cover art | MIT | https://github.com/borewit/music-metadata |
| [crypto-js-wasm](https://github.com/originjs/crypto-js-wasm) 1.1.0 (dependency of netmd-js) | DES encryption for NetMD transfers | Mulan PSL v2 | https://github.com/originjs/crypto-js-wasm |

FFmpeg and atracdenc run as separate programs that the app starts. They aren't linked into the app.

## Other npm packages

The remaining dependencies are small npm packages (about 100 in total) under permissive licences: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, and MIT AND Zlib (pako). To list them with their licences, run:

```
npm ls --omit=dev --all
```

## Online services

The app looks things up on these free services. It isn't affiliated with or endorsed by any of them:

- [MusicBrainz](https://musicbrainz.org) and the [Cover Art Archive](https://coverartarchive.org): album and CD details, and cover art.
- [LRCLIB](https://lrclib.net) and [lyrics.ovh](https://lyrics.ovh): lyrics.
- YouTube: search and embedded playback.
- Spotify: album links and the embedded preview player.

"Sony", "MiniDisc", "NetMD" and "ATRAC" are trademarks of Sony Group Corporation. This project isn't affiliated with Sony.
