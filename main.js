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
// atracdenc.exe on Windows, a plain `atracdenc` binary on macOS/Linux.
const ATRACDENC_NAME = process.platform === 'win32' ? 'atracdenc.exe' : 'atracdenc';
const ATRACDENC_CANDIDATES = [
  path.join(process.resourcesPath || '', 'bin', ATRACDENC_NAME),
  path.join(__dirname, 'bin', ATRACDENC_NAME),
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
  if (!enc) throw new Error(`LP2/LP4 need ${ATRACDENC_NAME} in the app's bin folder (see README).`);
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
  if (!opts.force && (opts.cacheOnly || !loadSettings().onlineArt)) return null;
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
handle('transport', (action, track) => exclusive(async () => {
  const md = requireDevice();
  // Play can start a chosen track: jump to it first (track is the 0-based disc index), then play.
  const fns = { play: async () => { if (Number.isInteger(track) && track >= 0) await md.gotoTrack(track); await md.play(); }, pause: () => md.pause(), stop: () => md.stop(), next: () => md.nextTrack(), prev: () => md.previousTrack() };
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

// ---------- folders and playlists (.m3u / .m3u8 / .pls) -> ordered list of audio files
const AUDIO_RE = /\.(mp3|flac|wav|m4a|aac|ogg|opus|wma|aiff?)$/i;
const PLAYLIST_RE = /\.(m3u8?|pls)$/i;
const MAX_FILES = 500;
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function walkAudio(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => naturalSort(a.name, b.name));
  // Files in this folder first, then sub-folders (so a "Disc 1/Disc 2" layout stays in order).
  for (const e of entries) if (e.isFile() && AUDIO_RE.test(e.name)) out.push(path.join(dir, e.name));
  for (const e of entries) if (e.isDirectory()) walkAudio(path.join(dir, e.name), out);
}

function readPlaylist(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes('�')) text = fs.readFileSync(file, 'latin1'); // old .m3u files are often ANSI
  const base = path.dirname(file);
  const isPls = /\.pls$/i.test(file);
  const entries = [];
  for (let line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (isPls) { const m = /^File\d+=(.+)$/i.exec(line); if (!m) continue; line = m[1].trim(); }
    else if (!line || line.startsWith('#')) continue;
    if (/^https?:|^rtsp:|^mms:/i.test(line)) { entries.push({ missing: line }); continue; } // streams can't be recorded
    if (/^file:\/\//i.test(line)) { try { line = decodeURIComponent(new URL(line).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch { /* keep as is */ } }
    entries.push({ path: path.resolve(base, line.replace(/\\/g, path.sep)) });
  }
  return entries;
}

function expandPaths(inputs) {
  const files = [], missing = [], seen = new Set();
  const add = (p) => { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); files.push(p); } };
  for (const p of inputs) {
    let st;
    try { st = fs.statSync(p); } catch { missing.push(p); continue; }
    if (st.isDirectory()) { const found = []; walkAudio(p, found); found.forEach(add); }
    else if (PLAYLIST_RE.test(p)) {
      for (const e of readPlaylist(p)) {
        if (e.missing) { missing.push(e.missing); continue; }
        if (AUDIO_RE.test(e.path) && fs.existsSync(e.path)) add(e.path); else missing.push(e.path);
      }
    } else if (AUDIO_RE.test(p)) add(p);
  }
  return { files: files.slice(0, MAX_FILES), missing, truncated: Math.max(0, files.length - MAX_FILES) };
}

// kind: 'folder' | 'playlist'
handle('pick-folder-or-playlist', async (kind) => {
  const r = await dialog.showOpenDialog(win, kind === 'folder'
    ? { title: 'Add a folder of music', properties: ['openDirectory'] }
    : { title: 'Add a playlist', properties: ['openFile'], filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8', 'pls'] }] });
  return r.canceled ? null : r.filePaths;
});
handle('expand-and-probe', async (paths) => {
  const { files, missing, truncated } = expandPaths(paths);
  log(`Expanded ${paths.length} item(s) to ${files.length} file(s)${missing.length ? `, ${missing.length} missing` : ''}`);
  return { items: await Promise.all(files.map(probe)), missing: missing.length, truncated };
});

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

// ---------- disc library: every disc seen in the player is remembered, so it can be browsed without the disc or player
const LIBRARY_FILE = () => path.join(app.getPath('userData'), 'library.json');
let library = null;
function libraryData() {
  if (!library) { try { library = JSON.parse(fs.readFileSync(LIBRARY_FILE(), 'utf8')); } catch { library = {}; } }
  if (!Array.isArray(library.discs)) library.discs = [];
  return library;
}
function saveLibrary() {
  const tmp = LIBRARY_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(library, null, 1));
  fs.renameSync(tmp, LIBRARY_FILE());
}
const trackSig = (t) => `${t.title}|${Math.round(t.seconds)}|${t.encoding}|${t.mono ? 1 : 0}`;
const discSig = (title, tracks) => crypto.createHash('sha1').update(title + '\n' + tracks.map(trackSig).join('\n')).digest('hex');
// Record the disc just read. Discs have no ID of their own, so: identical contents -> same entry; otherwise, if the app itself just
// edited the disc (prevId) and most of its tracks are still there, update that entry; otherwise it is a new disc.
function recordDisc(d, prevId) {
  if (!d || (!d.title.trim() && !d.tracks.length)) return null;   // blank disc: nothing worth remembering
  const lib = libraryData(), now = Date.now();
  const tracks = d.tracks.map((t) => ({ title: t.title, seconds: t.seconds, encoding: t.encoding, mono: !!t.mono }));
  const sig = discSig(d.title, tracks);
  let e = lib.discs.find((x) => x.sig === sig);
  if (!e && prevId) {
    const prev = lib.discs.find((x) => x.id === prevId);
    if (prev) {
      const old = new Map();
      for (const t of prev.tracks) { const k = Math.round(t.seconds); old.set(k, (old.get(k) || 0) + 1); }
      let same = 0;
      for (const t of tracks) { const k = Math.round(t.seconds); if (old.get(k) > 0) { same++; old.set(k, old.get(k) - 1); } }
      if (!prev.tracks.length || same * 2 >= prev.tracks.length) e = prev;
    }
  }
  if (!e) { e = { id: crypto.randomUUID(), firstSeen: now, note: '' }; lib.discs.push(e); }
  Object.assign(e, { sig, title: d.title, tracks, usedSec: d.usedSec, totalSec: d.totalSec, lastSeen: now });
  saveLibrary();
  return e.id;
}
handle('library-record', (d, prevId) => recordDisc(d, prevId));
handle('library-list', () => [...libraryData().discs].sort((a, b) => b.lastSeen - a.lastSeen));
handle('library-remove', (id) => { const lib = libraryData(); lib.discs = lib.discs.filter((x) => x.id !== id); saveLibrary(); return true; });
handle('library-note', (id, note) => {
  const e = libraryData().discs.find((x) => x.id === id);
  if (e) { e.note = String(note || '').slice(0, 200); saveLibrary(); }
  return true;
});

// Save the whole library: CSV (one row per track, opens in Excel) or JSON (a full copy of library.json). The file extension picks the format.
handle('library-export', async () => {
  const discs = [...libraryData().discs].sort((a, b) => a.title.localeCompare(b.title));
  if (!discs.length) throw new Error('The library is empty.');
  const r = await dialog.showSaveDialog(win, { title: 'Export library', defaultPath: path.join(app.getPath('documents'), 'RetroDisc library.csv'),
    filters: [{ name: 'CSV (spreadsheet)', extensions: ['csv'] }, { name: 'JSON (full backup)', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  let out;
  if (/\.json$/i.test(r.filePath)) out = JSON.stringify(libraryData(), null, 1);
  else {
    const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const mmss = (s) => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const rows = [['Disc', 'Note', 'Last seen', 'Track', 'Title', 'Mode', 'Length']];
    for (const d of discs) {
      const seen = new Date(d.lastSeen).toISOString().slice(0, 10);
      if (!d.tracks.length) rows.push([d.title, d.note, seen, '', '', '', '']);
      d.tracks.forEach((t, i) => rows.push([d.title, d.note, seen, i + 1, t.title, t.encoding + (t.mono ? ' mono' : ''), mmss(t.seconds)]));
    }
    out = '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  fs.writeFileSync(r.filePath, out, 'utf8');
  log(`Exported library (${discs.length} discs) to ${r.filePath}`);
  return { path: r.filePath, count: discs.length };
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

// ---------- printable inlay (case insert) ----------
// Builds a self-contained HTML page (it has no CSP, so it can carry its own styles and a Print button) and shows it in a preview window.
// Layout (approximate standard MiniDisc case insert, in mm; adjust the --w/--h variables in the page if your case differs):
// front cover 68 x 72 (art, title, pie), track-list card 68 x 72, and a spine strip.
const escHtml = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inlayPie(tracks, queuedFrac, usedPct) {
  const C = 80, R = 74, r = 31, pt = (rad, f) => [C + rad * Math.sin(f * 2 * Math.PI), C - rad * Math.cos(f * 2 * Math.PI)];
  const seg = (f0, f1, fill) => {
    if (f1 - f0 < 0.0005) return '';
    if (f1 - f0 >= 0.9999) f1 = f0 + 0.9999;
    const [x0, y0] = pt(R, f0), [x1, y1] = pt(R, f1), [x2, y2] = pt(r, f1), [x3, y3] = pt(r, f0), big = f1 - f0 > 0.5 ? 1 : 0;
    return `<path d="M${x0} ${y0}A${R} ${R} 0 ${big} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${big} 0 ${x3} ${y3}Z" fill="${fill}" stroke="#fff" stroke-width="1"/>`;
  };
  let f = 0, out = `<circle cx="${C}" cy="${C}" r="${R + 4}" fill="#e9ecf2" stroke="#b9bfcc"/><circle cx="${C}" cy="${C}" r="${R}" fill="#d5d9e2"/>`;
  for (const t of tracks) {
    out += seg(f, f + t.frac, t.color);
    if (t.frac >= 0.022) { const [lx, ly] = pt((R + r) / 2 + 4, f + t.frac / 2); out += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central" font-size="${t.frac >= 0.04 ? 10 : 7}" font-weight="700" fill="#fff" stroke="#0006" stroke-width="2" paint-order="stroke">${t.n}</text>`; }
    f += t.frac;
  }
  if (queuedFrac > 0) out += seg(f, f + queuedFrac, '#f2b04d');
  return out + `<circle cx="${C}" cy="${C}" r="${r}" fill="#fff" stroke="#b9bfcc"/><circle cx="${C}" cy="${C}" r="9" fill="none" stroke="#b9bfcc" stroke-dasharray="2 3"/>`
    + `<text x="${C}" y="${C - 2}" text-anchor="middle" dominant-baseline="central" font-size="17" font-weight="700" fill="#222">${usedPct}%</text><text x="${C}" y="${C + 14}" text-anchor="middle" font-size="8" fill="#666">full</text>`;
}
function buildInlayHtml(d) {
  const n = d.tracks.length, cols = n > 12 ? 2 : 1, rowPt = Math.max(5.2, Math.min(cols === 2 ? 7.2 : 8.5, 52 / Math.ceil(n / cols) * 1.9));
  const rows = d.tracks.map((t) => `<li><i style="background:${escHtml(t.color)}"></i><b>${t.n}</b><span class="tt">${escHtml(t.title)}</span><em>${escHtml(t.time)}</em></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inlay – ${escHtml(d.title)}</title><style>
  :root { --w: 68mm; --h: 72mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: #e6e8ee; color: #1b1e26; }
  .bar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: #1a1d25; color: #fff; font-size: 13px; z-index: 2; }
  .bar button { font: inherit; padding: 7px 16px; border-radius: 7px; border: 0; background: #4fb3ff; color: #00192e; font-weight: 600; cursor: pointer; }
  .bar span { color: #aeb4c4; }
  .sheet { width: 210mm; min-height: 297mm; margin: 14px auto; background: #fff; padding: 14mm 15mm; box-shadow: 0 4px 22px #0003; }
  .cards { display: flex; flex-wrap: wrap; gap: 0; align-items: flex-start; }
  .card { width: var(--w); height: var(--h); border: 0.25mm dashed #888; position: relative; overflow: hidden; margin: 0 0 0 0; }
  .spine { width: calc(var(--w) * 2); height: 8mm; border: 0.25mm dashed #888; border-top: 0; display: flex; align-items: center; padding: 0 3mm; font-size: 8pt; font-weight: 700; gap: 3mm; white-space: nowrap; overflow: hidden; }
  .spine small { font-weight: 400; color: #555; }
  .front { background: #11141b; color: #fff; display: flex; flex-direction: column; }
  .front .art { flex: none; height: 44mm; background: #222 center / cover no-repeat; }
  .front .noart { flex: none; height: 44mm; display: grid; place-items: center; background: linear-gradient(145deg, #4fb3ff, #8e7bff); font-size: 30pt; opacity: .9; }
  .front .info { flex: 1; padding: 2.5mm 3mm; display: flex; align-items: center; gap: 3mm; min-height: 0; }
  .front .info svg { width: 22mm; height: 22mm; flex: none; }
  .front h1 { font-size: 11pt; line-height: 1.15; margin: 0 0 1mm; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
  .front p { margin: 0; font-size: 7pt; color: #aeb4c4; }
  .list { padding: 3mm 3.5mm; background: #fff; }
  .list h2 { font-size: 8.5pt; margin: 0 0 1.5mm; padding-bottom: 1mm; border-bottom: 0.3mm solid #222; display: flex; justify-content: space-between; gap: 2mm; }
  .list h2 span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .list h2 small { font-weight: 400; color: #555; flex: none; }
  .list ol { list-style: none; margin: 0; padding: 0; column-count: ${cols}; column-gap: 3mm; font-size: ${rowPt.toFixed(1)}pt; }
  .list li { display: flex; align-items: baseline; gap: 1.2mm; line-height: 1.5; break-inside: avoid; }
  .list li i { flex: none; width: 1.8mm; height: 1.8mm; border-radius: 50%; align-self: center; }
  .list li b { flex: none; width: 4.4mm; text-align: right; color: #555; font-weight: 600; }
  .list li .tt { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .list li em { flex: none; font-style: normal; color: #555; font-variant-numeric: tabular-nums; }
  .note { font-size: 8pt; color: #777; margin-top: 8mm; }
  @media print { body { background: #fff; } .bar, .note { display: none; } .sheet { margin: 0; box-shadow: none; width: auto; min-height: 0; padding: 12mm 12mm; } @page { size: A4; margin: 0; } }
  </style></head><body>
  <div class="bar"><button onclick="window.print()">Print…</button><span>Choose "Microsoft Print to PDF" in the print dialog to save it as a PDF. Print at 100% scale, then cut along the dashed lines.</span></div>
  <div class="sheet"><div class="cards">
    <div class="card front">${d.art ? `<div class="art" style="background-image:url('${escHtml(d.art)}')"></div>` : '<div class="noart">♪</div>'}
      <div class="info"><svg viewBox="0 0 160 160">${inlayPie(d.tracks, d.queuedFrac || 0, d.usedPct)}</svg><div><h1>${escHtml(d.title || 'Untitled disc')}</h1><p>${n} track${n === 1 ? '' : 's'} · ${escHtml(d.used)} of ${escHtml(d.total)}</p></div></div></div>
    <div class="card list"><h2><span>${escHtml(d.title || 'Untitled disc')}</span><small>${escHtml(d.used)}</small></h2><ol>${rows}</ol></div>
    <div class="spine"><b>${escHtml(d.title || 'Untitled disc')}</b><small>${n} tracks · ${escHtml(d.used)}</small></div>
  </div><p class="note">The cards are sized for a standard MiniDisc case insert (about 68 × 72 mm), but cases vary. Check one against your case before cutting a lot of them.</p></div></body></html>`;
}
handle('print-inlay', (d) => {
  const file = path.join(app.getPath('temp'), 'retrodisc-inlay.html');
  fs.writeFileSync(file, buildInlayHtml(d), 'utf8');
  const w = new BrowserWindow({ width: 920, height: 900, title: 'Inlay – ' + (d.title || 'MiniDisc'), autoHideMenuBar: true, parent: win, backgroundColor: '#e6e8ee', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadFile(file);
  log(`Opened the inlay preview for "${d.title || 'MiniDisc'}"`);
});

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
