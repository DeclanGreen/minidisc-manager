// Finds the official YouTube video for "artist – title" using YouTube's public
// results page (no API key). Results are ranked so that an official music video
// of the right song wins, and are marked { match, official } for the UI.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const cache = new Map();

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);
const toSec = (len) => (len || '').split(':').reduce((a, n) => a * 60 + (+n || 0), 0);

async function fetchResults(query) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch('https://www.youtube.com/results?hl=en&search_query=' + encodeURIComponent(query), {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-GB,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+1' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(`YouTube replied ${r.status}`);
      const m = (await r.text()).match(/var ytInitialData = (\{.*?\});<\/script>/s);
      if (!m) throw new Error('Couldn\'t read YouTube\'s results (the page format may have changed).');
      const found = [];
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o.videoRenderer && o.videoRenderer.videoId) found.push(o.videoRenderer);
        for (const k in o) walk(o[k]);
      };
      walk(JSON.parse(m[1]));
      return found.map((v) => ({
        id: v.videoId,
        title: (v.title?.runs || []).map((x) => x.text).join(''),
        channel: v.ownerText?.runs?.[0]?.text || '',
        length: v.lengthText?.simpleText || '',
        artistBadge: (v.ownerBadges || []).some((b) => /ARTIST/.test(b.metadataBadgeRenderer?.style || '')),
      }));
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); // transient network/rate-limit errors
    }
  }
}

const BAD = /\b(instrumental|karaoke|cover|covers|lyrics?|lyric video|reaction|reacts?|tutorial|lesson|nightcore|slowed|sped up|8d|bass boosted|full album|piano|guitar|drum cam|mashup|backing track|ringtone|legendado|legendada|subtitulado|subtitulada|traducida|traduzione|traducao|letra|sub espanol|vostfr|paroles)\b/;
const LIVE = /\b(live|concert|festival|session|acoustic|unplugged|rehearsal)\b/;
const MIXY = /\b(remix|rmx|mix|edit|dub|extended|version|instrumental)\b/;

function score(v, { artist, title, seconds }) {
  const vt = norm(v.title);
  const ch = norm(v.channel);
  const words = new Set(tokens(v.title));
  const tt = tokens(title);
  const at = tokens(artist);

  // Does the video title contain the song title / artist?
  const titleHits = tt.filter((w) => words.has(w)).length;
  const titleRatio = tt.length ? titleHits / tt.length : 0;
  const artistJoined = at.join('');
  const artistIn = !at.length || at.every((w) => words.has(w)) || ch.replace(/ /g, '').includes(artistJoined) || vt.replace(/ /g, '').includes(artistJoined);
  const match = titleRatio === 1 && artistIn;

  let s = 0;
  s += titleRatio === 1 ? 6 : titleRatio >= 0.6 ? 1 : -10;
  s += artistIn ? 3 : -5;

  // Official channel: the artist's own channel (VEVO, verified-artist badge, or named after
  // the artist). The channel must actually belong to this artist, so verified channels of
  // other bands covering the song don't count.
  const chJoined = ch.replace(/ /g, '');
  const topic = / topic$/.test(ch);
  const officialChannel = !!artistJoined && !topic && chJoined.includes(artistJoined)
    && (/vevo$/.test(chJoined) || v.artistBadge || chJoined.startsWith(artistJoined));
  if (officialChannel) s += 4;
  if (topic) s -= 3; // auto-generated, audio only

  // Prefer real music videos over audio uploads. A video on the artist's own/VEVO channel
  // beats a re-upload that merely calls itself "official", even if its title doesn't say "video".
  const audioOnly = /\b(official )?audio\b|\bvisuali[sz]er\b/.test(vt);
  const videoWords = /\bofficial (music )?video\b|\bofficial hd video\b|\bmusic video\b/.test(vt);
  const plainVideo = /\bvideo\b|\bofficial\b/.test(vt) && !audioOnly;
  if (videoWords) s += 5; else if (plainVideo) s += 3;
  if (officialChannel && !audioOnly) s += videoWords || plainVideo ? 2 : 4;
  if (audioOnly) s -= 3;

  // Not the original song: penalise unless the disc's track title says so itself.
  const titleNorm = norm(title);
  if (BAD.test(vt) && !BAD.test(titleNorm)) s -= 8;
  if (LIVE.test(vt) && !LIVE.test(titleNorm)) s -= 4;
  if (MIXY.test(vt) && !MIXY.test(titleNorm)) s -= 1.5;

  // Length close to the disc track's length.
  const len = toSec(v.length);
  if (seconds && len) {
    const d = Math.abs(len - seconds);
    if (d <= 15) s += 2; else if (d <= 45) s += 1;
    if (len > seconds * 1.8 || len < seconds * 0.5) s -= 4;
  }
  const derivative = (BAD.test(vt) && !BAD.test(titleNorm)) || (LIVE.test(vt) && !LIVE.test(titleNorm));
  return { ...v, score: s, match, official: match && officialChannel && !audioOnly && !derivative };
}

async function youtubeSearch(artist, title, seconds = 0) {
  artist = (artist || '').trim();
  title = (title || '').trim();
  const key = `${norm(artist)}|${norm(title)}|${Math.round(seconds / 10)}`;
  if (cache.has(key)) return cache.get(key);
  const q = { artist, title, seconds };
  const base = `${artist} ${title}`.trim();

  let list = (await fetchResults(`${base} official video`)).slice(0, 15).map((v) => score(v, q));
  // Nothing that is clearly the right song? Search again without "official video".
  if (!list.some((v) => v.match)) {
    const seen = new Set(list.map((v) => v.id));
    const more = (await fetchResults(base)).slice(0, 15).filter((v) => !seen.has(v.id)).map((v) => score(v, q));
    list = list.concat(more);
  }
  list.sort((a, b) => b.score - a.score);
  cache.set(key, list);
  return list;
}

module.exports = { youtubeSearch, _score: score, _norm: norm };
