// RetroDisc — Electron main process.
// Owns the USB connection to the NetMD player (via netmd-js + node-usb) and
// all audio conversion (ffmpeg for decoding, atracdenc for LP2/LP4 encoding).
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const { WebUSB } = require('usb');
const netmd = require('netmd-js');
const { makeGetAsyncPacketIteratorOnWorkerThread } = require('netmd-js/dist/node-encrypt-worker');
const { sanitizeHalfWidthTitle } = require('netmd-js/dist/utils');

// In a packaged build, binaries live outside the asar archive.
const unpacked = (p) => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const FFMPEG = unpacked(require('ffmpeg-static'));
const ATRACDENC_CANDIDATES = [
  path.join(process.resourcesPath || '', 'bin', 'atracdenc.exe'),
  path.join(__dirname, 'bin', 'atracdenc.exe'),
  path.join(__dirname, 'bin', 'atracdenc'),
];
const findAtracdenc = () => ATRACDENC_CANDIDATES.find((p) => p && fs.existsSync(p)) || null;

let win;
let iface = null; // NetMDInterface
let deviceName = '';
let cancelRequested = false;

// ---------- serialise all device access: NetMD can only do one thing at a time
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function log(msg) {
  send('log', `[${new Date().toLocaleTimeString()}] ${msg}`);
}

function requireDevice() {
  if (!iface) throw new Error('No MiniDisc player connected.');
  return iface;
}

// ---------- device
// node-usb gives every control transfer a 1 s timeout unless told otherwise, and netmd-js never passes one.
// Players can take longer than that to answer while they're busy (secure-session setup before recording, writing
// the TOC after an erase), and a timed-out command leaves the player stuck mid-reply ("transfer was cancelled").
// Browsers' WebUSB has no timeout at all, which is what netmd-js was written against, so allow plenty of time.
const CONTROL_TIMEOUT_MS = 30000;
{
  const { UsbDevice } = require('usb/index.js');
  const cin = UsbDevice.prototype.controlTransferIn, cout = UsbDevice.prototype.controlTransferOut;
  UsbDevice.prototype.controlTransferIn = function (setup, length, timeout = CONTROL_TIMEOUT_MS) { return cin.call(this, setup, length, timeout); };
  UsbDevice.prototype.controlTransferOut = function (setup, data, timeout = CONTROL_TIMEOUT_MS) { return cout.call(this, setup, data, timeout); };
}
const isUsbStall = (e) => /transfer was cancelled|timed? ?out|LIBUSB_ERROR/i.test(String(e && e.message));

const webusb = new WebUSB({
  allowedDevices: netmd.DevicesIds.map(({ vendorId, deviceId }) => ({ vendorId, productId: deviceId })),
});

async function connect() {
  if (iface) return { connected: true, name: deviceName };
  const dev = await netmd.openNewDevice(webusb);
  if (!dev) return { connected: false };
  iface = dev;
  deviceName = iface.netMd.getDeviceName ? iface.netMd.getDeviceName() : 'NetMD device';
  log(`Connected to ${deviceName}`);
  return { connected: true, name: deviceName };
}

async function disconnect() {
  if (!iface) return;
  try { await iface.netMd.finalize(); } catch {}
  iface = null;
  log('Disconnected');
}

const isNetMD = (d) => netmd.DevicesIds.some((x) => x.vendorId === d.vendorId && x.deviceId === d.productId);
webusb.addEventListener('disconnect', (e) => {
  if (iface && isNetMD(e.device)) { iface = null; log('Player unplugged'); send('device-lost'); }
});
webusb.addEventListener('connect', (e) => { if (isNetMD(e.device)) send('device-attached'); });

const ENCODING = { [netmd.Encoding.sp]: 'SP', [netmd.Encoding.lp2]: 'LP2', [netmd.Encoding.lp4]: 'LP4' };

async function readDisc() {
  const md = requireDevice();
  const status = await netmd.getDeviceStatus(md);
  if (!status.discPresent) return { status, disc: null };
  const disc = await netmd.listContent(md);
  const tracks = netmd.getTracks(disc)
    .sort((a, b) => a.index - b.index)
    .map((t) => ({
      index: t.index,
      title: t.title || '',
      seconds: t.duration / 512,
      encoding: ENCODING[t.encoding] || '?',
      mono: t.channel === netmd.Channels.mono,
      protected: t.protected === netmd.TrackFlag.protected,
    }));
  return {
    status,
    disc: {
      title: disc.title || '',
      writable: disc.writable,
      writeProtected: disc.writeProtected,
      usedSec: disc.used / 512,
      leftSec: disc.left / 512,
      totalSec: disc.total / 512,
      tracks,
    },
  };
}

// ---------- audio conversion
function run(cmd, args, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = [];
    let err = '';
    if (collect) p.stdout.on('data', (b) => out.push(b));
    p.stderr.on('data', (b) => { err += b.toString(); if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(collect ? Buffer.concat(out) : null);
      else reject(new Error(`${path.basename(cmd)} failed (code ${code}): ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

// Returns a standalone ArrayBuffer in the wire format the player expects.
async function encode(file, mode) {
  if (mode === 'SP') {
    // The player encodes SP itself: send raw 16-bit big-endian 44.1 kHz stereo PCM.
    const pcm = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '44100', '-f', 's16be', 'pipe:1'], { collect: true });
    return { data: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength), format: netmd.Wireformat.pcm };
  }
  const enc = findAtracdenc();
  if (!enc) throw new Error('LP2/LP4 need atracdenc.exe in the app\'s bin folder (see README).');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-'));
  const wav = path.join(tmp, 'in.wav');
  const oma = path.join(tmp, 'out.oma');
  try {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav]);
    await run(enc, ['-e', 'atrac3', '-i', wav, '-o', oma, '--bitrate', mode === 'LP2' ? '128' : '64']);
    let buf = fs.readFileSync(oma);
    // Strip the OMA/EA3 container header to leave raw ATRAC3 frames.
    if (buf.slice(0, 3).toString('latin1') === 'EA3') buf = buf.subarray(buf.readUInt16BE(4) || 96);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), format: mode === 'LP2' ? netmd.Wireformat.lp2 : netmd.Wireformat.lp4 };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function cleanTitle(t) {
  // MiniDisc titles are half-width (ASCII + katakana). Fold accents, then let netmd-js remap.
  const folded = t.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚′´`]/g, "'")      // curly/prime apostrophes
    .replace(/[“”„″]/g, '"')             // curly quotes
    .replace(/[‐-―−]/g, '-')                  // hyphens and dashes
    .replace(/…/g, '...')
    .replace(/[  -​]/g, ' ');
  return sanitizeHalfWidthTitle(folded).replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function probe(file) {
  const mm = await import('music-metadata');
  let title = path.basename(file, path.extname(file));
  let seconds = 0, artist = '', album = '', art = null;
  try {
    const meta = await mm.parseFile(file, { duration: true });
    const c = meta.common;
    artist = c.albumartist || c.artist || '';
    album = c.album || '';
    if (c.title) title = c.artist ? `${c.artist} - ${c.title}` : c.title;
    seconds = meta.format.duration || 0;
    const pic = c.picture && c.picture[0];
    if (pic) art = thumb(Buffer.from(pic.data), 96);
  } catch {}
  return { path: file, name: path.basename(file), title, seconds, artist, album, art };
}

// ---------- album art (MusicBrainz + Cover Art Archive, cached on disk)
const ART_DIR = () => path.join(app.getPath('userData'), 'art');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const UA = () => `RetroDisc/${app.getVersion()} (desktop app)`;
let settings = null;
let artIndex = null;

function loadSettings() {
  if (!settings) { try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { settings = {}; } }
  return { onlineArt: true, onlineLyrics: true, ...settings };
}
function saveSettings(patch) {
  settings = { ...loadSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  return settings;
}
function index() {
  if (!artIndex) { try { artIndex = JSON.parse(fs.readFileSync(path.join(ART_DIR(), 'index.json'), 'utf8')); } catch { artIndex = {}; } }
  return artIndex;
}
function saveIndex() {
  fs.mkdirSync(ART_DIR(), { recursive: true });
  fs.writeFileSync(path.join(ART_DIR(), 'index.json'), JSON.stringify(artIndex, null, 1));
}
const artKey = (t) => t.trim().toLowerCase().replace(/\s+/g, ' ');
const artFile = (key, ext) => path.join(ART_DIR(), crypto.createHash('sha1').update(key).digest('hex') + '.' + ext);

// Resized data URL for the UI (keeps IPC payloads small).
function thumb(buf, width) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  return (img.getSize().width > width ? img.resize({ width, quality: 'best' }) : img).toDataURL();
}

// MusicBrainz allows ~1 request/second; queue them.
let mbChain = Promise.resolve();
let mbLast = 0;
function mbFetch(url) {
  const run = mbChain.then(async () => {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    for (let attempt = 0; ; attempt++) {
      mbLast = Date.now();
      const r = await fetch(url, { headers: { 'User-Agent': UA(), Accept: 'application/json' } });
      if (r.ok) return r.json();
      // 503 = rate limited: back off and retry a couple of times.
      if (r.status !== 503 || attempt >= 3) throw new Error(`MusicBrainz replied ${r.status}`);
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  });
  mbChain = run.catch(() => {});
  return run;
}

// "Artist - Album" → { artist, album }
function splitTitle(t) {
  const parts = t.split(/\s+[-–—\/]\s+/);
  return parts.length >= 2 ? { artist: parts[0], album: parts.slice(1).join(' - ') } : { artist: '', album: t };
}
// Loose term match (not an exact phrase): MD titles are often abbreviated or missing words.
const terms = (s) => '(' + s.replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, ' ').replace(/\s+/g, ' ').trim() + ')';

async function searchArt(artist, album) {
  if (!terms(album).slice(1, -1)) return null;
  const q = `releasegroup:${terms(album)}` + (terms(artist).length > 2 ? ` AND artist:${terms(artist)}` : '');
  const j = await mbFetch(`https://musicbrainz.org/ws/2/release-group/?fmt=json&limit=5&query=${encodeURIComponent(q)}`);
  const groups = (j['release-groups'] || []).filter((g) => g.score >= 70).slice(0, 4);
  for (const g of groups) {
    const r = await fetch(`https://coverartarchive.org/release-group/${g.id}/front-500`, { headers: { 'User-Agent': UA() } });
    if (!r.ok) continue;
    return {
      buf: Buffer.from(await r.arrayBuffer()),
      ext: (r.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg',
      source: { mbid: g.id, title: g.title, artist: (g['artist-credit'] || []).map((a) => a.name + (a.joinphrase || '')).join('') },
    };
  }
  return null;
}

function storeArt(key, buf, ext, extra) {
  const idx = index();
  const old = idx[key] && idx[key].file;
  fs.mkdirSync(ART_DIR(), { recursive: true });
  const file = artFile(key, ext);
  fs.writeFileSync(file, buf);
  if (old && old !== file) fs.rmSync(old, { force: true });
  idx[key] = { file, ...extra };
  saveIndex();
  return { url: thumb(buf, 400), ...extra };
}

// opts: { force, artist, album } — force searches again even if cached/declined.
async function getArt(title, opts = {}) {
  if (!title || !title.trim()) return null;
  const key = artKey(title);
  const hit = index()[key];
  if (!opts.force && hit) {
    if (hit.file && fs.existsSync(hit.file)) return { url: thumb(fs.readFileSync(hit.file), 400), source: hit.source, manual: !!hit.manual };
    if (hit.cleared) return null;
    if (hit.none && Date.now() - hit.ts < 7 * 864e5) return null;
  }
  if (!opts.force && !loadSettings().onlineArt) return null;
  const q = opts.album !== undefined ? { artist: opts.artist || '', album: opts.album } : splitTitle(title);
  const res = await searchArt(q.artist, q.album);
  if (!res) {
    if (!opts.force) { index()[key] = { none: true, ts: Date.now() }; saveIndex(); }
    return null;
  }
  log(`Found cover art: ${res.source.artist} – ${res.source.title}`);
  return storeArt(key, res.buf, res.ext, { source: res.source });
}

// ---------- lyrics (LRCLIB, falling back to lyrics.ovh; cached on disk)
let lyricsIdx = null;
const LYRICS_FILE = () => path.join(app.getPath('userData'), 'lyrics.json');
function lyricsIndex() {
  if (!lyricsIdx) { try { lyricsIdx = JSON.parse(fs.readFileSync(LYRICS_FILE(), 'utf8')); } catch { lyricsIdx = {}; } }
  return lyricsIdx;
}
const saveLyrics = () => fs.writeFileSync(LYRICS_FILE(), JSON.stringify(lyricsIdx));
const lyricsKey = (artist, title) => `${artist || ''}|${title || ''}`.trim().toLowerCase().replace(/\s+/g, ' ');

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA(), Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${new URL(url).host} replied ${r.status}`);
  return r.json();
}

// Choose the best LRCLIB hit: close in length first, then synced, then closest length.
// Without an artist we insist on a close length match to avoid same-named songs.
function pickLyrics(list, seconds, haveArtist) {
  let c = (list || []).filter((x) => x.plainLyrics || x.syncedLyrics || x.instrumental);
  const diff = (x) => (seconds ? Math.abs((x.duration || 0) - seconds) : 0);
  if (!haveArtist && seconds) c = c.filter((x) => diff(x) <= 5);
  c.sort((a, b) => (diff(a) > 4) - (diff(b) > 4) || !a.syncedLyrics - !b.syncedLyrics || diff(a) - diff(b));
  return c[0] || null;
}

async function findLyrics({ artist = '', title = '', seconds = 0, force = false, cacheAs }) {
  artist = artist.trim(); title = title.trim();
  if (!title) return null;
  const key = cacheAs ? lyricsKey(cacheAs.artist, cacheAs.title) : lyricsKey(artist, title);
  const hit = lyricsIndex()[key];
  if (!force && hit) {
    if (!hit.none) return hit;
    if (Date.now() - hit.ts < 7 * 864e5) return null;
  }
  if (!force && !loadSettings().onlineLyrics) return null;

  let res = null;
  const tries = artist ? [{ artist_name: artist, track_name: title }, { q: `${artist} ${title}` }] : [{ track_name: title }];
  for (const p of tries) {
    const best = pickLyrics(await getJSON('https://lrclib.net/api/search?' + new URLSearchParams(p)), seconds, !!artist);
    if (best) {
      res = { source: 'LRCLIB', artist: best.artistName, title: best.trackName, album: best.albumName, duration: best.duration,
        plain: best.plainLyrics || '', synced: best.syncedLyrics || '', instrumental: !!best.instrumental };
      break;
    }
  }
  if (!res && artist) {
    try {
      const j = await getJSON(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
      if (j && j.lyrics && j.lyrics.trim()) res = { source: 'lyrics.ovh', artist, title, plain: j.lyrics.replace(/\r\n/g, '\n').trim(), synced: '', instrumental: false };
    } catch {} // backup source is often slow/down; ignore
  }
  lyricsIndex()[key] = res || { none: true, ts: Date.now() };
  saveLyrics();
  if (res) log(`Lyrics found for "${title}" (${res.source}${res.synced ? ', synced' : ''})`);
  return res;
}

// ---------- YouTube video search (public results page, no API key) + Spotify album links
const { youtubeSearch } = require('./lib/youtube');
const cd = require('./lib/cd');
const linkCache = new Map(); // in-memory for the session

async function spotifyAlbum({ mbid, artist, album }) {
  const searchUrl = 'https://open.spotify.com/search/' + encodeURIComponent(`${artist || ''} ${album || ''}`.trim());
  const ck = `sp:${mbid}|${artist}|${album}`;
  if (linkCache.has(ck)) return linkCache.get(ck);
  let res = { searchUrl };
  if (mbid) {
    try {
      const j = await mbFetch(`https://musicbrainz.org/ws/2/release?release-group=${mbid}&inc=url-rels&fmt=json&limit=50`);
      const url = (j.releases || []).flatMap((rel) => (rel.relations || []).map((x) => x.url && x.url.resource))
        .find((u) => /^https:\/\/open\.spotify\.com\/album\/[A-Za-z0-9]+/.test(u || ''));
      if (url) {
        const id = url.match(/album\/([A-Za-z0-9]+)/)[1];
        res = { searchUrl, id, url: `https://open.spotify.com/album/${id}`, uri: `spotify:album:${id}` };
        try {
          const o = await getJSON('https://open.spotify.com/oembed?url=' + encodeURIComponent(res.url));
          if (o) { res.title = o.title; res.thumb = o.thumbnail_url; }
        } catch {}
      }
    } catch (e) { log(`Spotify lookup: ${e.message}`); }
  }
  linkCache.set(ck, res);
  return res;
}

// ---------- IPC
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (err) { log(`Error: ${err.message}`); return { ok: false, error: err.message }; }
});

handle('connect', () => exclusive(connect));
handle('disconnect', () => exclusive(disconnect));
handle('read-disc', () => exclusive(readDisc));
handle('status', () => exclusive(() => netmd.getDeviceStatus(requireDevice())));
handle('env', () => ({ atracdenc: !!findAtracdenc(), version: app.getVersion() }));

handle('rename-disc', (title) => exclusive(async () => { await netmd.renameDisc(requireDevice(), cleanTitle(title)); log(`Disc renamed to "${title}"`); }));
handle('rename-track', (index, title) => exclusive(async () => { await requireDevice().setTrackTitle(index, cleanTitle(title)); log(`Track ${index + 1} renamed`); }));
handle('move-track', (from, to) => exclusive(async () => { await requireDevice().moveTrack(from, to); log(`Moved track ${from + 1} → ${to + 1}`); }));
handle('erase-disc', () => exclusive(async () => { await requireDevice().eraseDisc(); log('Disc erased'); }));
handle('delete-tracks', (indexes) => exclusive(async () => {
  const md = requireDevice();
  // Delete from the highest index down so earlier indexes stay valid.
  for (const i of [...indexes].sort((a, b) => b - a)) { await md.eraseTrack(i); log(`Deleted track ${i + 1}`); }
}));
handle('transport', (action) => exclusive(async () => {
  const md = requireDevice();
  const fns = { play: () => md.play(), pause: () => md.pause(), stop: () => md.stop(), next: () => md.nextTrack(), prev: () => md.previousTrack() };
  await fns[action]();
}));

handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add music', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff'] }],
  });
  return r.canceled ? [] : Promise.all(r.filePaths.map(probe));
});
handle('probe-files', (paths) => Promise.all(paths.map(probe)));

handle('save-text', async (suggested, text) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export track list', defaultPath: path.join(app.getPath('documents'), suggested), filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  log(`Exported track list to ${r.filePath}`);
  return r.filePath;
});
handle('open-text', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import track titles', properties: ['openFile'], filters: [{ name: 'CSV / text', extensions: ['csv', 'txt'] }] });
  if (r.canceled) return null;
  const st = fs.statSync(r.filePaths[0]);
  if (st.size > 1024 * 1024) throw new Error('That file is too big to be a track list.');
  return fs.readFileSync(r.filePaths[0], 'utf8');
});

handle('get-art', (title, opts) => getArt(title, opts));
handle('choose-art', async (title) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose cover image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }] });
  if (r.canceled) return null;
  const buf = fs.readFileSync(r.filePaths[0]);
  if (nativeImage.createFromBuffer(buf).isEmpty()) throw new Error('That file isn\'t a readable JPG or PNG image.');
  return storeArt(artKey(title), buf, /\.png$/i.test(r.filePaths[0]) ? 'png' : 'jpg', { manual: true });
});
handle('clear-art', (title) => {
  const key = artKey(title);
  const hit = index()[key];
  if (hit && hit.file) fs.rmSync(hit.file, { force: true });
  index()[key] = { cleared: true };
  saveIndex();
});
handle('get-lyrics', (q) => findLyrics(q));
handle('get-settings', () => loadSettings());
handle('set-settings', (patch) => saveSettings(patch));
handle('youtube-search', (artist, title, seconds) => youtubeSearch(artist, title, seconds));
handle('spotify-album', (q) => spotifyAlbum(q));
// Only open links to the music services this app uses.
handle('open-external', (url) => {
  if (/^https:\/\/(musicbrainz\.org|www\.youtube\.com|open\.spotify\.com)\//.test(url) || /^spotify:album:[A-Za-z0-9]+$/.test(url)) return shell.openExternal(url);
});
handle('cancel-upload', () => { cancelRequested = true; log('Cancelling after the current track…'); });

// ---------- audio CD import
const CD_BIN = () => path.join(app.getPath('userData'), 'bin');
handle('cd-drives', () => cd.drives(CD_BIN()));
handle('cd-eject', (letter) => cd.eject(CD_BIN(), letter));
// Read the CD's table of contents and look it up on MusicBrainz for names and cover art.
handle('cd-read', async (letter) => {
  const t = await cd.toc(CD_BIN(), letter);
  const tracks = cd.audioTracks(t);
  if (!tracks.length) throw new Error('This disc has no audio tracks.');
  let release = null, art = null;
  try {
    ({ release } = await cd.lookup(t, mbFetch));
    if (release) {
      const r = await fetch(`https://coverartarchive.org/release/${release.id}/front-250`, { headers: { 'User-Agent': UA() }, signal: AbortSignal.timeout(10000) });
      if (r.ok) art = thumb(Buffer.from(await r.arrayBuffer()), 250);
    }
  } catch (e) { log(`CD lookup: ${e.message}`); }
  log(release ? `CD recognised: ${release.artist} – ${release.title}` : 'CD not found on MusicBrainz; using track numbers');
  return {
    drive: letter, release, art,
    tracks: tracks.map((tr) => {
      const named = release && release.tracks.find((x) => x.n === tr.n);
      return { n: tr.n, lba: tr.lba, sectors: tr.sectors, seconds: tr.sectors / 75, title: named ? named.title : `Track ${String(tr.n).padStart(2, '0')}`, artist: named ? named.artist : '' };
    }),
  };
});

// Same steps as netmd-js `download()`, with three fixes found while testing on an MZ-N707:
// 1. A fresh encryption worker per track. netmd-js's node-encrypt-worker calls process.exit() after its last
//    chunk, so a reused worker is dead and the second track waits forever for data that never comes.
// 2. A bounded wait for the player to be ready. netmd-js's prepareDownload() waits with no limit for
//    'ready'/'discBlank', and the player sometimes reports operating status 0x56FF ("unknown"), notably after
//    an interrupted transfer. Sending audio in that state stalls, so wait for it to clear, but not forever.
// 3. A stall watchdog: if no audio is accepted for STALL_MS, give up with a clear message instead of hanging.
const BUSY_STATES = new Set(['playing', 'paused', 'fastForward', 'rewind']);
const READY_STATES = new Set(['ready', 'discBlank']);
const STALL_MS = 45000;
class PlayerStalled extends Error {}
async function waitForReady(md, onWaiting) {
  const deadline = Date.now() + 60000;
  let waited = false;
  for (;;) {
    const { state } = await netmd.getDeviceStatus(md);
    if (state === 'noDisc') throw new Error('No disc in the player.');
    if (READY_STATES.has(state)) return;
    if (Date.now() > deadline) { log(`Player still not ready (state: ${state}); trying anyway`); return; }
    if (!waited) { waited = true; log(`Waiting for the player to be ready (state: ${state})…`); onWaiting && onWaiting(); }
    if (BUSY_STATES.has(state)) { try { await md.stop(); } catch {} }
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function downloadTrack(md, title, format, data, onProgress, onWaiting) {
  await waitForReady(md, onWaiting);
  const worker = new Worker(require.resolve('netmd-js/dist/node-encrypt-worker.js'));
  let stallTimer;
  try {
    const track = new netmd.MDTrack(title, format, data, 0x400, '', makeGetAsyncPacketIteratorOnWorkerThread(worker));
    try { await md.sessionKeyForget(); await md.leaveSecureSession(); } catch {}
    await md.acquire();
    try { await md.disableNewTrackProtection(1); } catch {}
    const session = new netmd.MDSession(md);
    await session.init();
    let lastBytes = -1, lastChange = Date.now();
    const stalled = new Promise((_, reject) => {
      stallTimer = setInterval(() => {
        if (lastBytes >= 0 && Date.now() - lastChange > STALL_MS) reject(new PlayerStalled('The player stopped accepting audio.'));
      }, 1000);
    });
    lastBytes = 0;
    const result = await Promise.race([
      session.downloadTrack(track, (p) => {
        if (p.writtenBytes !== lastBytes) { lastBytes = p.writtenBytes; lastChange = Date.now(); }
        // Once all audio is sent the player takes several seconds to save the track; that's not a stall.
        if (p.totalBytes && p.writtenBytes >= p.totalBytes) lastBytes = -1;
        onProgress(p);
      }),
      stalled,
    ]);
    clearInterval(stallTimer);
    await session.close();
    await md.release();
    return result;
  } finally {
    clearInterval(stallTimer);
    await worker.terminate().catch(() => {});
  }
}

// items: [{id, path, title, cd?}], mode: 'SP' | 'LP2' | 'LP4'
handle('upload', (items, mode) => exclusive(async () => {
  const md = requireDevice();
  cancelRequested = false;
  let done = 0;
  for (const item of items) {
    if (cancelRequested) { send('upload-progress', { id: item.id, stage: 'cancelled' }); continue; }
    let ripped = null;
    try {
      let source = item.path;
      if (item.cd) {
        // Read the track off the audio CD into a temporary WAV first.
        send('upload-progress', { id: item.id, stage: 'ripping', pct: 0 });
        log(`Reading CD track ${item.cd.n} from drive ${item.cd.drive}:`);
        ripped = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-cd-')), 'track.wav');
        const { badSectors } = await cd.rip(CD_BIN(), item.cd.drive, item.cd.lba, item.cd.sectors, ripped,
          (pct) => send('upload-progress', { id: item.id, stage: 'ripping', pct }));
        if (badSectors) log(`Warning: ${badSectors} unreadable sector(s) on CD track ${item.cd.n} were replaced with silence (scratched disc?)`);
        source = ripped;
      }
      send('upload-progress', { id: item.id, stage: 'converting', pct: 0 });
      log(`Converting "${item.title}" to ${mode}`);
      const { data, format } = await encode(source, mode);
      if (ripped) { fs.rmSync(path.dirname(ripped), { recursive: true, force: true }); ripped = null; }
      const title = cleanTitle(item.title);
      log(`Transferring "${title}"`);
      send('upload-progress', { id: item.id, stage: 'transferring', pct: 0 });
      await downloadTrack(md, title, format, data,
        ({ writtenBytes, totalBytes }) => send('upload-progress', { id: item.id, stage: 'transferring', pct: totalBytes ? writtenBytes / totalBytes : 0 }),
        () => send('upload-progress', { id: item.id, stage: 'waiting', pct: 0 }));
      send('upload-progress', { id: item.id, stage: 'done', pct: 1 });
      log(`"${title}" is on the disc`);
      done++;
    } catch (err) {
      log(`Failed "${item.title}": ${err.message}`);
      send('upload-progress', { id: item.id, stage: 'error', error: err.message });
      if (!iface) break; // device gone
      if (err instanceof PlayerStalled || isUsbStall(err)) {
        // The player stopped answering mid-transfer; every later track would fail the same way.
        log('The player stopped responding. Unplug it, wait a few seconds, plug it back in, then press Send again.');
        try { await iface.netMd.finalize(); } catch {}
        iface = null;
        send('device-lost');
        break;
      }
    } finally {
      if (ripped) fs.rmSync(path.dirname(ripped), { recursive: true, force: true });
    }
  }
  log(`Upload finished: ${done} of ${items.length} track(s)`);
  return done;
}));

// ---------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    backgroundColor: '#14161c', title: 'RetroDisc', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const page = path.join(__dirname, 'renderer', 'index.html');
  const wc = win.webContents;
  // Self-heal a blank window: occasionally the page process never starts or dies, leaving only the dark background.
  let loaded = false, retries = 0;
  const recover = (why) => {
    loaded = false;
    startupLog(`window recovery (${why}), attempt ${retries + 1}`);
    if (win.isDestroyed() || retries++ >= 3) return;
    setTimeout(() => { if (!win.isDestroyed()) win.loadFile(page); }, 500);
  };
  const watchdog = () => setTimeout(() => { if (!loaded && !win.isDestroyed()) { recover('page did not load in time'); watchdog(); } }, 10000);
  wc.on('did-finish-load', () => { loaded = true; retries = 0; });
  wc.on('did-fail-load', (_e, code, desc, _url, isMain) => { if (isMain) recover(`load failed: ${code} ${desc}`); });
  wc.on('render-process-gone', (_e, d) => recover(`renderer gone: ${d.reason} (${d.exitCode})`));
  wc.on('unresponsive', () => startupLog('page unresponsive'));
  win.loadFile(page);
  watchdog();
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function startupLog(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}
app.on('child-process-gone', (_e, d) => startupLog(`child process gone: ${d.type} ${d.reason} (${d.exitCode})`));

// The app used to be called "MiniDisc Manager". Carry its cached art, lyrics fixes and settings over once.
try {
  const oldDir = path.join(app.getPath('appData'), 'MiniDisc Manager');
  const newDir = app.getPath('userData');
  if (oldDir !== newDir && fs.existsSync(oldDir)) {
    for (const name of ['art', 'bin', 'settings.json', 'lyrics.json']) {
      const from = path.join(oldDir, name), to = path.join(newDir, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
    }
  }
} catch (e) { startupLog(`couldn't copy old settings: ${e.message}`); }

// One copy at a time: a second launch just brings the existing window forward (only one process can hold the player).
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

app.whenReady().then(() => {
  // YouTube embeds refuse to play without a referrer (error 153), and file:// pages send none.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] },
    (d, cb) => { d.requestHeaders.Referer = d.requestHeaders.Referer || 'https://github.com/DeclanGreen/retrodisc'; cb({ requestHeaders: d.requestHeaders }); },
  );
  createWindow();
});
app.on('window-all-closed', async () => { await disconnect(); app.quit(); });
