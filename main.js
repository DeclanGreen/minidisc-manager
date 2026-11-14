// MiniDisc Manager — Electron main process.
// Owns the USB connection to the NetMD player (via netmd-js + node-usb) and
// all audio conversion (ffmpeg for decoding, atracdenc for LP2/LP4 encoding).
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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
const webusb = new WebUSB({
  allowedDevices: netmd.DevicesIds.map(({ vendorId, deviceId }) => ({ vendorId, productId: deviceId })),
  deviceTimeout: 1000000,
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
  const folded = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return sanitizeHalfWidthTitle(folded).slice(0, 120);
}

async function probe(file) {
  const mm = await import('music-metadata');
  let title = path.basename(file, path.extname(file));
  let seconds = 0;
  try {
    const meta = await mm.parseFile(file, { duration: true, skipCovers: true });
    const { artist, title: t } = meta.common;
    if (t) title = artist ? `${artist} - ${t}` : t;
    seconds = meta.format.duration || 0;
  } catch {}
  return { path: file, name: path.basename(file), title, seconds };
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
handle('cancel-upload', () => { cancelRequested = true; log('Cancelling after the current track…'); });

// items: [{id, path, title}], mode: 'SP' | 'LP2' | 'LP4'
handle('upload', (items, mode) => exclusive(async () => {
  const md = requireDevice();
  cancelRequested = false;
  const worker = new Worker(require.resolve('netmd-js/dist/node-encrypt-worker.js'));
  const encryptor = makeGetAsyncPacketIteratorOnWorkerThread(worker);
  let done = 0;
  try {
    for (const item of items) {
      if (cancelRequested) { send('upload-progress', { id: item.id, stage: 'cancelled' }); continue; }
      try {
        send('upload-progress', { id: item.id, stage: 'converting', pct: 0 });
        log(`Converting "${item.title}" to ${mode}`);
        const { data, format } = await encode(item.path, mode);
        const title = cleanTitle(item.title);
        const track = new netmd.MDTrack(title, format, data, 0x400, '', encryptor);
        log(`Transferring "${title}"`);
        await netmd.download(md, track, ({ writtenBytes, totalBytes }) => {
          send('upload-progress', { id: item.id, stage: 'transferring', pct: totalBytes ? writtenBytes / totalBytes : 0 });
        });
        send('upload-progress', { id: item.id, stage: 'done', pct: 1 });
        done++;
      } catch (err) {
        log(`Failed "${item.title}": ${err.message}`);
        send('upload-progress', { id: item.id, stage: 'error', error: err.message });
        if (!iface) break; // device gone
      }
    }
  } finally {
    await worker.terminate();
  }
  log(`Upload finished: ${done} of ${items.length} track(s)`);
  return done;
}));

// ---------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    backgroundColor: '#14161c', title: 'MiniDisc Manager', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', async () => { await disconnect(); app.quit(); });
