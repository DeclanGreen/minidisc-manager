// RetroDisc — renderer (UI only; all device work goes through window.md)
const $ = (id) => document.getElementById(id);
const S = {
  connected: false, name: '', disc: null, sel: new Set(), anchor: null,
  queue: [], mode: 'SP', busy: false, uploading: false, atracdenc: false,
  lastDiscPresent: null, playingTrack: null,
  art: { title: null, url: null, source: null, loading: false },
  tab: 'transfer',
  ly: { key: null, target: null, data: null, lines: null, loading: false, error: null, cur: -1 },
  pos: { track: null, sec: 0, at: 0, playing: false },
};
const MODE_FACTOR = { SP: 1, LP2: 2, LP4: 4 };
let nextId = 1;

const fmt = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.className = 'toast'), 3200);
}

async function busy(label, fn) {
  if (S.busy) return;
  S.busy = true; render(label);
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { S.busy = false; render(); }
}

// ---------- rendering
function render(busyLabel) {
  const dev = $('device');
  dev.className = 'device' + (S.connected ? (S.busy || S.uploading ? ' busy' : ' on') : '');
  $('deviceText').textContent = busyLabel || (S.connected ? S.name : 'No player connected');
  $('connectBtn').textContent = S.connected ? 'Disconnect' : 'Connect player';
  $('connectBtn').className = S.connected ? 'ghost' : 'primary';
  $('connectBtn').disabled = S.uploading;
  $('refreshBtn').disabled = !S.connected || S.busy || S.uploading;
  document.querySelectorAll('#transport button').forEach((b) => (b.disabled = !S.connected || S.uploading));

  const d = S.disc;
  const canEdit = S.connected && d && d.writable && !d.writeProtected && !S.busy && !S.uploading;
  $('discArt').classList.toggle('loaded', !!d);
  $('discArtLabel').textContent = d ? d.title || 'Untitled' : 'MD';
  const artUrl = d && S.art.title === d.title ? S.art.url : null;
  const img = $('discImg');
  if (artUrl) { if (img.src !== artUrl) img.src = artUrl; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  $('discArt').classList.toggle('has-art', !!artUrl);
  $('discArt').disabled = !d;
  $('artSpin').hidden = !(d && S.art.loading);
  const bd = $('discBackdrop');
  bd.classList.toggle('on', !!artUrl);
  if (artUrl) bd.style.backgroundImage = `url("${artUrl}")`;
  $('discArt').title = !d ? '' : artUrl && S.art.source ? `${S.art.source.artist} – ${S.art.source.title} (MusicBrainz) · click to change` : 'Album art: click to find or choose';
  $('discTitle').textContent = d ? d.title || 'Untitled disc' : S.connected ? 'No disc' : '—';
  $('discSub').textContent = !S.connected ? 'Connect your NetMD player and insert a disc.'
    : !d ? 'Insert a disc into the player.'
    : `${d.tracks.length} track${d.tracks.length === 1 ? '' : 's'} · ${fmt(d.totalSec)} disc` + (d.writeProtected ? ' · write-protected (slide the tab to record)' : '');
  $('eraseBtn').disabled = !canEdit || !d.tracks.length;
  $('exportBtn').disabled = !d || S.busy || S.uploading;
  $('importBtn').disabled = !canEdit;
  $('deleteBtn').disabled = !canEdit || !S.sel.size;
  $('deleteBtn').textContent = S.sel.size > 1 ? `Delete ${S.sel.size} tracks` : 'Delete selected';

  // capacity
  const total = d?.totalSec || 1;
  const queuedSec = S.queue.filter((q) => q.state === 'queued' || q.state === 'error').reduce((a, q) => a + q.seconds, 0) / MODE_FACTOR[S.mode];
  const left = d?.leftSec || 0;
  $('capUsed').style.width = d ? `${(d.usedSec / total) * 100}%` : '0';
  $('capPending').style.width = d ? `${(Math.min(queuedSec, left) / total) * 100}%` : '0';
  $('capPending').classList.toggle('over', !!d && queuedSec > left);
  $('capUsedTxt').textContent = fmt(d?.usedSec || 0);
  $('capPendingTxt').textContent = fmt(queuedSec);
  $('capFreeTxt').textContent = fmt(Math.max(0, left - queuedSec));
  $('capFreeModes').textContent = d ? `≈ ${fmt(left * 2)} in LP2 · ${fmt(left * 4)} in LP4` : '';

  const share = trackShares(d);
  renderTrackMap(d, share, queuedSec, left);
  renderTracks(canEdit, share);
  renderQueue(d, queuedSec, left);
  syncLyrics();
}

// How much of the disc each track takes, in disc seconds. A track plays for t.seconds but LP2/LP4 (and mono SP) pack it into a half/quarter of the space, so weight by
// seconds / compression, then scale so the weights add up to the disc's real used time (that absorbs any rounding or header overhead).
function trackShares(d) {
  const out = new Map();
  if (!d || !d.tracks.length) return out;
  const w = d.tracks.map((t) => t.seconds / (MODE_FACTOR[t.encoding] || 1) / (t.mono && t.encoding === 'SP' ? 2 : 1));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const k = d.usedSec > 0 ? d.usedSec / sum : 1;
  // Hues step by the golden angle so neighbouring tracks always differ; the last track must also differ from the first, because they meet at 12 o'clock.
  const n = d.tracks.length, hues = d.tracks.map((_, i) => (205 + i * 137.508) % 360);
  const gap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  if (n > 2 && gap(hues[n - 1], hues[0]) < 60) hues[n - 1] = (hues[n - 1] + 90) % 360;
  if (n > 2 && gap(hues[n - 1], hues[n - 2]) < 40) hues[n - 1] = (hues[n - 1] + 180) % 360;
  d.tracks.forEach((t, i) => out.set(t.index, { sec: w[i] * k, frac: (w[i] * k) / (d.totalSec || 1), color: `hsl(${hues[i].toFixed(0)} 62% ${i % 2 ? 52 : 44}%)` }));
  return out;
}
// The disc drawn as a MiniDisc-style pie: a ring split into one slice per track (clockwise from 12 o'clock), then the queued slice and the free space.
const SVGNS = 'http://www.w3.org/2000/svg';
function renderTrackMap(d, share, queuedSec, left) {
  const map = $('trackMap');
  map.textContent = '';
  map.classList.toggle('hidden', !d);
  if (!d) return;
  const total = d.totalSec || 1, C = 80, R = 74, r = 31;               // centre, outer radius of the data ring, radius of the hub hole
  const el = (name, attrs = {}, parent = svg) => { const n = document.createElementNS(SVGNS, name); for (const k in attrs) n.setAttribute(k, attrs[k]); parent.appendChild(n); return n; };
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 160 160'); svg.setAttribute('class', 'discsvg'); map.appendChild(svg);
  const pt = (rad, f) => [C + rad * Math.sin(f * 2 * Math.PI), C - rad * Math.cos(f * 2 * Math.PI)];
  const slice = (f0, f1) => {                                          // a ring segment from fraction f0 to f1
    if (f1 - f0 >= 0.9999) f1 = f0 + 0.9999;
    const [x0, y0] = pt(R, f0), [x1, y1] = pt(R, f1), [x2, y2] = pt(r, f1), [x3, y3] = pt(r, f0), big = f1 - f0 > 0.5 ? 1 : 0;
    return `M${x0} ${y0}A${R} ${R} 0 ${big} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${big} 0 ${x3} ${y3}Z`;
  };
  el('circle', { cx: C, cy: C, r: R + 4, class: 'disc-shell' });          // the clear MD cartridge-style rim
  el('circle', { cx: C, cy: C, r: R, class: 'disc-base' });                // the unrecorded surface
  let f = 0;
  d.tracks.forEach((t) => {
    const sh = share.get(t.index); if (!sh || sh.frac <= 0) return;
    const f1 = f + sh.frac;
    const p = el('path', { d: slice(f, f1), fill: sh.color, class: 'slice track' + (S.sel.has(t.index) ? ' sel' : '') + (S.playingTrack === t.index ? ' playing' : '') });
    p.dataset.i = t.index;
    el('title', {}, p).textContent = `${t.index + 1}. ${t.title || 'No title'}\n${fmt(t.seconds)} playing time · ${t.encoding}${t.mono ? ' mono' : ''} · ${(sh.frac * 100).toFixed(1)}% of the disc`;
    if (sh.frac >= 0.022) {                                                  // narrow slices get a smaller number
      const [lx, ly] = pt((R + r) / 2 + 4, f + sh.frac / 2);
      const tx = el('text', { x: lx, y: ly, class: 'slice-num', 'font-size': sh.frac >= 0.04 ? 10 : 7 }); tx.textContent = t.index + 1;
    }
    f = f1;
  });
  const q = Math.min(queuedSec, left) / total;
  if (queuedSec > 0 && q > 0) {
    const p = el('path', { d: slice(f, f + q), class: 'slice queued' + (queuedSec > left ? ' over' : '') });
    el('title', {}, p).textContent = `Queued to send: ${fmt(queuedSec)}${queuedSec > left ? ' — more than the free space' : ''}`;
  }
  el('circle', { cx: C, cy: C, r: r, class: 'disc-hole' });                // hub area
  el('circle', { cx: C, cy: C, r: 9, class: 'disc-spindle' });
  const pct = el('text', { x: C, y: C - 10, class: 'disc-pct' }); pct.textContent = `${Math.round((d.usedSec / total) * 100)}%`;
  const sub = el('text', { x: C, y: C + 12, class: 'disc-sub' }); sub.textContent = fmt(Math.max(0, left - queuedSec));
  const sub2 = el('text', { x: C, y: C + 23, class: 'disc-sub' }); sub2.textContent = 'free';
  map.setAttribute('aria-label', `Disc ${Math.round((d.usedSec / total) * 100)}% full, ${fmt(left)} free`);
}
$('trackMap').onclick = (e) => {
  const sl = e.target.closest('.slice.track'); if (!sl) return;
  S.sel = new Set([+sl.dataset.i]); S.anchor = +sl.dataset.i; render();
};
function renderTracks(canEdit, share = new Map()) {
  const body = $('trackBody');
  const tracks = S.disc?.tracks || [];
  $('trackEmpty').style.display = tracks.length ? 'none' : 'grid';
  $('trackEmpty').textContent = !S.connected ? 'No player connected' : !S.disc ? 'No disc in the player' : 'This disc is blank — add some music →';
  body.innerHTML = tracks.map((t) => `
    <tr data-i="${t.index}" draggable="${canEdit}" class="${S.sel.has(t.index) ? 'sel' : ''} ${S.playingTrack === t.index ? 'playing' : ''}">
      <td class="c-num">${t.index + 1}</td>
      <td>${esc(t.title || 'No title')}${t.protected ? '<span class="lock" title="Protected track (recorded via SonicStage/OpenMG)">🔒</span>' : ''}</td>
      <td class="c-mode"><span class="badge ${t.encoding}">${t.encoding}${t.mono ? ' mono' : ''}</span></td>
      <td class="c-share"><div class="share" title="${((share.get(t.index)?.frac || 0) * 100).toFixed(1)}% of the disc"><i data-i="${t.index}"></i><b>${((share.get(t.index)?.frac || 0) * 100).toFixed(1)}%</b></div></td>
      <td class="c-time">${fmt(t.seconds)}</td>
    </tr>`).join('');
  // widths and colours via the CSSOM (inline style attributes are blocked by the CSP)
  const maxFrac = Math.max(0.0001, ...[...share.values()].map((s) => s.frac));
  body.querySelectorAll('.share i').forEach((el) => { const sh = share.get(+el.dataset.i); if (sh) { el.style.width = `${(sh.frac / maxFrac) * 100}%`; el.style.background = sh.color; } });
}

function renderQueue(d, queuedSec, left) {
  const STATE = { queued: 'Ready', ripping: 'Reading CD…', converting: 'Converting…', waiting: 'Waiting for player…', transferring: 'Sending', done: 'On disc ✓', error: 'Failed', cancelled: 'Cancelled' };
  const list = $('queue');
  // Preserve focus while the user is editing a title.
  const focusId = document.activeElement?.closest?.('#queue li')?.dataset.id;
  if (!focusId) {
    list.innerHTML = S.queue.map((q) => `
      <li data-id="${q.id}" class="${q.state}" title="${esc(q.error || q.path || q.name)}">
        ${q.art ? `<img class="q-art" src="${q.art}" alt="">` : '<div class="q-art">♪</div>'}
        <div class="q-title" contenteditable="${q.state === 'queued' && !S.uploading}" spellcheck="false">${esc(q.title)}</div>
        <span class="q-time">${fmt(q.seconds)}</span>
        <button class="q-x" title="Remove" ${S.uploading ? 'disabled' : ''}>✕</button>
        <div class="q-file">${esc(q.name)}</div>
        <div class="q-state">${STATE[q.state]}${q.state === 'transferring' || q.state === 'converting' || q.state === 'ripping' ? ` ${Math.round((q.pct || 0) * 100)}%` : ''}</div>
        <div class="q-prog"></div>
      </li>`).join('');
  }
  // Set via CSSOM (inline style attributes are blocked by the CSP).
  S.queue.forEach((q) => {
    const bar = list.querySelector(`li[data-id="${q.id}"] .q-prog`);
    if (bar) bar.style.width = `${(q.pct || 0) * 100}%`;
  });
  const pending = S.queue.filter((q) => q.state === 'queued' || q.state === 'error');
  $('queueInfo').textContent = S.queue.length ? `${pending.length} to send · ${fmt(queuedSec)} in ${S.mode}` : 'Queue is empty';
  $('clearBtn').disabled = !S.queue.length || S.uploading;
  ['tidyBtn', 'sortBtn', 'numBtn'].forEach((id) => ($(id).disabled = !S.queue.some((q) => q.state === 'queued') || S.uploading));
  $('fitBtn').disabled = !d || !pending.length || S.uploading;
  $('cancelBtn').classList.toggle('hidden', !S.uploading);
  $('sendBtn').classList.toggle('hidden', S.uploading);
  $('sendBtn').disabled = !pending.length || !d || !d.writable || d.writeProtected || S.busy || (S.mode !== 'SP' && !S.atracdenc);

  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === S.mode);
    b.setAttribute('aria-checked', b.dataset.mode === S.mode);
    b.disabled = S.uploading;
  });
  const hint = $('modeHint');
  if (S.mode !== 'SP' && !S.atracdenc) { hint.textContent = 'LP2/LP4 need the free atracdenc encoder — see README to add it.'; hint.className = 'hint warn'; }
  else if (d && queuedSec > left) { hint.textContent = `Queue is ${fmt(queuedSec - left)} too long for this disc. Try ${S.mode === 'SP' ? 'LP2' : 'LP4'} or remove some tracks.`; hint.className = 'hint warn'; }
  else hint.textContent = { SP: 'Best quality. Standard 80-min disc holds 80 minutes.', LP2: 'Good quality, double the playing time.', LP4: 'Speech / casual listening, four times the playing time.' }[S.mode], hint.className = 'hint';
}

// ---------- device actions
async function refresh() {
  if (!S.connected) return;
  const { status, disc } = await window.md.readDisc();
  S.disc = disc; S.lastDiscPresent = status.discPresent;
  S.sel = new Set([...S.sel].filter((i) => disc?.tracks.some((t) => t.index === i)));
  if (disc && disc.title !== S.art.title) loadDiscArt(disc.title);
}

// Fetch art for the disc in the background (cached; online lookup if enabled).
async function loadDiscArt(title, opts) {
  S.art = { title, url: null, source: null, loading: !!title.trim() };
  render();
  if (!title.trim()) return;
  try {
    const r = await window.md.getArt(title, opts);
    if (S.art.title !== title) return; // disc changed meanwhile
    S.art = { title, url: r?.url || null, source: r?.source || null, manual: !!r?.manual, loading: false };
  } catch (e) {
    if (S.art.title === title) S.art.loading = false;
  }
  render();
}

$('connectBtn').onclick = () => S.connected
  ? busy('Disconnecting…', async () => { await window.md.disconnect(); S.connected = false; S.disc = null; S.sel.clear(); })
  : busy('Looking for player…', async () => {
    const r = await window.md.connect();
    if (!r.connected) { toast('No NetMD player found. Is it plugged in and is the WinUSB driver installed? (see README)', true); return; }
    S.connected = true; S.name = r.name;
    render('Reading disc…');
    await refresh();
  });
$('refreshBtn').onclick = () => busy('Reading disc…', refresh);

document.querySelectorAll('#transport button').forEach((b) => (b.onclick = () =>
  window.md.transport(b.dataset.t).catch((e) => toast(e.message, true))));

const canEdit = () => S.connected && S.disc && S.disc.writable && !S.disc.writeProtected && !S.busy && !S.uploading;
$('discTitle').ondblclick = () => {
  if (!canEdit()) return;
  openRename('Rename disc', S.disc?.title || '', (v) => busy('Renaming disc…', async () => { await window.md.renameDisc(v); await refresh(); }));
};

function openRename(head, value, onSave) {
  const dlg = $('renameDlg');
  $('renameHead').textContent = head;
  $('renameInput').value = value;
  dlg.onclose = () => { if (dlg.returnValue === 'ok') onSave($('renameInput').value.trim()); };
  dlg.showModal(); $('renameInput').select();
}

// track selection, rename, reorder
const body = $('trackBody');
body.onclick = (e) => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const i = +tr.dataset.i;
  if (e.shiftKey && S.anchor != null) {
    const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
    if (!e.ctrlKey) S.sel.clear();
    for (let k = a; k <= b; k++) S.sel.add(k);
  } else if (e.ctrlKey || e.metaKey) {
    S.sel.has(i) ? S.sel.delete(i) : S.sel.add(i); S.anchor = i;
  } else { S.sel = new Set([i]); S.anchor = i; }
  render();
};
body.ondblclick = (e) => {
  const tr = e.target.closest('tr'); if (!tr || !canEdit()) return;
  const t = S.disc.tracks.find((x) => x.index === +tr.dataset.i);
  openRename(`Rename track ${t.index + 1}`, t.title, (v) => busy('Renaming…', async () => { await window.md.renameTrack(t.index, v); await refresh(); }));
};
let dragFrom = null;
body.ondragstart = (e) => { dragFrom = +e.target.closest('tr').dataset.i; e.dataTransfer.effectAllowed = 'move'; };
body.ondragover = (e) => {
  if (dragFrom == null) return;
  e.preventDefault();
  body.querySelectorAll('tr').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  const tr = e.target.closest('tr'); if (!tr) return;
  tr.classList.add(+tr.dataset.i > dragFrom ? 'drop-below' : 'drop-above');
};
body.ondragend = () => { dragFrom = null; body.querySelectorAll('tr').forEach((r) => r.classList.remove('drop-above', 'drop-below')); };
body.ondrop = (e) => {
  e.preventDefault();
  const tr = e.target.closest('tr'); const from = dragFrom; dragFrom = null;
  if (!tr || from == null) return;
  const to = +tr.dataset.i;
  if (to === from) return render();
  busy(`Moving track ${from + 1}…`, async () => { await window.md.moveTrack(from, to); S.sel = new Set([to]); await refresh(); });
};

function deleteSelected() {
  if (!S.sel.size || $('deleteBtn').disabled) return;
  const n = S.sel.size;
  if (!confirm(`Delete ${n} track${n > 1 ? 's' : ''} from the disc? This can't be undone.`)) return;
  busy('Deleting…', async () => { await window.md.deleteTracks([...S.sel]); S.sel.clear(); await refresh(); toast(`Deleted ${n} track${n > 1 ? 's' : ''}`); });
}
$('deleteBtn').onclick = deleteSelected;

// ---------- export / import the track list (CSV; track 0 is the disc title)
const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
$('exportBtn').onclick = async () => {
  const d = S.disc; if (!d) return;
  const lines = [['Track', 'Title', 'Mode', 'Length'].join(',')];
  lines.push(['0', csvCell(d.title || ''), '', csvCell(fmt(d.totalSec))].join(','));
  d.tracks.forEach((t) => lines.push([t.index + 1, csvCell(t.title || ''), t.encoding + (t.mono ? ' mono' : ''), fmt(t.seconds)].join(',')));
  try {
    const where = await window.md.saveText(`${(d.title || 'MiniDisc').replace(/[\\/:*?"<>|]/g, '_')}.csv`, '﻿' + lines.join('\r\n') + '\r\n');
    if (where) toast(`Saved ${d.tracks.length} track${d.tracks.length === 1 ? '' : 's'} to ${where}`);
  } catch (e) { toast(e.message, true); }
};
$('importBtn').onclick = async () => {
  const d = S.disc; if (!d) return;
  let text;
  try { text = await window.md.openText(); } catch (e) { return toast(e.message, true); }
  if (text == null) return;
  const rows = parseCSV(text);
  const header = (rows[0] || []).map((x) => x.trim().toLowerCase());
  const ti = header.indexOf('title'), ni = header.indexOf('track');
  if (ti < 0 || ni < 0) return toast('That file needs "Track" and "Title" columns (use Export list to see the format)', true);
  let discTitle = null; const renames = []; let skipped = 0;
  for (const r of rows.slice(1)) {
    const n = parseInt(r[ni], 10), title = (r[ti] ?? '').trim();
    if (!Number.isInteger(n)) continue;
    if (n === 0) { if (title !== (d.title || '')) discTitle = title; continue; }
    const t = d.tracks[n - 1];
    if (!t) { skipped++; continue; }
    if (title && title !== t.title) renames.push({ index: t.index, from: t.title, title });
  }
  if (discTitle == null && !renames.length) return toast(skipped ? `No changes (${skipped} row${skipped === 1 ? '' : 's'} didn't match a track on this disc)` : 'No changes: the titles already match the disc');
  const parts = [];
  if (discTitle != null) parts.push(`rename the disc to "${discTitle}"`);
  if (renames.length) parts.push(`rename ${renames.length} track${renames.length === 1 ? '' : 's'}`);
  const sample = renames.slice(0, 5).map((x) => `  ${x.index + 1}. ${x.from || 'No title'}  →  ${x.title}`).join('\n');
  if (!confirm(`This will ${parts.join(' and ')}:\n\n${sample}${renames.length > 5 ? `\n  …and ${renames.length - 5} more` : ''}${skipped ? `\n\n${skipped} row${skipped === 1 ? '' : 's'} beyond the end of the disc will be ignored.` : ''}\n\nContinue?`)) return;
  busy('Importing titles…', async () => {
    if (discTitle != null) await window.md.renameDisc(discTitle);
    for (const [i, x] of renames.entries()) { render(`Renaming track ${i + 1} of ${renames.length}…`); await window.md.renameTrack(x.index, x.title); }
    await refresh();
    toast(`Updated ${renames.length} track title${renames.length === 1 ? '' : 's'}${discTitle != null ? ' and the disc title' : ''}`);
  });
};
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, [contenteditable="true"], dialog')) return;
  if (e.key === 'Delete') deleteSelected();
  if (e.key === 'F5') $('refreshBtn').click();
  if (e.key === 'a' && e.ctrlKey && S.disc) { e.preventDefault(); S.sel = new Set(S.disc.tracks.map((t) => t.index)); render(); }
});

// erase disc
$('eraseBtn').onclick = () => {
  const dlg = $('eraseDlg');
  $('eraseName').textContent = S.disc.title || 'this disc';
  $('eraseInput').value = ''; $('eraseOk').disabled = true;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    busy('Erasing disc…', async () => { await window.md.eraseDisc(); S.sel.clear(); await refresh(); toast('Disc erased'); });
  };
  dlg.showModal();
};
$('eraseInput').oninput = (e) => ($('eraseOk').disabled = e.target.value.trim().toUpperCase() !== 'ERASE');

// ---------- album art dialog
function showArtPreview() {
  const url = S.art.title === S.disc?.title ? S.art.url : null;
  $('artPreviewImg').hidden = !url;
  if (url) $('artPreviewImg').src = url;
  $('artPreviewNone').hidden = !!url;
  $('artRemove').disabled = !url;
  const s = $('artStatus');
  if (url && S.art.source) {
    s.innerHTML = `Found: <b>${esc(S.art.source.artist)} – ${esc(S.art.source.title)}</b><br><a data-mbid="${esc(S.art.source.mbid)}">View on MusicBrainz</a>`;
  } else s.textContent = url ? 'Your own image.' : '';
}
$('discArt').onclick = async () => {
  if (!S.disc) return;
  const guess = (S.disc.title || '').split(/\s+[-–—\/]\s+/);
  $('artArtist').value = guess.length > 1 ? guess[0] : '';
  $('artAlbum').value = guess.length > 1 ? guess.slice(1).join(' - ') : S.disc.title || '';
  $('artAuto').checked = (await window.md.getSettings()).onlineArt;
  showArtPreview();
  $('artDlg').showModal();
};
$('artStatus').onclick = (e) => { const id = e.target.dataset?.mbid; if (id) window.md.openExternal(`https://musicbrainz.org/release-group/${id}`); };
$('artSearch').onclick = async () => {
  const title = S.disc?.title || $('artAlbum').value;
  if (!$('artAlbum').value.trim()) { $('artStatus').textContent = 'Enter an album name to search.'; return; }
  $('artSearch').disabled = true; $('artStatus').textContent = 'Searching MusicBrainz…';
  try {
    const r = await window.md.getArt(title, { force: true, artist: $('artArtist').value, album: $('artAlbum').value });
    if (r) { S.art = { title: S.disc?.title, url: r.url, source: r.source, loading: false }; render(); showArtPreview(); }
    else $('artStatus').textContent = 'No cover found. Try fewer words, check the spelling, or choose your own image.';
  } catch (e) { $('artStatus').textContent = `Search failed: ${e.message}. Are you online?`; }
  $('artSearch').disabled = false;
};
$('artChoose').onclick = async () => {
  try {
    const r = await window.md.chooseArt(S.disc.title);
    if (r) { S.art = { title: S.disc.title, url: r.url, source: null, manual: true, loading: false }; render(); showArtPreview(); }
  } catch (e) { $('artStatus').textContent = e.message; }
};
$('artRemove').onclick = async () => {
  await window.md.clearArt(S.disc.title);
  S.art = { title: S.disc.title, url: null, source: null, loading: false }; render(); showArtPreview();
};
$('artAuto').onchange = (e) => window.md.setSettings({ onlineArt: e.target.checked });
['artArtist', 'artAlbum'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('artSearch').click(); } }));

// ---------- import from CD
const CD = { info: null };
const cdTitleFor = (t) => ($('cdArtistInTitle').checked && (t.artist || $('cdArtist').value.trim())
  ? `${t.artist || $('cdArtist').value.trim()} - ${t.title}` : t.title);

function drawCD() {
  const info = CD.info;
  const tracks = info?.tracks || [];
  $('cdBody').innerHTML = tracks.map((t, i) => `
    <tr data-i="${i}" class="${t.on ? '' : 'off'}">
      <td class="c-num"><input type="checkbox" ${t.on ? 'checked' : ''} aria-label="Include track ${t.n}"></td>
      <td class="c-num">${t.n}</td>
      <td><input type="text" value="${esc(t.title)}" spellcheck="false"></td>
      <td class="c-time">${fmt(t.seconds)}</td>
    </tr>`).join('');
  $('cdArt').hidden = !info?.art; if (info?.art) $('cdArt').src = info.art;
  $('cdArtPh').hidden = !!info?.art;
  cdSummary();
}
function cdSummary() {
  const on = (CD.info?.tracks || []).filter((t) => t.on);
  const secs = on.reduce((a, t) => a + t.seconds, 0);
  const left = S.disc?.leftSec;
  $('cdSummary').textContent = CD.info ? `${on.length} track${on.length === 1 ? '' : 's'} · ${fmt(secs)}` +
    (left != null ? ` · ${secs <= left ? 'fits' : secs / 2 <= left ? 'fits in LP2' : secs / 4 <= left ? 'fits in LP4' : 'too long for this disc'}` : '') : '';
  $('cdAdd').disabled = !on.length;
  $('cdAdd').textContent = on.length ? `Add ${on.length} track${on.length === 1 ? '' : 's'} to queue` : 'Add to queue';
  $('cdAll').checked = on.length === (CD.info?.tracks || []).length;
  const name = [$('cdArtist').value.trim(), $('cdAlbum').value.trim()].filter(Boolean).join(' - ');
  $('cdNameLabel').textContent = name ? `Name the MiniDisc "${name}"` : 'Name the MiniDisc after the album';
}

async function cdLoad() {
  const letter = $('cdDrive').value;
  CD.info = null; drawCD();
  if (!letter) { $('cdStatus').textContent = 'No CD drive found. Plug in a USB CD drive and click Reload.'; return; }
  $('cdStatus').textContent = 'Reading the disc and looking it up on MusicBrainz…';
  try {
    const info = await window.md.cdRead(letter);
    info.tracks.forEach((t) => (t.on = true));
    CD.info = info;
    const r = info.release;
    $('cdArtist').value = r?.artist || '';
    $('cdAlbum').value = r?.title || '';
    // Compilations: different artists per track, so put the artist in each title by default.
    $('cdArtistInTitle').checked = !!r && r.tracks.some((t) => t.artist && t.artist !== r.artist);
    $('cdStatus').textContent = r ? `Found on MusicBrainz${r.date ? ` · ${r.date.slice(0, 4)}` : ''}${r.disc ? ` · disc ${r.disc}` : ''}` : 'Not found on MusicBrainz. Type the names in yourself.';
  } catch (e) {
    $('cdStatus').textContent = /No readable audio CD|not ready|error 21/i.test(e.message) ? 'No audio CD in this drive. Insert one and click Reload.' : e.message;
  }
  drawCD();
}

async function cdOpen() {
  $('cdDrive').innerHTML = '';
  $('cdStatus').textContent = 'Looking for CD drives…';
  CD.info = null; drawCD();
  $('cdName').checked = !!S.disc && !S.disc.tracks.length; // suggest naming blank discs only
  $('cdDlg').showModal();
  try {
    const drives = await window.md.cdDrives();
    $('cdDrive').innerHTML = drives.map((d) => `<option value="${esc(d.letter)}">${esc(d.letter)}: ${esc(d.label || (d.ready ? 'Audio CD' : 'empty'))}</option>`).join('');
    const ready = drives.find((d) => d.ready);
    if (ready) $('cdDrive').value = ready.letter;
  } catch (e) { $('cdStatus').textContent = e.message; return; }
  cdLoad();
}
$('cdBtn').onclick = cdOpen;
$('cdReload').onclick = cdOpen;
$('cdDrive').onchange = cdLoad;
$('cdEject').onclick = () => $('cdDrive').value && window.md.cdEject($('cdDrive').value).then(() => { CD.info = null; drawCD(); $('cdStatus').textContent = 'Ejected. Insert another CD and click Reload.'; });
$('cdBody').addEventListener('change', (e) => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const t = CD.info.tracks[+tr.dataset.i];
  if (e.target.type === 'checkbox') { t.on = e.target.checked; tr.classList.toggle('off', !t.on); cdSummary(); }
});
$('cdBody').addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  if (tr && e.target.type === 'text') CD.info.tracks[+tr.dataset.i].title = e.target.value;
});
$('cdAll').onchange = (e) => { (CD.info?.tracks || []).forEach((t) => (t.on = e.target.checked)); drawCD(); };
['cdArtist', 'cdAlbum'].forEach((id) => $(id).addEventListener('input', cdSummary));
$('cdDlg').addEventListener('close', () => {
  if ($('cdDlg').returnValue !== 'ok' || !CD.info) return;
  const artist = $('cdArtist').value.trim(), album = $('cdAlbum').value.trim();
  const items = CD.info.tracks.filter((t) => t.on).map((t) => ({
    path: null, name: `CD track ${t.n}${album ? ` · ${album}` : ''}`, title: cdTitleFor(t), seconds: t.seconds,
    artist, album, art: CD.info.art, cd: { drive: CD.info.drive, n: t.n, lba: t.lba, sectors: t.sectors },
  }));
  if ($('cdName').checked && (artist || album)) S.pendingDiscTitle = [artist, album].filter(Boolean).join(' - ');
  addFiles(items);
  setTab('transfer');
  toast(`Added ${items.length} CD track${items.length === 1 ? '' : 's'} to the queue`);
});

// ---------- queue
async function addFiles(files) {
  const added = files.map((f) => ({ ...f, id: nextId++, state: 'queued', pct: 0 }));
  S.queue.push(...added);
  render();
  // Files without embedded covers: look up their album online (one lookup per album, cached).
  const albums = new Map();
  for (const q of added) if (!q.art && q.album) {
    const key = `${q.artist} - ${q.album}`;
    if (!albums.has(key)) albums.set(key, window.md.getArt(key, { artist: q.artist, album: q.album }).catch(() => null));
    albums.get(key).then((r) => { if (r?.url) { q.art = r.url; render(); } });
  }
}
$('drop').onclick = () => window.md.pickFiles().then(addFiles).catch((e) => toast(e.message, true));
$('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('drop').click(); };
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (dragFrom != null) return;
  e.preventDefault(); $('drop').classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (ev === 'dragleave' && e.relatedTarget) return;
  $('drop').classList.remove('over');
}));
document.addEventListener('drop', async (e) => {
  if (dragFrom != null) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => window.md.pathForFile(f)).filter(Boolean);
  if (!paths.length) return toast('Drop audio files, a folder or a playlist', true);
  addPaths(paths);
});

// Folders and playlists: main expands them into an ordered list of audio files.
async function addPaths(paths) {
  if (!paths?.length) return;
  try {
    const { items, missing, truncated } = await window.md.expandAndProbe(paths);
    if (!items.length) return toast(missing ? `No playable files found (${missing} entr${missing === 1 ? 'y' : 'ies'} missing or not audio)` : 'No audio files found there', true);
    await addFiles(items);
    const notes = [];
    if (missing) notes.push(`${missing} missing/skipped`);
    if (truncated) notes.push(`${truncated} over the ${items.length}-file limit left out`);
    toast(`Added ${items.length} track${items.length === 1 ? '' : 's'} to the queue${notes.length ? ` (${notes.join(', ')})` : ''}`, !!truncated);
  } catch (e) { toast(e.message, true); }
}
$('folderBtn').onclick = () => window.md.pickFolderOrPlaylist('folder').then(addPaths).catch((e) => toast(e.message, true));
$('playlistBtn').onclick = () => window.md.pickFolderOrPlaylist('playlist').then(addPaths).catch((e) => toast(e.message, true));

const queueEl = $('queue');
queueEl.onclick = (e) => {
  if (!e.target.classList.contains('q-x')) return;
  const id = +e.target.closest('li').dataset.id;
  S.queue = S.queue.filter((q) => q.id !== id); render();
};
queueEl.addEventListener('focusout', (e) => {
  const li = e.target.closest('li'); if (!li || !e.target.classList.contains('q-title')) return;
  const q = S.queue.find((x) => x.id === +li.dataset.id);
  if (q) q.title = e.target.textContent.trim() || q.name;
  setTimeout(render);
});
queueEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('q-title')) { e.preventDefault(); e.target.blur(); } });

$('clearBtn').onclick = () => { S.queue = []; render(); };

// ---------- bulk tools (only touch tracks that haven't been sent yet)
const editable = (q) => q.state === 'queued' || q.state === 'error';
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
function titleCase(s) {
  // Only fix titles that are ALL lower or ALL upper case; leave deliberate mixed case alone.
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(\-–/"])([a-zà-ÿ])([a-zà-ÿ']*)/g,(m, pre, first, rest, off) => {
    const word = first + rest;
    return pre + (off > 0 && SMALL_WORDS.has(word) ? word : first.toUpperCase() + rest);
  });
}
function tidyTitle(t) {
  let s = String(t).replace(/_/g, ' ');
  s = s.replace(/^\s*\d{1,3}\s*[-.)_]\s+/, '');                                   // "01 - ", "01. "
  s = s.replace(/\s*[(\[](official\s*(music\s*)?(video|audio)|lyrics?(\s*video)?|audio|hd|hq|4k|remaster(ed)?(\s*\d{4})?|visuali[sz]er)[)\]]/gi, '');
  s = s.replace(/\s+/g, ' ').trim();
  return titleCase(s) || t;
}
function bulk(fn, msg) {
  if (S.uploading) return;
  const items = S.queue.filter((q) => q.state === 'queued');
  if (!items.length) return toast('Nothing in the queue to change', true);
  const n = fn(items);
  render();
  if (msg) toast(typeof msg === 'function' ? msg(n) : msg);
}
$('tidyBtn').onclick = () => bulk((items) => {
  let n = 0;
  items.forEach((q) => { const t = tidyTitle(q.title); if (t !== q.title) { q.title = t; n++; } });
  return n;
}, (n) => (n ? `Tidied ${n} title${n === 1 ? '' : 's'}` : 'Titles already look tidy'));
let sortDesc = false;
$('sortBtn').onclick = () => {
  if (S.uploading) return;
  const dir = sortDesc ? -1 : 1;
  const cmp = (x, y) => dir * x.title.localeCompare(y.title, undefined, { numeric: true, sensitivity: 'base' });
  // Sort only the unsent tracks, keeping them in the slots they occupy now.
  const slots = S.queue.map((q, i) => (q.state === 'queued' ? i : -1)).filter((i) => i >= 0);
  const sorted = slots.map((i) => S.queue[i]).sort(cmp);
  slots.forEach((i, k) => (S.queue[i] = sorted[k]));
  toast(sortDesc ? 'Sorted Z–A' : 'Sorted A–Z');
  sortDesc = !sortDesc; $('sortBtn').textContent = sortDesc ? 'Sort Z–A' : 'Sort A–Z';
  render();
};
$('numBtn').onclick = () => bulk((items) => {
  const stripped = items.map((q) => q.title.replace(/^\d{1,3}\s*[-.)]\s+/, ''));
  const width = Math.max(2, String(items.length).length);
  items.forEach((q, i) => (q.title = `${String(i + 1).padStart(width, '0')} ${stripped[i]}`));
  return items.length;
}, (n) => `Numbered ${n} track${n === 1 ? '' : 's'}`);
$('fitBtn').onclick = () => {
  if (S.uploading) return;
  if (!S.disc) return toast('Connect a player with a disc first', true);
  const pending = S.queue.filter(editable);
  if (!pending.length) return toast('Nothing in the queue to fit', true);
  const total = pending.reduce((a, q) => a + q.seconds, 0);
  const left = S.disc.leftSec;
  const modes = ['SP', 'LP2', 'LP4'].filter((m) => m === 'SP' || S.atracdenc);
  const best = modes.find((m) => total / MODE_FACTOR[m] <= left);
  if (best) { const prev = S.mode; S.mode = best; render(); return toast(best === prev ? `Everything fits in ${best}` : `Switched to ${best}: everything fits`); }
  // Nothing fits entirely: use the densest available mode and drop tracks from the end.
  const mode = modes[modes.length - 1];
  let used = 0; const drop = [];
  pending.forEach((q) => { const len = q.seconds / MODE_FACTOR[mode]; if (used + len <= left) used += len; else drop.push(q); });
  const msg = `Even in ${mode} only ${pending.length - drop.length} of ${pending.length} tracks fit (${fmt(left)} free). Switch to ${mode} and remove the last ${drop.length} from the queue?`;
  if (!confirm(msg)) return;
  S.mode = mode;
  S.queue = S.queue.filter((q) => !drop.includes(q));
  render(); toast(`Removed ${drop.length} track${drop.length === 1 ? '' : 's'} to fit in ${mode}`);
};
$('modeSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.mode = b.dataset.mode; render(); } };
$('cancelBtn').onclick = () => window.md.cancelUpload();

$('sendBtn').onclick = async () => {
  const items = S.queue.filter((q) => q.state === 'queued' || q.state === 'error');
  const need = items.reduce((a, q) => a + q.seconds, 0) / MODE_FACTOR[S.mode];
  if (need > S.disc.leftSec && !confirm('These tracks probably won\'t all fit. Send anyway? The transfer will stop when the disc is full.')) return;
  items.forEach((q) => { q.state = 'queued'; q.pct = 0; q.error = null; });
  S.uploading = true; render(`Sending ${items.length} track(s)…`);
  try {
    const n = await window.md.upload(items.map(({ id, path, title, cd }) => ({ id, path, title, cd })), S.mode);
    toast(`${n} track${n === 1 ? '' : 's'} added to the disc`);
    // Imported a CD with "name the MiniDisc" ticked: title the disc after the album.
    if (n && S.pendingDiscTitle) {
      try { await window.md.renameDisc(S.pendingDiscTitle); } catch (e) { toast(`Couldn't name the disc: ${e.message}`, true); }
      S.pendingDiscTitle = null;
    }
  } catch (e) { toast(e.message, true); }
  S.uploading = false;
  await busy('Reading disc…', refresh);
};

window.md.on('upload-progress', ({ id, stage, pct, error }) => {
  const q = S.queue.find((x) => x.id === id); if (!q) return;
  q.state = stage; q.pct = pct ?? q.pct; if (error) q.error = error;
  const cur = S.queue.filter((x) => x.state === 'done').length;
  render(stage === 'ripping' ? `Reading "${q.title}" from CD · ${Math.round(pct * 100)}%` : stage === 'converting' ? `Converting "${q.title}"…` : stage === 'waiting' ? `Waiting for the player to be ready…` : stage === 'transferring' && pct >= 1 ? `Saving "${q.title}" on the player…` : stage === 'transferring' ? `Sending "${q.title}" · ${Math.round(pct * 100)}%` : `Sent ${cur} track(s)`);
});

// ---------- log + device events
window.md.on('log', (line) => { const l = $('log'); l.textContent += line + '\n'; l.scrollTop = l.scrollHeight; });
window.md.on('device-lost', () => { S.connected = false; S.disc = null; S.sel.clear(); S.uploading = false; render(); toast('Player disconnected', true); });
window.md.on('device-attached', () => { if (!S.connected) $('connectBtn').click(); });

// ---------- lyrics panel
function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
  for (const t of ['transfer', 'lyrics', 'video', 'spotify']) $('pane' + t[0].toUpperCase() + t.slice(1)).hidden = tab !== t;
  syncLyrics();
}
$('tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); };

// Which disc track should the panel show? Playing track (if following), else the single selection.
function lyricsTarget() {
  if (!S.disc) return null;
  const sel = S.sel.size === 1 ? [...S.sel][0] : null;
  const idx = $('lyFollow').checked && S.playingTrack != null ? S.playingTrack : sel ?? S.playingTrack;
  const t = S.disc.tracks.find((x) => x.index === idx);
  if (!t || !t.title) return null;
  // Track titled "Artist - Song" wins; otherwise take the artist from the disc title.
  const parts = t.title.split(/\s+-\s+/);
  const discParts = (S.disc.title || '').split(/\s+[-–—\/]\s+/);
  return {
    index: t.index, seconds: t.seconds,
    artist: parts.length > 1 ? parts[0] : discParts.length > 1 ? discParts[0] : '',
    title: parts.length > 1 ? parts.slice(1).join(' - ') : t.title,
  };
}

function syncLyrics() {
  $('liveDot').hidden = S.playingTrack == null;
  syncVideo();
  syncSpotify();
  if (S.tab !== 'lyrics') return;
  drawLyricsArt();
  const tg = lyricsTarget();
  const key = tg ? `${tg.index}|${tg.artist}|${tg.title}`.toLowerCase() : null;
  if (key === S.ly.key) return;
  S.ly = { key, target: tg, loading: !!tg, data: null, lines: null, error: null };
  $('lySArtist').value = ''; $('lySTitle').value = '';
  drawLyrics();
  if (tg) loadLyrics({});
}

async function loadLyrics(opts) {
  const { key, target: tg } = S.ly;
  S.ly.loading = true; S.ly.error = null; drawLyrics();
  try {
    const r = await window.md.getLyrics({ artist: tg.artist, title: tg.title, seconds: tg.seconds, ...opts });
    if (S.ly.key !== key) return;
    S.ly.data = r;
    S.ly.lines = r?.synced ? parseLRC(r.synced) : null;
  } catch (e) {
    if (S.ly.key !== key) return;
    S.ly.error = e.message;
  }
  S.ly.loading = false;
  drawLyrics();
}

// "[01:02.34] text" (a line may carry several timestamps) → [{ t, text }] sorted by time.
function parseLRC(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + +m[2], text });
  }
  return out.sort((a, b) => a.t - b.t);
}

function drawLyricsArt() {
  const art = S.ly.target && S.art.title === S.disc?.title ? S.art.url : null;
  if (art && $('lyArt').src !== art) $('lyArt').src = art;
  $('lyArt').hidden = !art;
  $('lyArtPh').hidden = !!art;
}

function drawLyrics() {
  const { target: tg, data, loading, error, lines } = S.ly;
  const body = $('lyBody');
  $('lyTitle').textContent = tg ? tg.title : 'No track selected';
  $('lyArtist').textContent = tg ? [tg.artist, `Track ${tg.index + 1}`].filter(Boolean).join(' · ') : '';
  drawLyricsArt();
  body.classList.remove('synced', 'idle');
  S.ly.cur = -1;
  const msg = (t) => (body.innerHTML = `<p class="ly-msg">${t}</p>`);
  if (!tg) msg(S.disc ? 'Click a track on the disc, or press play on the player, to see its lyrics.' : 'Connect your player and insert a disc to see lyrics.');
  else if (loading) msg('Searching for lyrics…');
  else if (error) msg(`Couldn't reach the lyrics service.<br><span class="small">${esc(error)}</span>`);
  else if (!data) msg(`No lyrics found for “${esc(tg.title)}”.<br><span class="small">Try searching with a different artist or title below.</span>`);
  else if (data.instrumental) msg('♪ Instrumental ♪');
  else if (lines?.length) {
    body.classList.add('synced');
    body.innerHTML = lines.map((l, i) => `<p data-i="${i}">${esc(l.text) || '♪'}</p>`).join('');
  } else body.innerHTML = data.plain.split('\n').map((l) => `<p>${esc(l)}</p>`).join('');
  if (!loading) body.scrollTop = 0;

  const notFound = tg && !loading && !error && !data;
  $('lySearch').hidden = !notFound && !S.ly.searchOpen;
  if (tg && ($('lySearch').hidden === false) && !$('lySArtist').value && !$('lySTitle').value) { $('lySArtist').value = tg.artist; $('lySTitle').value = tg.title; }
  $('lyFix').hidden = !data;
  $('lySource').textContent = data ? `Lyrics: ${data.source}${data.synced ? ' · synced' : ''}${data.artist && data.title ? ` · ${data.artist} – ${data.title}` : ''}` : '';
  $('lySource').title = $('lySource').textContent;
}

$('lyFollow').onchange = () => { S.ly.key = undefined; syncLyrics(); };
$('lyAuto').onchange = (e) => window.md.setSettings({ onlineLyrics: e.target.checked });
$('lyFix').onclick = () => {
  S.ly.searchOpen = !S.ly.searchOpen;
  $('lySArtist').value = S.ly.target?.artist || ''; $('lySTitle').value = S.ly.target?.title || '';
  drawLyrics();
  if (S.ly.searchOpen) $('lySTitle').focus();
};
$('lySearch').onsubmit = (e) => {
  e.preventDefault();
  const tg = S.ly.target; if (!tg) return;
  S.ly.searchOpen = false;
  // Search with the corrected words, but remember the result for this disc track.
  loadLyrics({ artist: $('lySArtist').value, title: $('lySTitle').value, force: true, cacheAs: { artist: tg.artist, title: tg.title } });
};

// Karaoke highlight: interpolate the player's position between polls.
let lyScrollPause = 0;
$('lyBody').addEventListener('wheel', () => (lyScrollPause = performance.now() + 4000), { passive: true });
function playerPos() {
  const p = S.pos;
  return p.sec + (p.playing ? (performance.now() - p.at) / 1000 : 0);
}
setInterval(() => {
  const { lines, target } = S.ly;
  if (S.tab !== 'lyrics' || !lines?.length) return;
  const body = $('lyBody');
  const active = S.pos.track === target.index && S.playingTrack === target.index;
  body.classList.toggle('idle', !active);
  if (!active) { if (S.ly.cur !== -1) { body.querySelectorAll('p').forEach((p) => p.classList.remove('on', 'past')); S.ly.cur = -1; } return; }
  const now = playerPos() + 0.2;
  let cur = -1;
  for (let i = 0; i < lines.length && lines[i].t <= now; i++) cur = i;
  if (cur === S.ly.cur) return;
  S.ly.cur = cur;
  body.querySelectorAll('p').forEach((p, i) => { p.classList.toggle('on', i === cur); p.classList.toggle('past', i < cur); });
  const el = body.querySelector(`p[data-i="${Math.max(cur, 0)}"]`);
  if (el && performance.now() > lyScrollPause) body.scrollTop = el.offsetTop - body.clientHeight / 2 + el.offsetHeight / 2;
}, 200);

// ---------- video tab (official YouTube video, played in-app)
S.vid = { key: null, target: null, loading: false, results: [], current: null, error: null };
function syncVideo() {
  if (S.tab !== 'video') return;
  const tg = lyricsTarget();
  const key = tg ? `${tg.artist}|${tg.title}`.toLowerCase() : null;
  if (key === S.vid.key) return;
  S.vid = { key, target: tg, loading: !!tg, results: [], current: null, error: null };
  drawVideo(true);
  if (!tg) return;
  window.md.youtubeSearch(tg.artist, tg.title, tg.seconds)
    .then((r) => { if (S.vid.key !== key) return; S.vid.results = r; S.vid.current = r[0]?.id || null; })
    .catch((e) => { if (S.vid.key === key) S.vid.error = e.message; })
    .finally(() => { if (S.vid.key !== key) return; S.vid.loading = false; drawVideo(true); });
}

function drawVideo(reloadFrame, autoplay = false) {
  const { target: tg, loading, error, results, current } = S.vid;
  $('vidTitle').textContent = tg ? tg.title : 'No track selected';
  $('vidSub').textContent = tg ? [tg.artist, `Track ${tg.index + 1}`].filter(Boolean).join(' · ') : '';
  if (reloadFrame) {
    const msg = !tg ? (S.disc ? 'Click a track on the disc, or press play on the player, to find its official video.' : 'Connect your player and insert a disc.')
      : loading ? 'Searching YouTube…'
      : error ? `Couldn't search YouTube.<br><span class="small">${esc(error)}</span>`
      : 'No videos found.';
    $('vidFrame').innerHTML = current
      ? `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(current)}?rel=0&playsinline=1${autoplay ? '&autoplay=1' : ''}"
           allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="YouTube video"></iframe>`
      : `<div class="vid-msg">${msg}</div>`;
  }
  $('vidList').innerHTML = results.slice(0, 8).map((v) => `
    <li data-id="${esc(v.id)}" class="${v.id === current ? 'on' : ''}" title="${esc(v.title)}">
      <img src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="">
      <div class="v-title">${v.official ? '<span class="v-badge">Official</span>' : ''}${esc(v.title)}</div>
      <div class="v-sub">${esc(v.channel)}${v.length ? ' · ' + esc(v.length) : ''}</div>
    </li>`).join('');
  $('vidOpen').disabled = !current;
  // Tell the user whether they're watching the official video or just the closest match.
  const cur = results.find((v) => v.id === current);
  const status = $('vidSource');
  status.className = 'small ' + (cur?.official ? 'v-ok' : 'muted');
  status.textContent = !cur ? 'Video search: YouTube'
    : cur.official ? `✓ Official video · ${cur.channel}`
    : cur.match ? (results.some((v) => v.official) ? `Not the official video · ${cur.channel}` : `No official video found — closest match · ${cur.channel}`)
    : 'No good match found — try the other results';
}
$('vidList').onclick = (e) => {
  const li = e.target.closest('li'); if (!li) return;
  S.vid.current = li.dataset.id;
  // Playing a video: pause the MiniDisc so the two don't play over each other.
  if (S.connected && S.playingTrack != null && S.pos.playing) window.md.transport('pause').catch(() => {});
  drawVideo(true, true);
};
$('vidOpen').onclick = () => S.vid.current && window.md.openExternal(`https://www.youtube.com/watch?v=${S.vid.current}`);

// ---------- spotify tab (album link-out + Spotify's embedded player)
S.sp = { key: null, data: null, loading: false };
function syncSpotify() {
  if (S.tab !== 'spotify') return;
  const d = S.disc;
  const parts = (d?.title || '').split(/\s+[-–—\/]\s+/);
  const artist = parts.length > 1 ? parts[0] : '';
  const album = parts.length > 1 ? parts.slice(1).join(' - ') : d?.title || '';
  // Wait for the art lookup: it gives us the MusicBrainz album id, which links to Spotify.
  const mbid = d && S.art.title === d.title && !S.art.loading ? S.art.source?.mbid || null : undefined;
  const key = d && album && mbid !== undefined ? `${d.title}|${mbid}` : d ? 'wait' : null;
  if (key === S.sp.key) return;
  S.sp = { key, data: null, loading: !!d && !!album };
  drawSpotify({ artist, album });
  if (!key || key === 'wait') return;
  window.md.spotifyAlbum({ mbid, artist, album })
    .then((r) => { if (S.sp.key === key) S.sp.data = r; })
    .catch((e) => { if (S.sp.key === key) S.sp.error = e.message; })
    .finally(() => { if (S.sp.key !== key) return; S.sp.loading = false; drawSpotify({ artist, album }); });
}

function drawSpotify({ artist, album }) {
  const { data, loading, error } = S.sp;
  const art = data?.thumb || (S.disc && S.art.title === S.disc.title ? S.art.url : null);
  $('spArt').hidden = !art; if (art && $('spArt').src !== art) $('spArt').src = art;
  $('spArtPh').hidden = !!art;
  $('spTitle').textContent = data?.title || album || (S.connected ? 'No disc' : 'No player connected');
  $('spSub').textContent = artist || (S.art.source?.artist ?? '');
  $('spApp').disabled = !data?.uri;
  $('spWeb').disabled = !data;
  $('spWeb').textContent = data?.url ? 'Open in browser' : 'Search on Spotify';
  $('spEmbed').innerHTML = data?.id
    ? `<iframe src="https://open.spotify.com/embed/album/${encodeURIComponent(data.id)}?utm_source=generator&theme=0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="Spotify album"></iframe>`
    : '';
  $('spNote').textContent = !S.disc ? 'Insert a disc to find its album on Spotify.'
    : loading ? 'Looking up the album on Spotify…'
    : error ? `Spotify lookup failed: ${error}`
    : data && !data.id ? 'Couldn\'t find an exact album link, so the button opens a Spotify search instead.'
    : data ? 'Album link via MusicBrainz. The player here plays previews; open the album in Spotify for full tracks.' : '';
}
$('spApp').onclick = () => S.sp.data?.uri && window.md.openExternal(S.sp.data.uri)
  .catch(() => toast('Couldn\'t open the Spotify app. Is it installed? Try "Open in browser".', true));
$('spWeb').onclick = () => S.sp.data && window.md.openExternal(S.sp.data.url || S.sp.data.searchUrl);

// ---------- poll the player: disc insert/eject, playing track and position
async function poll() {
  let delay = 3000;
  if (S.connected && !S.busy && !S.uploading && !document.querySelector('dialog[open]')) {
    try {
      const st = await window.md.status();
      if (st.discPresent !== S.lastDiscPresent) { await busy(st.discPresent ? 'Reading disc…' : 'Disc ejected', refresh); }
      else {
        const playingTrack = st.state === 'playing' || st.state === 'paused' ? st.track : null;
        if (st.track != null && st.time) {
          const sec = st.time.minute * 60 + st.time.second;
          const predicted = playerPos();
          // Keep the smoother local clock if the player's whole-second reading agrees with it.
          const keep = S.pos.track === st.track && S.pos.playing && st.state === 'playing' && Math.abs(predicted - sec) < 1.2;
          S.pos = keep ? { ...S.pos } : { track: st.track, sec, at: performance.now(), playing: st.state === 'playing' };
          if (!keep) S.ly.cur = -2; // force a redraw of the highlight
          S.pos.playing = st.state === 'playing';
        }
        if (playingTrack !== S.playingTrack) { S.playingTrack = playingTrack; render(); }
        if (st.state === 'playing' && S.tab === 'lyrics') delay = 1000;
      }
    } catch {}
  }
  setTimeout(poll, delay);
}
setTimeout(poll, 3000);

window.md.env().then((env) => { S.atracdenc = env.atracdenc; render(); });
window.md.getSettings().then((s) => ($('lyAuto').checked = s.onlineLyrics));
render();
