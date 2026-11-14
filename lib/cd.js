// Audio-CD support: drive listing, TOC, ripping (via the cdrip helper) and
// MusicBrainz disc lookup for album/track names.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SRC = path.join(__dirname, 'cdrip.cs');
const CSC = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find((p) => fs.existsSync(p));

let helperPath = null;
// Compile cdrip.cs once per source version into binDir.
async function helper(binDir) {
  if (helperPath && fs.existsSync(helperPath)) return helperPath;
  if (process.platform !== 'win32') throw new Error('CD import currently works on Windows only.');
  if (!CSC) throw new Error('CD import needs the .NET Framework C# compiler (csc.exe), which wasn\'t found.');
  const src = fs.readFileSync(SRC, 'utf8');
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const out = path.join(binDir, `cdrip-${hash}.exe`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(binDir, { recursive: true });
    const tmpSrc = path.join(binDir, `cdrip-${hash}.cs`); // source may live inside app.asar
    fs.writeFileSync(tmpSrc, src);
    await new Promise((resolve, reject) => execFile(CSC, ['/nologo', '/optimize', '/target:exe', `/out:${out}`, tmpSrc], { windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error('Couldn\'t build the CD reader: ' + (stdout || stderr || err.message).trim())) : resolve())));
    fs.rmSync(tmpSrc, { force: true });
  }
  return (helperPath = out);
}

function runJSON(exe, args) {
  return new Promise((resolve, reject) => execFile(exe, args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return reject(new Error((stderr || err.message).trim()));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Unexpected reply from the CD reader.')); }
  }));
}

const drives = async (binDir) => runJSON(await helper(binDir), ['drives']);
const toc = async (binDir, letter) => runJSON(await helper(binDir), ['toc', letter]);
const eject = async (binDir, letter) => new Promise(async (res) => execFile(await helper(binDir), ['eject', letter], { windowsHide: true }, () => res()));

// Rip sectors [lba, lba+count) to a WAV file. onProgress(0..1). Returns { badSectors }.
async function rip(binDir, letter, lba, count, outWav, onProgress) {
  const exe = await helper(binDir);
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['read', letter, String(lba), String(count), outWav], { windowsHide: true });
    let err = '', bad = 0, buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = line.match(/^P (\d+) (\d+)$/);
        if (m) onProgress && onProgress(+m[1] / +m[2]);
        const b = line.match(/^BAD (\d+)$/);
        if (b) bad = +b[1];
      }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ badSectors: bad }) : reject(new Error(err.trim() || `CD read failed (${code})`))));
  });
}

// Audio tracks with start sector and length. Lengths stop before a following data track.
function audioTracks(t) {
  const list = t.tracks;
  return list.map((tr, i) => {
    const next = i + 1 < list.length ? list[i + 1].lba : t.leadout;
    // Enhanced CDs: the session gap before a data track is 11400 sectors.
    const end = i + 1 < list.length && !list[i + 1].audio ? next - 11400 : next;
    return { n: tr.n, lba: tr.lba, sectors: Math.max(0, end - tr.lba), audio: tr.audio };
  }).filter((x) => x.audio && x.sectors > 0);
}

// MusicBrainz disc ID: SHA-1 over first/last track, lead-out and 99 track offsets, base64 with MB's alphabet.
function discId(t) {
  let s = hex2(t.first) + hex2(t.last) + hex8(t.leadout + 150);
  for (let i = 1; i <= 99; i++) {
    const tr = t.tracks.find((x) => x.n === i);
    s += hex8(tr ? tr.lba + 150 : 0);
  }
  return crypto.createHash('sha1').update(s, 'ascii').digest('base64').replace(/\+/g, '.').replace(/\//g, '_').replace(/=/g, '-');
}
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, '0');
const tocString = (t) => [t.first, t.last, t.leadout + 150, ...t.tracks.map((x) => x.lba + 150)].join('+');

// Look the disc up on MusicBrainz (exact disc ID, falling back to a fuzzy TOC match).
async function lookup(t, mbFetch) {
  const id = discId(t);
  let j;
  try {
    j = await mbFetch(`https://musicbrainz.org/ws/2/discid/${id}?toc=${tocString(t)}&inc=recordings+artist-credits&fmt=json`);
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
    return { discId: id, release: null };
  }
  const credit = (ac) => (ac || []).map((a) => a.name + (a.joinphrase || '')).join('');
  const nTracks = t.tracks.length;
  for (const rel of j.releases || []) {
    const medium = (rel.media || []).find((m) => (m.discs || []).some((d) => d.id === id))
      || (rel.media || []).find((m) => (m['track-count'] || (m.tracks || []).length) === nTracks);
    if (!medium || !medium.tracks) continue;
    const albumArtist = credit(rel['artist-credit']);
    return {
      discId: id,
      release: {
        id: rel.id, title: rel.title, artist: albumArtist, date: rel.date || '',
        disc: (rel.media || []).length > 1 ? medium.position : null,
        tracks: medium.tracks.map((tr) => ({ n: tr.position, title: tr.title, artist: credit(tr['artist-credit']) || albumArtist })),
      },
    };
  }
  return { discId: id, release: null };
}

module.exports = { drives, toc, eject, rip, audioTracks, discId, lookup };
