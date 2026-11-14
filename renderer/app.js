// MiniDisc Manager — renderer (UI only; all device work goes through window.md)
const $ = (id) => document.getElementById(id);
const S = {
  connected: false, name: '', disc: null, sel: new Set(), anchor: null,
  queue: [], mode: 'SP', busy: false, uploading: false, atracdenc: false,
  lastDiscPresent: null, playingTrack: null,
  art: { title: null, url: null, source: null, loading: false },
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

  renderTracks(canEdit);
  renderQueue(d, queuedSec, left);
}

function renderTracks(canEdit) {
  const body = $('trackBody');
  const tracks = S.disc?.tracks || [];
  $('trackEmpty').style.display = tracks.length ? 'none' : 'grid';
  $('trackEmpty').textContent = !S.connected ? 'No player connected' : !S.disc ? 'No disc in the player' : 'This disc is blank — add some music →';
  body.innerHTML = tracks.map((t) => `
    <tr data-i="${t.index}" draggable="${canEdit}" class="${S.sel.has(t.index) ? 'sel' : ''} ${S.playingTrack === t.index ? 'playing' : ''}">
      <td class="c-num">${t.index + 1}</td>
      <td>${esc(t.title || 'No title')}${t.protected ? '<span class="lock" title="Protected track (recorded via SonicStage/OpenMG)">🔒</span>' : ''}</td>
      <td class="c-mode"><span class="badge ${t.encoding}">${t.encoding}${t.mono ? ' mono' : ''}</span></td>
      <td class="c-time">${fmt(t.seconds)}</td>
    </tr>`).join('');
}

function renderQueue(d, queuedSec, left) {
  const STATE = { queued: 'Ready', converting: 'Converting…', transferring: 'Sending', done: 'On disc ✓', error: 'Failed', cancelled: 'Cancelled' };
  const list = $('queue');
  // Preserve focus while the user is editing a title.
  const focusId = document.activeElement?.closest?.('#queue li')?.dataset.id;
  if (!focusId) {
    list.innerHTML = S.queue.map((q) => `
      <li data-id="${q.id}" class="${q.state}" title="${esc(q.error || q.path)}">
        ${q.art ? `<img class="q-art" src="${q.art}" alt="">` : '<div class="q-art">♪</div>'}
        <div class="q-title" contenteditable="${q.state === 'queued' && !S.uploading}" spellcheck="false">${esc(q.title)}</div>
        <span class="q-time">${fmt(q.seconds)}</span>
        <button class="q-x" title="Remove" ${S.uploading ? 'disabled' : ''}>✕</button>
        <div class="q-file">${esc(q.name)}</div>
        <div class="q-state">${STATE[q.state]}${q.state === 'transferring' || q.state === 'converting' ? ` ${Math.round((q.pct || 0) * 100)}%` : ''}</div>
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
  const paths = [...e.dataTransfer.files].map((f) => window.md.pathForFile(f)).filter((p) => /\.(mp3|flac|wav|m4a|aac|ogg|opus|wma|aiff?)$/i.test(p));
  if (!paths.length) return toast('Drop audio files (MP3, FLAC, WAV…)', true);
  addFiles(await window.md.probeFiles(paths));
});

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
$('modeSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.mode = b.dataset.mode; render(); } };
$('cancelBtn').onclick = () => window.md.cancelUpload();

$('sendBtn').onclick = async () => {
  const items = S.queue.filter((q) => q.state === 'queued' || q.state === 'error');
  const need = items.reduce((a, q) => a + q.seconds, 0) / MODE_FACTOR[S.mode];
  if (need > S.disc.leftSec && !confirm('These tracks probably won\'t all fit. Send anyway? The transfer will stop when the disc is full.')) return;
  items.forEach((q) => { q.state = 'queued'; q.pct = 0; q.error = null; });
  S.uploading = true; render(`Sending ${items.length} track(s)…`);
  try {
    const n = await window.md.upload(items.map(({ id, path, title }) => ({ id, path, title })), S.mode);
    toast(`${n} track${n === 1 ? '' : 's'} added to the disc`);
  } catch (e) { toast(e.message, true); }
  S.uploading = false;
  await busy('Reading disc…', refresh);
};

window.md.on('upload-progress', ({ id, stage, pct, error }) => {
  const q = S.queue.find((x) => x.id === id); if (!q) return;
  q.state = stage; q.pct = pct ?? q.pct; if (error) q.error = error;
  const cur = S.queue.filter((x) => x.state === 'done').length;
  render(stage === 'converting' ? `Converting "${q.title}"…` : stage === 'transferring' ? `Sending "${q.title}" · ${Math.round(pct * 100)}%` : `Sent ${cur} track(s)`);
});

// ---------- log + device events
window.md.on('log', (line) => { const l = $('log'); l.textContent += line + '\n'; l.scrollTop = l.scrollHeight; });
window.md.on('device-lost', () => { S.connected = false; S.disc = null; S.sel.clear(); S.uploading = false; render(); toast('Player disconnected', true); });
window.md.on('device-attached', () => { if (!S.connected) $('connectBtn').click(); });

// Poll the player for disc insert/eject and the playing track.
setInterval(async () => {
  if (!S.connected || S.busy || S.uploading || document.querySelector('dialog[open]')) return;
  try {
    const st = await window.md.status();
    if (st.discPresent !== S.lastDiscPresent) { await busy(st.discPresent ? 'Reading disc…' : 'Disc ejected', refresh); return; }
    const playing = st.state === 'playing' || st.state === 'paused' ? st.track : null;
    if (playing !== S.playingTrack) { S.playingTrack = playing; render(); }
  } catch {}
}, 3000);

window.md.env().then((env) => { S.atracdenc = env.atracdenc; render(); });
render();
