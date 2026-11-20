// Run with: npx electron promo/make-screenshots.js   (close the installed app first is NOT needed: it never touches the player)
// Takes the promo screenshots with MOCK data only: fictional discs, artists and tracks, generated cover art, a throwaway userData folder, no network, no player.
const { app, BrowserWindow } = require('electron');
const path = require('path'), os = require('os'), fs = require('fs'), crypto = require('crypto');
const OUT = path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-shots-'));
app.setPath('userData', userData);
require(path.join(__dirname, '..', 'main.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK = String.raw`
window.MOCK = (() => {
  const mkTracks = (list) => list.map(([title, sec, enc], i) => ({ index: i, title, seconds: sec, encoding: enc || 'SP', mono: false, protected: false }));
  const mkDisc = (title, list, total = 4800) => {
    const tracks = mkTracks(list);
    const used = tracks.reduce((a, t) => a + t.seconds / ({ SP: 1, LP2: 2, LP4: 4 }[t.encoding]), 0);
    return { title, writable: true, writeProtected: false, usedSec: used, leftSec: total - used, totalSec: total, tracks };
  };
  const A = mkDisc('Neon Harbour - Midnight Signals', [
    ['Neon Harbour - Intro: Static Bloom', 112], ['Neon Harbour - Glass Meridian', 251], ['Neon Harbour - Lantern Season', 238], ['Neon Harbour - Tidewater Radio', 284],
    ['Neon Harbour - Copper Kite', 207], ['Neon Harbour - Velvet Static', 266], ['Neon Harbour - Halfway to Morrow', 312], ['Neon Harbour - Northbound Light', 229],
    ['Neon Harbour - Sundial Hotel', 274], ['Neon Harbour - Echo Garden', 198], ['Neon Harbour - Pale Orchard', 301], ['Neon Harbour - Slow Comet', 345]]);
  const others = [
    mkDisc('Road Trip 2003', [['The Brightside - Open Windows', 214], ['Kestrel Lane - Gravel Roads', 241], ['Marlow Fields - Bluebird', 198], ['Dune Parade - Hot Asphalt', 267], ['Kestrel Lane - Last Exit Diner', 233], ['The Brightside - Radio Wave', 205], ['Marlow Fields - Cassette Summer', 259], ['Dune Parade - Mile 400', 281], ['Kestrel Lane - Homeward', 224], ['The Brightside - Closing Time', 246]]),
    mkDisc('Study Mix', Array.from({ length: 16 }, (_, i) => [['Quiet Rooms', 'Paper Lanterns', 'Soft Machines', 'Winter Garden', 'Low Tide', 'Cardboard Moon', 'Slow Lights', 'Afterhours'][i % 8] + (i > 7 ? ' II' : ''), 230 + (i * 37) % 120, 'LP2'])),
    mkDisc("Dad's Birthday Disc", [['Harbour Lights - Anchor Song', 245], ['Harbour Lights - Saturday Morning', 213], ['The Old Rovers - Ten Pints', 188], ['The Old Rovers - Kitchen Dance', 232], ['Mara Quinn - Evergreen', 276], ['Mara Quinn - Porch Light', 254], ['Harbour Lights - Fair Winds', 301]]),
    mkDisc('Radio Sessions Vol. 2', Array.from({ length: 13 }, (_, i) => ['Session ' + (i + 1) + ' - ' + ['Live Take', 'Acoustic', 'Demo', 'Studio Cut'][i % 4], 180 + (i * 53) % 150])),
  ];
  const cover = (seed) => {
    const c = document.createElement('canvas'); c.width = c.height = 600; const g = c.getContext('2d');
    const hue = [18, 205, 160, 32, 275][seed % 5];
    const bg = g.createLinearGradient(0, 0, 0, 600); bg.addColorStop(0, 'hsl(' + ((hue + 320) % 360) + ' 70% 18%)'); bg.addColorStop(1, 'hsl(' + hue + ' 85% 52%)');
    g.fillStyle = bg; g.fillRect(0, 0, 600, 600);
    if (seed === 0) { g.fillStyle = 'hsl(48 100% 62%)'; g.beginPath(); g.arc(300, 330, 150, 0, 7); g.fill();
      g.fillStyle = 'hsl(330 70% 14%)'; for (let i = 0; i < 7; i++) g.fillRect(120, 300 + i * 22, 360, 4 + i * 2);
      g.fillStyle = 'hsl(330 70% 12%)'; g.fillRect(0, 470, 600, 130); }
    else if (seed === 1) { g.fillStyle = 'rgba(255,255,255,.9)'; for (let i = 0; i < 6; i++) { const y = 330 + i * i * 7; g.fillRect(292 - i * 3, y, 16 + i * 6, 10 + i * 3); } g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.moveTo(0, 600); g.lineTo(300, 300); g.lineTo(600, 600); g.fill(); g.fillStyle = 'rgba(255,255,255,.9)'; for (let i = 0; i < 6; i++) { const y = 330 + i * i * 7; g.fillRect(292 - i * 3, y, 16 + i * 6, 10 + i * 3); } }
    else if (seed === 2) { for (let i = 8; i > 0; i--) { g.fillStyle = 'hsl(' + (hue + i * 9) + ' 70% ' + (22 + i * 6) + '%)'; g.beginPath(); g.arc(300, 300, i * 36, 0, 7); g.fill(); } }
    else if (seed === 3) { g.fillStyle = 'rgba(255,255,255,.85)'; for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(80 + i * 100, 470); g.lineTo(130 + i * 100, 330 - (i % 2) * 70); g.lineTo(180 + i * 100, 470); g.fill(); } g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 470, 600, 130); }
    else { g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 6; for (let r = 0; r < 7; r++) { g.beginPath(); for (let x = 0; x <= 600; x += 10) { const y = 200 + r * 48 + Math.sin(x / 55 + r) * 22; x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); } }
    return c.toDataURL('image/png');
  };
  return { A, others, cover };
})();
0;
`;

app.whenReady().then(async () => {
  await sleep(3000);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1280, 820); win.center();
  const ex = (c) => win.webContents.executeJavaScript(c);
  const shot = async (name) => { await sleep(1400); await ex(`$('log').textContent = ''; $('logBox').open = false; 0`); await sleep(200); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG()); };
  const log = [];
  try {
    await ex(MOCK);
    await ex(`window.md.setSettings({ onlineArt: false, onlineLyrics: false })`);

    // cover art cache for the library (written before the app first reads the art index)
    const all = [await ex('MOCK.A'), ...(await ex('MOCK.others'))];
    const artDir = path.join(userData, 'art'); fs.mkdirSync(artDir, { recursive: true });
    const idx = {};
    for (let i = 0; i < all.length; i++) {
      const url = await ex(`MOCK.cover(${i})`);
      const key = all[i].title.trim().toLowerCase().replace(/\s+/g, ' ');
      const file = path.join(artDir, crypto.createHash('sha1').update(key).digest('hex') + '.png');
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      idx[key] = { file, source: { artist: 'Demo', title: all[i].title }, manual: true };
    }
    fs.writeFileSync(path.join(artDir, 'index.json'), JSON.stringify(idx));

    // library: record the other discs first, the "current" disc last so it is the newest
    for (const d of [...all.slice(1).reverse()]) await ex(`window.md.libraryRecord(MOCK.others.find(x => x.title === ${JSON.stringify(d.title)}), null)`);
    const libId = await ex(`window.md.libraryRecord(MOCK.A, null)`);
    const dadId = (await ex('window.md.libraryList()')).find((e) => e.title.startsWith("Dad's")).id;
    await ex(`window.md.libraryNote(${JSON.stringify(dadId)}, 'Blue case, shelf B')`);

    // common state: a connected player with the main disc, version label blanked
    const base = `
      S.connected = true; S.name = 'Sony MZ-N707'; S.disc = MOCK.A; S.libId = ${JSON.stringify(libId)};
      S.art = { title: MOCK.A.title, url: MOCK.cover(0), source: null, manual: true, loading: false };
      document.getElementById('appVersion').textContent = '';
      S.lastDiscPresent = true;`;

    // 1. main window: vinyl + tonearm playing track 5, queue with LP2 and the capacity bar
    await ex(base + `
      pieStyle = 'vinyl'; S.mode = 'LP2';
      const q = (id, name, title, sec, artIdx) => ({ id, path: 'C:/Music/' + name, name, title, seconds: sec, state: 'queued', art: artIdx == null ? null : MOCK.cover(artIdx) });
      S.queue = [q(9001, '01 - Open Windows.mp3', 'The Brightside - Open Windows', 214, 1), q(9002, '02 - Gravel Roads.mp3', 'Kestrel Lane - Gravel Roads', 241, 1), q(9003, '03 - Bluebird.flac', 'Marlow Fields - Bluebird', 198, 2),
                 q(9004, '04 - Hot Asphalt.mp3', 'Dune Parade - Hot Asphalt', 267, 3), q(9005, '05 - Last Exit Diner.m4a', 'Kestrel Lane - Last Exit Diner', 233, 1), q(9006, '06 - Radio Wave.mp3', 'The Brightside - Radio Wave', 205, 1)];
      S.sel = new Set([4]); S.playingTrack = 4; S.pos = { track: 4, sec: 71, at: performance.now(), playing: true };
      setTab('transfer'); render(); kickSpin();`);
    await shot('01-main-vinyl.png');

    // 2. MiniDisc pie, nothing playing, a track selected
    await ex(`pieStyle = 'md'; S.queue = []; S.playingTrack = null; S.pos = { track: null, sec: 0, at: performance.now(), playing: false }; S.sel = new Set([2]); render();`);
    await shot('02-minidisc-pie.png');

    // 3. synced lyrics for the playing track (fictional words)
    const LRC = [[8, 'Static on the harbour, a signal in the rain'], [14, 'Lanterns on the water, call me home again'], [21, 'Tune the dial slowly, hold the wire tight'],
      [28, 'Midnight on the tide line, everything feels right'], [36, ''], [40, 'Tidewater radio, play it low'], [46, 'Tidewater radio, let the whole world go'],
      [53, 'Count the little lights along the bay'], [60, 'Every one a message that was sent my way'], [68, 'Tidewater radio, play it low'], [74, 'Tidewater radio, let the whole world go']];
    const lrc = LRC.map(([t, s]) => '[' + String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0') + '.00] ' + s).join('\n');
    await ex(`
      pieStyle = 'vinyl'; S.sel = new Set([3]); S.playingTrack = 3; S.pos = { track: 3, sec: 49, at: performance.now(), playing: true }; render();
      const tg = lyricsTarget();
      S.ly = { key: (tg.index + '|' + tg.artist + '|' + tg.title).toLowerCase(), target: tg, loading: false, error: null, cur: -1,
               data: { source: 'LRCLIB', synced: ${JSON.stringify(lrc)}, plain: '', artist: tg.artist, title: tg.title }, lines: parseLRC(${JSON.stringify(lrc)}) };
      setTab('lyrics'); drawLyrics();`);
    await sleep(800); await shot('03-lyrics.png');

    // 4. library tab, one disc open
    await ex(`
      S.playingTrack = null; S.pos = { track: null, sec: 0, at: performance.now(), playing: false }; pieStyle = 'vinyl';
      setTab('library');`);
    await sleep(900);
    await ex(`LIB.open.add(${JSON.stringify(dadId)}); drawLibrary(true);`);
    await sleep(700); await ex(`document.querySelector('.lib-card.open .lib-actions').scrollIntoView({ block: 'end' }); 0`);
    await shot('04-library.png');

    // 5. printable inlay preview window
    await ex(`setTab('transfer'); render(); inlayDisc(S.disc, S.art.url);`);
    await sleep(2500);
    const inlay = BrowserWindow.getAllWindows().find((w) => w !== win && w.getTitle().startsWith('Inlay'));
    if (inlay) { inlay.setSize(920, 640); await sleep(600); fs.writeFileSync(path.join(OUT, '05-inlay.png'), (await inlay.webContents.capturePage({ x: 0, y: 0, width: 920, height: 560 })).toPNG()); log.push('inlay ok'); } else log.push('inlay window not found');
    log.push('done');
  } catch (e) { log.push('ERROR ' + e.stack); }
  fs.writeFileSync(path.join(__dirname, 'shots.log'), log.join('\n'));
  app.exit(0);
});
