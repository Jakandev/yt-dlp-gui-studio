'use strict';
/* yt-dlp-GUI Studio App — renderer */
(() => {

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const bridge = window.api;

const PRESETS = [
  { key: 'best', label: 'Best' },
  { key: '2160', label: '2160p' },
  { key: '1440', label: '1440p' },
  { key: '1080', label: '1080p' },
  { key: '720', label: '720p' },
  { key: 'smallest', label: 'Smallest' },
  { key: 'audio', label: 'Audio only' },
];

const S = {
  settings: {},
  queue: [],
  info: null,
  preset: 'best',
  formatId: null,
  formatSpec: null,
  fetching: false,
  schema: null,
  activeView: 'download',
};

/* ─────────────────────────── helpers ─────────────────────────── */
const fmtBytes = (b) => {
  if (!b || b < 1) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const fmtDuration = (s) => {
  if (!s) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const fmtViews = (n) => (n ? `${n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n} views` : '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(text, kind = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="ic">${kind === 'ok' ? '&#10003;' : kind === 'err' ? '!' : 'i'}</span><span>${esc(text)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, kind === 'err' ? 7000 : 3800);
}

async function save(patch) {
  S.settings = await bridge.saveSettings(patch);
  syncSettingsUI();
}

/* ─────────────────────────── navigation ─────────────────────────── */
function setView(name) {
  S.activeView = name;
  $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  if (name === 'queue') { renderQueueFilters(); renderFullQueue(); }
  if (name === 'history') renderHistory();
  if (name === 'presets') renderPresetsView();
  if (name === 'options') ensureSchema();
  if (name === 'settings') { renderJars(); refreshEngines(); }
}

$$('.nav').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

/* window controls */
$('#btnMin').onclick = () => bridge.win.minimize();
$('#btnMax').onclick = () => bridge.win.maximize();
$('#btnClose').onclick = () => bridge.win.close();

/* ─────────────────────────── theme ─────────────────────────── */
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme || 'dark';
  document.documentElement.dataset.accent = S.settings.accent || 'violet';
}
$('#btnTheme').onclick = async () => {
  await save({ theme: S.settings.theme === 'dark' ? 'light' : 'dark' });
  applyTheme();
};

/* ─────────────────────────── URL fetching ─────────────────────────── */
const urlInput = $('#urlInput');

async function fetchUrl(urlArg) {
  const raw = (urlArg ?? urlInput.value ?? '').trim();
  if (!raw) { toast('Paste a link first.', 'err'); urlInput.focus(); return; }
  const urls = raw.split(/[\n\s]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u) || /^[\w.-]+\.[a-z]{2,}\//i.test(u));
  if (!urls.length) { toast('That does not look like a link.', 'err'); return; }

  if (urls.length > 1) {
    for (const u of urls) queueDownloadFor(u);
    toast(`Queued ${urls.length} links.`, 'ok');
    urlInput.value = '';
    return;
  }

  S.fetching = true;
  $('#btnFetch').disabled = true;
  $('#fetchLabel').textContent = 'Reading…';
  $('#videoCard').classList.add('loading');
  try {
    const res = await bridge.fetchInfo(urls[0]);
    if (!res.ok) { toast(res.error || 'Could not read that link.', 'err'); return; }
    S.info = res.info;
    if (S.info.kind === 'playlist' && (!S.info.title || /^playlist$/i.test(S.info.title))) {
      const slug = accountSlug(S.info.webpage_url || urls[0]);
      if (slug) S.info.title = slug;
    }
    S.formatId = null;
    S.formatSpec = null;
    S.preset = 'best';
    await scanExisting();
    renderInfo();
  } catch (e) {
    toast('Fetch failed: ' + e.message, 'err');
  } finally {
    S.fetching = false;
    $('#btnFetch').disabled = false;
    $('#fetchLabel').textContent = 'Fetch & analyse';
    $('#videoCard').classList.remove('loading');
  }
}

$('#btnFetch').onclick = () => fetchUrl();
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchUrl(); });
$('#btnPaste').onclick = async () => {
  try {
    const t = await bridge.clipboardRead();
    if (t && t.trim()) { urlInput.value = t.trim(); fetchUrl(); }
    else toast('Clipboard is empty.', 'err');
  } catch (_) { toast('Could not read the clipboard — press Ctrl+V in the field.', 'err'); }
};

/* right-click menu on the address bar: paste a link (or several) without aiming at a tiny button */
const urlMenu = $('#urlMenu');
function hideUrlMenu() { urlMenu.classList.add('hidden'); }
urlInput.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const w = 180;
  const h = 110;
  urlMenu.style.left = Math.min(e.clientX, window.innerWidth - w - 8) + 'px';
  urlMenu.style.top = Math.min(e.clientY, window.innerHeight - h - 8) + 'px';
  urlMenu.classList.remove('hidden');
});
urlMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  hideUrlMenu();
  if (act === 'clear') { urlInput.value = ''; urlInput.focus(); return; }
  try {
    const t = await bridge.clipboardRead();
    if (!t || !t.trim()) { toast('Clipboard is empty.', 'err'); return; }
    urlInput.value = t.trim();
    urlInput.focus();
    if (act === 'pastego') fetchUrl();
  } catch (_) { toast('Could not read the clipboard — press Ctrl+V in the field.', 'err'); }
});
document.addEventListener('mousedown', (e) => {
  if (!urlMenu.classList.contains('hidden') && !urlMenu.contains(e.target)) hideUrlMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideUrlMenu(); });
window.addEventListener('blur', hideUrlMenu);

/* ─────────────────────────── render: info ─────────────────────────── */
function renderInfo() {
  const info = S.info;
  const card = $('#videoCard');
  card.classList.toggle('empty', !info);
  if (!info) return;

  const img = $('#thumbImg');
  const box = $('#thumbBox');
  img.onerror = () => { img.classList.add('hidden'); box.classList.add('placeholder'); };
  img.onload = () => { box.classList.remove('placeholder'); };
  if (info.thumbnail) {
    img.classList.add('hidden');
    box.classList.add('placeholder');
    img.src = info.thumbnail;
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
    box.classList.add('placeholder');
  }

  const dur = info.kind === 'playlist' ? info.count : info.duration;
  const dEl = $('#thumbDur');
  if (info.kind === 'playlist') { dEl.textContent = `${info.count} items`; dEl.classList.remove('hidden'); }
  else if (dur) { dEl.textContent = fmtDuration(dur); dEl.classList.remove('hidden'); }
  else dEl.classList.add('hidden');

  const topH = (info.formats || []).find((f) => f.height)?.height;
  const qEl = $('#thumbQ');
  if (topH >= 2160) { qEl.textContent = '4K'; qEl.classList.remove('hidden'); }
  else if (topH >= 1440) { qEl.textContent = '2K'; qEl.classList.remove('hidden'); }
  else qEl.classList.add('hidden');

  $('#vTitle').textContent = info.title;
  const chan = $('#vChan');
  if (info.uploader) {
    chan.style.display = '';
    $('#vAvatar').textContent = (info.uploaderInitials || info.uploader.slice(0, 2)).toUpperCase();
    $('#vUploader').textContent = info.uploader;
    $('#vViews').textContent = info.kind === 'video' ? '· ' + fmtViews(info.viewCount) : '';
  } else chan.style.display = 'none';

  const chips = [];
  if (info.kind === 'playlist') {
    chips.push(`<span class="chip live">Playlist · ${info.count} items</span>`);
    if (S.existing && S.existing.size) chips.push(`<span class="chip">${S.existing.size} already downloaded</span>`);
    if (info.entries[0]) chips.push(`<span class="chip">${esc(info.entries[0].title.slice(0, 38))}…</span>`);
  } else {
    if (topH) chips.push(`<span class="chip">${topH}p max</span>`);
    if (info.formats.some((f) => f.hdr)) chips.push('<span class="chip">HDR</span>');
    const fps = Math.max(0, ...info.formats.map((f) => f.fps || 0));
    if (fps) chips.push(`<span class="chip">${fps} fps</span>`);
    if (info.subtitles.length) chips.push(`<span class="chip">${info.subtitles.slice(0, 3).join(' · ').toUpperCase()} subs</span>`);
    if (info.chapters) chips.push(`<span class="chip">${info.chapters} chapters</span>`);
    if (info.live) chips.push('<span class="chip live">LIVE</span>');
    chips.push(`<span class="chip">${info.formats.length} streams</span>`);
  }
  $('#vChips').innerHTML = chips.join('');

  renderPresetPills();
  renderFormats();
  updateEstimate();
}

function renderPresetPills() {
  const box = $('#presets');
  const isPlaylist = S.info && S.info.kind === 'playlist';
  box.innerHTML =
    PRESETS.map(
      (p) => `<button class="pill ${S.preset === p.key && !S.formatId ? 'sel' : ''} ${p.key === 'audio' ? 'au' : ''}" data-preset="${p.key}">${p.label}</button>`
    ).join('') +
    (isPlaylist ? `<button class="btn sm" id="btnDownload" style="margin-left:auto">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v9m0 0l-4-4m4 4l4-4"/><path d="M5 19h14"/></svg>
      Download playlist</button>` : `<button class="btn sm" id="btnDownload" style="margin-left:auto">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v9m0 0l-4-4m4 4l4-4"/><path d="M5 19h14"/></svg>
      Download</button>`);

  $$('#presets [data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      S.preset = b.dataset.preset;
      S.formatId = null;
      S.formatSpec = null;
      renderPresetPills();
      renderFormats();
      updateEstimate();
    })
  );
  const dl = $('#btnDownload');
  if (dl) dl.onclick = () => queueDownloadFor(null);
}

function formatLabel(f) {
  if (f.audioOnly) return `Audio${f.abr ? ' ' + Math.round(f.abr) + 'k' : ''}`;
  return `${f.height || f.note || '?'}p`;
}

function buildRows(formats) {
  const vids = formats.filter((f) => !f.audioOnly && f.height);
  const heights = [...new Set(vids.map((f) => f.height))].sort((a, b) => b - a).slice(0, 9);
  const rows = heights.map((h) => {
    const cands = vids.filter((f) => f.height === h).sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    const best = cands[0];
    // muxed HLS variants carry their own audio, so never append +ba
    const spec = S.info && S.info.directFormats ? best.id : best.id + '+ba/b';
    return { ...best, spec };
  });
  const auds = formats.filter((f) => f.audioOnly).sort((a, b) => (b.tbr || 0) - (a.tbr || 0)).slice(0, 2);
  return [...rows, ...auds.map((a) => ({ ...a, spec: a.id }))];
}

let ROWS = [];

function renderFormats() {
  const table = $('#fmtTable');
  const info = S.info;
  if (!info || info.kind === 'playlist' || !info.formats.length) {
    ROWS = [];
    table.innerHTML = info && info.kind === 'playlist'
      ? `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 6h16M4 12h16M4 18h10"/></svg><div>This is a playlist — quality is chosen by the preset and applied to each video.</div></div>`
      : info
      ? `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 12h16"/><circle cx="12" cy="12" r="9"/></svg><div>This is a direct media link — yt-dlp will download the file as-is, so there are no streams to choose from.</div></div>`
      : `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg><div>Paste a link above and press <b>Fetch &amp; analyse</b> to see every available quality.</div></div>`;
    $('#fmtCount').textContent = '';
    return;
  }
  ROWS = buildRows(info.formats);
  $('#fmtCount').textContent = `· ${info.formats.length} streams`;
  table.innerHTML =
    `<div class="frow hd"><span></span><span>Quality</span><span>Codec</span><span>FPS</span><span style="text-align:right">Size</span></div>` +
    ROWS.map((f) => {
      const on = S.formatId === f.id;
      const tag = f.hdr ? '<span class="tag hdr">HDR</span>' : f.audioOnly ? '<span class="tag">AUDIO</span>' : '';
      const codec = f.audioOnly
        ? `${esc(f.acodec || 'audio')} · ${esc(f.ext)}`
        : `${esc(f.vcodec || '—')} · ${esc(f.ext)}`;
      return `<div class="frow ${on ? 'on' : ''}" data-id="${esc(f.id)}">
        <span class="radio"></span>
        <span class="res">${esc(formatLabel(f))}${tag}</span>
        <span class="mono">${codec}</span>
        <span class="mono">${f.fps || '—'}</span>
        <span class="size">${f.size ? fmtBytes(f.size) : '—'}</span>
      </div>`;
    }).join('');
  $$('#fmtTable .frow[data-id]').forEach((r) =>
    r.addEventListener('click', () => {
      const row = ROWS.find((x) => x.id === r.dataset.id);
      if (!row) return;
      if (S.formatId === row.id) { S.formatId = null; S.formatSpec = null; }
      else { S.formatId = row.id; S.formatSpec = row.spec; }
      renderFormats();
      renderPresetPills();
      updateEstimate();
    })
  );
}

function updateEstimate() {
  const info = S.info;
  const est = $('#estSize');
  if (!info || info.kind === 'playlist') { est.textContent = ''; return; }
  if (S.formatId) {
    const row = ROWS.find((x) => x.id === S.formatId);
    if (!row) { est.textContent = ''; return; }
    const aud = row.audioOnly ? 0 : (info.formats.filter((f) => f.audioOnly).sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0]?.size || 0);
    est.textContent = row.size ? `Selected: ${fmtBytes(row.size + aud)}` : 'Selected quality';
    return;
  }
  if (S.preset === 'audio') {
    const a = info.formats.filter((f) => f.audioOnly).sort((x, y) => y.tbr - x.tbr)[0];
    est.textContent = a && a.size ? `Est. ${fmtBytes(a.size)}` : 'Audio only';
    return;
  }
  const aud = info.formats.filter((f) => f.audioOnly).sort((x, y) => y.tbr - x.tbr)[0];
  const vids = info.formats.filter((f) => !f.audioOnly);
  let v;
  if (S.preset === 'smallest') v = vids.slice().sort((a, b) => (a.height || 1e9) - (b.height || 1e9))[0];
  else {
    const h = S.preset === 'best' ? Infinity : Number(S.preset);
    v = vids.filter((f) => (f.height || 0) <= h).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0];
  }
  if (v && v.size && aud && aud.size) est.textContent = `Est. ${fmtBytes(v.size + aud.size)}`;
  else if (v) est.textContent = `${v.height || v.note}p selected`;
  else est.textContent = '';
}

/* ─────────────────────────── downloading ─────────────────────────── */
/** A string that identifies a video inside a filename (id, viewkey, vk id). */
function tokenFor(url, entry) {
  if (entry && entry.id && entry.id !== 'None') return String(entry.id);
  const u = String(url || '');
  const m =
    u.match(/viewkey=([a-z0-9]+)/i) ||
    u.match(/\/video(-?\d+_\d+)/) ||
    u.match(/\/-0*(\d{8,})/) ||
    u.match(/([0-9a-f]{10,})(?:[/?#]|$)/i);
  return m ? m[1] : '';
}

async function scanExisting() {
  S.existing = new Set();
  const info = S.info;
  if (!info || !Array.isArray(info.items) || !info.items.length || !S.settings.downloadDir) return;
  const entries = info.entries || [];
  const tokens = info.items.map((u, i) => tokenFor(u, entries[i])).filter(Boolean);
  if (!tokens.length) return;
  try {
    const found = await bridge.scanFiles({ dir: S.settings.downloadDir, tokens });
    S.existing = new Set(found.map((t) => String(t).toLowerCase()));
  } catch (_) {}
}

function isExisting(idx) {
  const info = S.info;
  if (!info || !S.existing || !S.existing.size) return false;
  const token = tokenFor(info.items[idx], (info.entries || [])[idx]);
  return !!token && S.existing.has(token.toLowerCase());
}

function accountSlug(rawUrl) {
  const u = String(rawUrl || '');
  const patterns = [
    /\/(?:model|models|users|user|channels|channel|profile|creators?)\/([^/?#]+)/i,
    /\/@([^/?#]+)/, // youtube-style handles
  ];
  for (const re of patterns) {
    const m = u.match(re);
    if (m) return decodeURIComponent(m[1]).trim();
  }
  return '';
}

function folderFor(info) {
  if (!info || S.settings.groupFolders === false) return '';
  if (info.kind !== 'playlist') return '';
  const url = info.webpage_url || info.url || urlInput.value || '';
  const isRealPlaylist = /\/playlist\/|list=|\/playlists?\//i.test(url);
  if (isRealPlaylist) return info.title;
  // account / model / channel page: the URL slug is the honest folder name
  return accountSlug(url) || info.uploader || info.title || '';
}

function parseRange(text, max) {
  const t = (text || '').trim();
  if (!t) return Array.from({ length: max }, (_, i) => i);
  const out = new Set();
  for (const part of t.split(',')) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Math.max(1, Number(m[1]));
      const b = Math.min(max, Number(m[2]));
      for (let i = a; i <= b; i++) out.add(i - 1);
    } else if (/^\d+$/.test(part.trim())) {
      const i = Number(part.trim());
      if (i >= 1 && i <= max) out.add(i - 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function currentPayload() {
  const info = S.info;
  const range = $('#inpRange').value.trim();
  return {
    url: info.url || info.webpage_url || urlInput.value.trim(),
    title: info.title,
    thumbnail: info.thumbnail,
    preset: S.preset,
    formatId: S.formatId,
    formatSpec: S.formatSpec,
    playlistRange: range,
    folder: folderFor(info),
    resolvedUrl: info.resolvedUrl || '',
    resolvedReferer: info.resolvedReferer || '',
    resolvedCookies: info.resolvedCookies || '',
    directFormats: !!info.directFormats,
    fixedTitle: info.resolvedUrl ? info.title : '',
  };
}

async function queueDownloadFor(url) {
  if (!S.settings.downloadDir) {
    toast('Choose a download folder first — Settings → Download folder.', 'err');
    setView('settings');
    return;
  }
  if (!url && !S.info) { toast('Fetch a link first.', 'err'); return; }

  // playlists we expanded ourselves become one item per video
  if (!url && S.info && Array.isArray(S.info.items) && S.info.items.length) {
    const range = parseRange($('#inpRange').value, S.info.items.length);
    const idxs = range.filter((i) => !isExisting(i));
    const skipped = range.length - idxs.length;
    if (!idxs.length) {
      toast(`All ${range.length} selected videos are already downloaded.`, 'ok');
      return;
    }
    const folder = folderFor(S.info) || S.info.title;
    const entries = S.info.entries || [];
    for (const i of idxs) {
      const e = entries[i] || {};
      await bridge.download({
        url: S.info.items[i],
        title: e.title || S.info.title,
        thumbnail: e.thumbnail || '',
        duration: e.duration || 0,
        preset: S.preset,
        folder,
        playlistRange: '',
      });
    }
    toast(
      `Queued ${idxs.length} video${idxs.length > 1 ? 's' : ''} into “${folder}”` +
        (skipped ? ` · skipped ${skipped} already on disk` : '') +
        '.',
      'ok'
    );
    return;
  }

  const payload = url
    ? { url, title: url, preset: S.preset, formatId: null, formatSpec: null, playlistRange: '' }
    : currentPayload();

  if (!payload.url) { toast('No link to download.', 'err'); return; }
  const res = await bridge.download(payload);
  if (res && res.error) { toast(res.error, 'err'); return; }
  toast(
    pauseState
      ? 'Added to queue — the queue is paused, press “Resume all” to start.'
      : 'Added to queue: ' + (payload.title || payload.url),
    'ok'
  );
  setView('queue');
}

$('#lnkClearDone').onclick = () => bridge.clearDone();
$('#btnClearDone2').onclick = () => bridge.clearDone();

/* stop everything and empty the queue */
$('#btnRemoveAll').onclick = async () => {
  if (!S.queue.length) { toast('The queue is already empty.', 'ok'); return; }
  const running = S.queue.some((i) => ['running', 'processing', 'resolving'].includes(i.status));
  const ok = await askConfirm(
    'Remove the whole queue?',
    `${running ? 'The download that is running right now will be stopped and ' : ''}all ${S.queue.length} row${S.queue.length > 1 ? 's' : ''} will be removed from the queue. Files already downloaded stay on your disk.`,
    'Remove all'
  );
  if (!ok) return;
  await bridge.removeAll();
  pauseState = false;
  setPauseLabels();
  S.queue = [];
  renderQueue();
  renderFullQueue();
  toast('Queue cleared.', 'ok');
};
$('#btnClearHistory').onclick = async () => { await bridge.clearHistory(); renderHistory(); };

/* put every failed row back in the queue (handy after refreshing cookies) */
$('#btnRetryFailed').onclick = async () => {
  const n = await bridge.retryFailed();
  if (!n) return;
  toast(`Queued ${n} failed video${n === 1 ? '' : 's'} again.`, 'ok');
};

/* ── select rows and move them to another folder ── */
$('#chkAllQueued').onchange = (e) => {
  selIds.clear();
  selAnchor = null;
  if (e.target.checked) for (const it of visibleQueue().filter(canSelect)) selIds.add(it.id);
  renderFullQueue();
};

$('#btnSelFolder').onclick = async () => {
  const ids = [...selIds];
  if (!ids.length) return;
  const btn = $('#btnSelFolder');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Choosing…';
  try {
    const res = await bridge.folderFor(ids);
    if (!res || !res.ok) return; // picker cancelled: keep the selection
    selIds.clear();
    selAnchor = null;
    renderFullQueue();
    const moved = res.moved || 0;
    const left = res.dropped || 0;
    toast(
      moved
        ? `Moved ${moved} video${moved === 1 ? '' : 's'} to ${res.dir}` +
            (left ? ` · ${left} already downloading, left where it was` : '')
        : `Nothing moved${left ? ` — ${left} already downloading` : ''}.`,
      moved ? 'ok' : 'err'
    );
  } finally {
    btn.textContent = label;
    updateSelUi();
  }
};

/* ─────────────────────────── queue rendering ─────────────────────────── */
let pauseState = false;

/* selection in the queue page: any row that is not finished can be selected;
   only rows that have not started can be moved to another folder */
const selIds = new Set();
const canSelect = (it) => it.status !== 'done';
const pickable = (it) => it.status === 'queued' || it.status === 'cancelled' || it.status === 'failed';

/* which rows the queue page shows: All / Downloading / Queued / Finished / Failed */
let queueFilter = 'all';
const QFILTERS = [
  ['all', 'All', () => true],
  ['downloading', 'Downloading', (i) => ['running', 'processing', 'resolving'].includes(i.status)],
  ['queued', 'Queued', (i) => i.status === 'queued'],
  ['finished', 'Finished', (i) => i.status === 'done'],
  ['failed', 'Failed', (i) => i.status === 'failed' || i.status === 'cancelled'],
];

function visibleQueue() {
  const f = QFILTERS.find((x) => x[0] === queueFilter) || QFILTERS[0];
  return S.queue.filter(f[2]);
}

function renderQueueFilters() {
  const box = $('#qFilters');
  if (!box) return;
  box.innerHTML = QFILTERS.map(([key, label, pred]) => {
    const n = S.queue.filter(pred).length;
    return `<button class="qfilter${queueFilter === key ? ' on' : ''}" data-f="${key}">${label}<b>${n}</b></button>`;
  }).join('');
  $$('#qFilters .qfilter').forEach(
    (b) =>
      (b.onclick = () => {
        queueFilter = b.dataset.f;
        renderQueueFilters();
        renderFullQueue();
      })
  );
}

function pruneSelection() {
  const live = new Set(S.queue.filter((i) => canSelect(i) && selIds.has(i.id)).map((i) => i.id));
  for (const id of [...selIds]) if (!live.has(id)) selIds.delete(id);
}

function updateSelUi() {
  const btn = $('#btnSelFolder');
  const movable = [...selIds].filter((id) => {
    const it = S.queue.find((x) => x.id === id);
    return it && pickable(it);
  }).length;
  if (btn) {
    btn.disabled = movable === 0;
    btn.textContent = movable ? `Change folder (${movable})` : 'Change folder';
  }
  const all = $('#chkAllQueued');
  const rows = visibleQueue().filter(canSelect);
  if (all) {
    all.disabled = rows.length === 0;
    all.checked = rows.length > 0 && rows.every((r) => selIds.has(r.id));
    all.indeterminate = !all.checked && rows.some((r) => selIds.has(r.id));
  }
  const rf = $('#btnRetryFailed');
  if (rf) {
    const fails = S.queue.filter((i) => i.status === 'failed').length;
    rf.disabled = fails === 0;
    rf.textContent = fails ? `Retry failed (${fails})` : 'Retry failed';
  }
  setPauseLabels();
}

/* the row a plain click landed on: a following shift-click selects the whole range */
let selAnchor = null;

function applySelectionToDom() {
  $$('#fullQueue .qchk[data-id]').forEach((c) => {
    const on = selIds.has(c.dataset.id);
    if (c.checked !== on) c.checked = on;
    const row = c.closest('.qrow');
    if (row) row.classList.toggle('sel', on);
  });
  updateSelUi();
}

/**
 * Click a row: toggle it. Shift-click a row: select everything between the last
 * plain click and this one (both ends included), the way file lists behave.
 * Only rows that can still change folder take part, so the range skips the rest.
 */
function handlePick(id, shift) {
  const order = visibleQueue().filter(canSelect).map((i) => i.id);
  const idx = order.indexOf(id);
  if (idx < 0) return;
  const anchorIdx = selAnchor ? order.indexOf(selAnchor) : -1;
  if (shift && anchorIdx >= 0 && anchorIdx !== idx) {
    const lo = Math.min(anchorIdx, idx);
    const hi = Math.max(anchorIdx, idx);
    for (let i = lo; i <= hi; i++) selIds.add(order[i]);
  } else {
    if (selIds.has(id)) selIds.delete(id);
    else selIds.add(id);
    selAnchor = id; // shift keeps the original anchor, like every file manager
  }
  applySelectionToDom();
}

function statusText(it) {
  if (it.status === 'resolving') return 'preparing stream…';
  if (it.status === 'done') return 'done';
  if (it.status === 'failed') return 'failed';
  if (it.status === 'cancelled') return 'cancelled';
  if (it.status === 'queued') return 'queued';
  if (it.status === 'processing') return (it.stage || 'processing').toLowerCase();
  const frag = it.fragmentsTotal ? ` · frag ${it.fragmentIndex}/${it.fragmentsTotal}` : '';
  return `${it.percent.toFixed(0)}%${it.speed ? ' · ' + it.speed : ''}${it.eta ? ' · ETA ' + it.eta : ''}${frag}`;
}

function renderQueue() {
  const isActive = (s) => s === 'running' || s === 'processing' || s === 'resolving';
  const running = S.queue.filter((i) => isActive(i.status));
  const pending = S.queue.filter((i) => i.status === 'queued');
  const done = S.queue.filter((i) => i.status === 'done');

  const total = S.queue.length;
  const doneN = S.queue.filter((i) => i.status === 'done').length;
  const failN = S.queue.filter((i) => i.status === 'failed').length;
  const leftN = S.queue.filter((i) => i.status === 'queued' || isActive(i.status)).length;
  const progressLabel = total ? `${doneN} / ${total}` : '0';
  $('#queueCount').textContent = `· ${progressLabel}`;
  const badge = $('#queueBadge');
  const active = running.length + pending.length;
  badge.textContent = String(active);
  badge.classList.toggle('hidden', active === 0);

  // mini queue
  const mini = $('#miniQueue');
  const others = S.queue.filter((i) => !running.includes(i) && !pending.includes(i));
  const items = [...running, ...pending, ...others.slice(-2)].slice(0, 4);
  if (!items.length) mini.innerHTML = '<div class="qempty">Nothing downloading.</div>';
  else {
    mini.innerHTML = items
      .map((it) => {
        const cls = it.status === 'done' ? 'done' : it.status === 'failed' ? 'failed' : '';
        const pct = it.status === 'done' ? 100 : Math.min(99.5, it.percent || 0);
        return `<div class="qitem ${cls}">
          <div class="qtop"><span class="qname">${esc(it.title || it.url)}</span>
            <span class="qmeta">${it.status === 'done' ? 'done' : it.percent ? Math.round(pct) + '%' : it.status}</span></div>
          <div class="track"><div class="fill" style="width:${pct}%"></div></div>
          <div class="qstat">${esc(statusText(it))}</div>
        </div>`;
      })
      .join('');
  }

  // dock — several downloads can run at once now
  const r = running[0];
  if (r) {
    const atOnce = running.length;
    // average bar when parallel, so it still reads as overall progress
    const barPct = atOnce > 1 ? running.reduce((a, i) => a + (i.percent || 0), 0) / atOnce : r.percent || 0;
    $('#dockStatus').innerHTML =
      `<b>${
        atOnce > 1 ? `Downloading ${atOnce}` : r.status === 'processing' ? 'Processing' : r.status === 'resolving' ? 'Preparing' : 'Downloading'
      }</b> · ` +
      `${doneN} of ${total} done` +
      (failN ? ` · <span style="color:var(--bad)">${failN} failed</span>` : '') +
      ` · ${Math.max(0, leftN - atOnce)} left`;
    $('#dockBar').style.width = Math.min(99.5, barPct) + '%';
    const bits = [];
    if (atOnce > 1) {
      bits.push(`${atOnce} at a time`);
      const speeds = running.map((i) => i.speed).filter(Boolean);
      if (speeds.length) bits.push(speeds.length > 1 ? `${speeds[0]} +${speeds.length - 1}` : speeds[0]);
    } else {
      if (r.speed) bits.push(r.speed);
      if (r.eta && !/^(NA|Unknown)$/i.test(r.eta)) bits.push('ETA ' + r.eta);
      if (r.downloaded) bits.push(`${fmtBytes(r.downloaded)}${r.total ? ' of ' + fmtBytes(r.total) : ''}`);
    }
    $('#dockDetail').textContent = bits.join(' · ');
  } else {
    $('#dockStatus').innerHTML = total
      ? `<b>${pending.length ? pending.length + ' queued' : 'Idle'}</b> · ${doneN} of ${total} done` +
        (failN ? ` · <span style="color:var(--bad)">${failN} failed</span>` : '')
      : '<b>Idle</b>';
    $('#dockBar').style.width = '0%';
    $('#dockDetail').textContent = '';
  }

  if (S.activeView === 'queue') {
    renderQueueFilters();
    renderFullQueue();
  }
}

const thumbCache = new Map();
const thumbTried = new Set();

/** Queue thumbnails are remote (often hotlink-protected) — fetch them via main. */
function fillQueueThumbs() {
  const nodes = $$('#fullQueue .qthumb[data-thumb]');
  for (const el of nodes) {
    const raw = el.dataset.thumb || '';
    if (!raw) continue;
    if (thumbCache.has(raw)) {
      el.style.backgroundImage = `url("${thumbCache.get(raw)}")`;
      continue;
    }
    if (thumbTried.has(raw)) continue;
    thumbTried.add(raw);
    bridge.thumb(raw, '').then((dataUrl) => {
      if (!dataUrl) return;
      thumbCache.set(raw, dataUrl);
      fillQueueThumbs();
    }).catch(() => {});
  }
}

function renderFullQueue() {
  const box = $('#fullQueue');
  if (!S.queue.length) {
    box.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="4" width="18" height="4" rx="1.5"/><rect x="3" y="11" width="18" height="4" rx="1.5"/><rect x="3" y="18" width="12" height="3" rx="1.5"/></svg><div>Queue is empty. Fetch a link and press <b>Download</b>.</div></div>`;
    return;
  }
  const rowsToShow = visibleQueue();
  if (!rowsToShow.length) {
    const label = (QFILTERS.find((f) => f[0] === queueFilter) || QFILTERS[0])[1];
    box.innerHTML = `<div class="empty-state"><div>No ${label.toLowerCase()} videos right now.</div></div>`;
    return;
  }
  pruneSelection();
  box.innerHTML = rowsToShow
    .map((it) => {
      const canPick = canSelect(it);
      const isSel = canPick && selIds.has(it.id);
      const cls = (it.status === 'done' ? 'done' : it.status === 'failed' ? 'failed' : '') + (isSel ? ' sel' : '');
      const pct = it.status === 'done' ? 100 : it.percent || 0;
      const pick = canPick
        ? `<input type="checkbox" class="qchk" data-id="${it.id}" ${isSel ? 'checked' : ''} title="Select this video">`
        : `<input type="checkbox" class="qchk" disabled title="Finished — nothing left to do">`;
      const thumb = `<div class="qthumb" data-thumb="${esc(it.thumbnail || '')}"></div>`;
      // where this row will actually land (fixed when it was queued)
      const dirFull = it.downloadDir || S.settings.downloadDir || '';
      const dirName = dirFull.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dirFull;
      const dirChip = dirFull
        ? `<span class="qdir" title="${esc(dirFull)}">${esc(dirName)}</span>`
        : '';
      const actions = [];
      if (it.status === 'running' || it.status === 'processing' || it.status === 'resolving' || it.status === 'queued')
        actions.push(`<button class="ibtn" data-act="cancel" data-id="${it.id}" title="Cancel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`);
      if (it.status === 'failed' || it.status === 'cancelled' || it.status === 'done')
        actions.push(`<button class="ibtn" data-act="retry" data-id="${it.id}" title="Download again"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5"/></svg></button>`);
      if (it.status === 'done' && it.filepath)
        actions.push(`<button class="ibtn" data-act="reveal" data-id="${it.id}" title="Show in folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h6l2 2h10v9a1 1 0 01-1 1H3z"/></svg></button>`);
      if (it.status !== 'running' && it.status !== 'processing')
        actions.push(`<button class="ibtn" data-act="remove" data-id="${it.id}" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>`);

      return `<div class="qrow ${cls}" data-id="${it.id}">
        ${pick}
        ${thumb}
        <div class="qbody">
          <div class="qtitle">${esc(it.title || it.url)}${
            it.duration ? `<span class="qdur">${fmtDuration(it.duration)}</span>` : ''
          }${dirChip}</div>
          <div class="track"><div class="fill" style="width:${pct}%"></div></div>
          <div class="qstat">
            <span class="badge-st ${it.status === 'processing' ? 'processing' : it.status === 'running' ? 'running' : it.status}">${esc(it.status)}</span>
            <span>${esc(it.error || it.note || statusText(it))}${
              it.lastLine && it.error && it.lastLine !== it.error
                ? ` <span style="color:var(--txt3)">· ${esc(it.lastLine.slice(0, 120))}</span>`
                : ''
            }</span>
          </div>
        </div>
        <div class="qactions">${actions.join('')}</div>
      </div>`;
    })
    .join('');

  fillQueueThumbs();

  // tick boxes, and clicking anywhere on a waiting row toggles it as well;
  // shift-click extends the selection from the last plain click
  $$('#fullQueue .qchk[data-id]').forEach((c) => {
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      // no preventDefault: cancelling a checkbox click makes the browser restore
      // the old tick right after this handler, so the box fights the selection set
      handlePick(c.dataset.id, e.shiftKey);
    });
  });
  $$('#fullQueue .qrow[data-id]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const id = row.dataset.id;
      const it = S.queue.find((x) => x.id === id);
      if (!it || !pickable(it)) return;
      handlePick(id, e.shiftKey);
    });
  });
  updateSelUi();

  // (the row buttons are handled by one delegated listener, see below — attaching
  // per-render listeners here left freshly rendered rows with dead buttons)
}

/* ---- row buttons: ONE delegated listener each, because these lists are
   re-rendered constantly and per-render listeners kept going stale ---- */
async function revealFile(p) {
  const res = await bridge.revealPath(p || '');
  if (res && res.ok) {
    if (res.missing) toast('That file is gone — opened its folder instead.', 'err');
    return;
  }
  toast(
    res && res.reason === 'no path' ? 'No file recorded for this row.' : 'That file is no longer on disk, and its folder is gone too.',
    'err'
  );
}

async function openFile(p) {
  const res = await bridge.openPath(p || '');
  if (res && res.ok) {
    if (res.missing) toast('That file is gone — opened its folder instead.', 'err');
    return;
  }
  toast(res && res.reason === 'no path' ? 'No file recorded for this row.' : 'Could not open that file.', 'err');
}

$('#fullQueue').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !b.dataset.act) return;
  const id = b.dataset.id;
  const it = S.queue.find((x) => x.id === id);
  if (b.dataset.act === 'cancel') bridge.cancel(id);
  else if (b.dataset.act === 'retry') bridge.retry(id);
  else if (b.dataset.act === 'remove') bridge.remove(id);
  else if (b.dataset.act === 'reveal') revealFile(it && it.filepath);
});

$('#historyList').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { openFile(open.dataset.open); return; }
  const rev = e.target.closest('[data-rev]');
  if (rev) revealFile(rev.dataset.rev);
});

/* ---- right-click a queue row: open its link in the browser, copy it, reveal it ---- */
const rowMenu = $('#rowMenu');
let rowMenuItem = null;

function hideRowMenu() {
  rowMenu.classList.add('hidden');
}

$('#fullQueue').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.qrow[data-id]');
  if (!row) return;
  e.preventDefault();
  const it = S.queue.find((x) => x.id === row.dataset.id);
  if (!it) return;
  rowMenuItem = it;
  const revealBtn = rowMenu.querySelector('[data-act="reveal"]');
  if (revealBtn) revealBtn.disabled = !it.filepath;
  rowMenu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
  rowMenu.style.top = Math.min(e.clientY, window.innerHeight - 140) + 'px';
  rowMenu.classList.remove('hidden');
});

rowMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const it = rowMenuItem;
  hideRowMenu();
  if (!it) return;
  if (btn.dataset.act === 'open') {
    const res = await bridge.openExternal(it.url);
    if (res && res.ok) toast('Opened in your browser.', 'ok');
    else toast('That row has no web link.', 'err');
  } else if (btn.dataset.act === 'copy') {
    await bridge.clipboardWrite(it.url);
    toast('Link copied — paste it in your browser.', 'ok');
  } else if (btn.dataset.act === 'capture') {
    toast('A VK window is opening — press play (and “Watch” if VK asks) and the download starts by itself.', 'ok');
    const res = await bridge.vkCapture(it.url);
    if (!res || !res.ok) { toast((res && res.error) || 'Nothing was captured.', 'err'); return; }
    const add = await bridge.download({
      url: res.mediaUrl,
      resolvedUrl: res.mediaUrl,
      resolvedReferer: res.referer,
      directFormats: true,
      title: it.title || '',
      preset: it.preset || 'best',
      folder: it.folder || '',
      duration: it.duration || 0,
      thumbnail: it.thumbnail || '',
    });
    if (add && add.id) toast('Stream captured — downloading now.', 'ok');
    else toast((add && add.error) || 'Could not queue that stream.', 'err');
  } else if (btn.dataset.act === 'reveal') {
    revealFile(it.filepath);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!rowMenu.classList.contains('hidden') && !rowMenu.contains(e.target)) hideRowMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideRowMenu(); });
window.addEventListener('blur', hideRowMenu);

/* ─────────────────────────── history ─────────────────────────── */
async function renderHistory() {
  const list = await bridge.history();
  const box = $('#historyList');
  $('#historyCount').textContent = String(list.length);
  if (!list.length) {
    box.innerHTML = `<div class="empty-state"><div>No downloads yet.</div></div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (h) => `<div class="hrow">
        <div class="hthumb none" data-hthumb="${esc(h.filepath || '')}"></div>
        <div class="hmeta">
          <div class="htitle">${esc(h.title)}</div>
          <div class="hsub">${esc(h.filepath || h.url)}</div>
        </div>
        <div class="qactions">
          <button class="ibtn" data-open="${esc(h.filepath || '')}" title="Open file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg></button>
          <button class="ibtn" data-rev="${esc(h.filepath || '')}" title="Show in folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h6l2 2h10v9a1 1 0 01-1 1H3z"/></svg></button>
        </div>
      </div>`
    )
    .join('');
  fillHistoryThumbs();
}

/**
 * Posters for history rows. Main grabs a frame from the finished file once and
 * caches it on disk, so the requests run one after another (never 90 ffmpeg
 * processes at once) and the answers are kept in a map: a re-render paints the
 * known pictures immediately instead of asking again and leaving empty boxes.
 */
const histThumbs = new Map(); // filepath -> data URL, '' when there is no picture
const histPending = new Set();
let histChain = Promise.resolve();

function fillHistoryThumbs() {
  for (const el of $$('#historyList .hthumb[data-hthumb]')) {
    const fp = el.dataset.hthumb;
    if (!fp) continue;
    const cached = histThumbs.get(fp);
    if (cached) {
      el.style.backgroundImage = `url("${cached}")`;
      el.classList.remove('none');
      continue;
    }
    if (histPending.has(fp)) continue;
    histPending.add(fp);
    histChain = histChain.then(async () => {
      const src = await bridge.historyThumb(fp).catch(() => null);
      histPending.delete(fp);
      histThumbs.set(fp, src || '');
      if (src) fillHistoryThumbs(); // paint it on whatever rows exist now
    });
  }
}

/* ─────────────────────────── presets (saved settings) ─────────────────────────── */
function renderPresetsView() {
  const box = $('#presetList');
  const list = S.settings.presets || [];
  $('#presetCount').textContent = String(list.length);
  if (!list.length) {
    box.innerHTML = `<div class="empty-state"><div>No presets yet. Configure the download settings, then press <b>Save current settings as preset</b>.</div></div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (p, i) => `<div class="hrow">
        <div class="hmeta">
          <div class="htitle">${esc(p.name)}</div>
          <div class="hsub">${esc(p.summary || '')}</div>
        </div>
        <div class="qactions">
          <button class="btn ghost sm" data-apply="${i}">Apply</button>
          <button class="ibtn" data-del="${i}" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
      </div>`
    )
    .join('');
  $$('#presetList [data-apply]').forEach(
    (b) =>
      (b.onclick = async () => {
        const p = list[Number(b.dataset.apply)];
        await save(p.values);
        applyTheme();
        toast(`Applied preset “${p.name}”.`, 'ok');
      })
  );
  $$('#presetList [data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        const next = list.slice();
        next.splice(Number(b.dataset.del), 1);
        await save({ presets: next });
        renderPresetsView();
      })
  );
}

function askName(title, placeholder) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const inp = $('#modalInput');
    $('#modalTitle').textContent = title;
    inp.placeholder = placeholder || '';
    inp.value = '';
    modal.classList.remove('hidden');
    inp.focus();
    const done = (val) => {
      modal.classList.add('hidden');
      $('#modalOk').onclick = null;
      $('#modalCancel').onclick = null;
      inp.onkeydown = null;
      resolve(val);
    };
    $('#modalOk').onclick = () => done(inp.value.trim());
    $('#modalCancel').onclick = () => done('');
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); if (e.key === 'Escape') done(''); };
  });
}

/** Yes/no modal. Resolves true only when the confirm button is pressed. */
function askConfirm(title, text, okLabel = 'Remove') {
  return new Promise((resolve) => {
    const modal = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text || '';
    $('#confirmOk').textContent = okLabel;
    modal.classList.remove('hidden');
    const done = (val) => {
      modal.classList.add('hidden');
      $('#confirmOk').onclick = null;
      $('#confirmCancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    $('#confirmOk').onclick = () => done(true);
    $('#confirmCancel').onclick = () => done(false);
    document.addEventListener('keydown', onKey);
    $('#confirmCancel').focus();
  });
}

$('#btnSavePreset').onclick = async () => {
  const name = await askName('Save preset', 'e.g. MP4 1080p with subs');
  if (!name) return;
  const values = {
    container: S.settings.container,
    audioFormat: S.settings.audioFormat,
    subs: S.settings.subs,
    subsLangs: S.settings.subsLangs,
    embedMetadata: S.settings.embedMetadata,
    embedThumbnail: S.settings.embedThumbnail,
    sponsorblock: S.settings.sponsorblock,
    cookiesBrowser: S.settings.cookiesBrowser,
    speedLimit: S.settings.speedLimit,
    fragments: S.settings.fragments,
  };
  const summary = [values.container, values.subs ? 'subs ' + values.subsLangs : 'no subs', values.sponsorblock !== 'off' ? 'SB ' + values.sponsorblock : '', values.cookiesBrowser !== 'none' ? 'cookies ' + values.cookiesBrowser : '']
    .filter(Boolean)
    .join(' · ');
  const presets = [...(S.settings.presets || []), { name, summary, values }];
  await save({ presets });
  renderPresetsView();
  toast('Preset saved.', 'ok');
};


/* ─────────────────────────── all options ─────────────────────────── */
async function ensureSchema() {
  if (S.schema) return;
  const res = await bridge.schema();
  if (!res.ok) { $('#optGroups').innerHTML = `<div class="empty-state"><div>Could not read options: ${esc(res.error)}</div></div>`; return; }
  S.schema = res.groups;
  const n = S.schema.reduce((a, g) => a + g.options.length, 0);
  $('#optSearch').placeholder = `Search ${n} options…`;
  renderOptions();
}

function renderOptions() {
  const q = ($('#optSearch').value || '').toLowerCase().trim();
  const onlyChanged = $('#chkChanged').checked;
  const vals = S.settings.optionValues || {};
  const box = $('#optGroups');
  let html = '';
  let shown = 0;

  for (const g of S.schema) {
    const opts = g.options.filter((o) => {
      const isSet = Object.prototype.hasOwnProperty.call(vals, o.key);
      if (onlyChanged && !isSet) return false;
      if (!q) return true;
      return (o.key + ' ' + o.flags.join(' ') + ' ' + o.help).toLowerCase().includes(q);
    });
    if (!opts.length) continue;
    shown += opts.length;
    html += `<div class="ogroup ${q ? '' : 'closed'}" data-group="${esc(g.name)}">
      <div class="ohead"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        ${esc(g.name)} <span class="ocount">${opts.length}</span></div>
      <div class="obody">${opts
        .map((o) => {
          const isSet = Object.prototype.hasOwnProperty.call(vals, o.key);
          const v = isSet ? vals[o.key] : '';
          const isBool = !o.takesValue && !o.metavar;
          return `<div class="orow ${isSet ? 'set' : ''}">
            <span class="oflag">${esc(o.flags.join(', '))}</span>
            <span class="ohelp">${esc(o.help).slice(0, 260)}</span>
            <span class="octl">${
              isBool
                ? `<button class="sw ${v === true ? 'on' : ''}" data-flag="${esc(o.key)}" data-type="bool"></button>`
                : `<input type="text" data-flag="${esc(o.key)}" data-type="text" value="${esc(typeof v === 'string' ? v : '')}" placeholder="${esc(o.metavar || 'value')}" />`
            }</span>
          </div>`;
        })
        .join('')}</div>
    </div>`;
  }

  box.innerHTML = shown
    ? html
    : `<div class="empty-state"><div>No option matches “${esc(q)}”.</div></div>`;

  $$('#optGroups .ohead').forEach((h) => (h.onclick = () => h.parentElement.classList.toggle('closed')));

  $$('#optGroups [data-type="bool"]').forEach(
    (b) =>
      (b.onclick = async () => {
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        const vals2 = { ...(S.settings.optionValues || {}) };
        if (on) vals2[b.dataset.flag] = true;
        else delete vals2[b.dataset.flag];
        b.closest('.orow').classList.toggle('set', on);
        await save({ optionValues: vals2 });
      })
  );

  $$('#optGroups [data-type="text"]').forEach((inp) => {
    let t;
    inp.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const vals2 = { ...(S.settings.optionValues || {}) };
        const v = inp.value.trim();
        if (v) vals2[inp.dataset.flag] = v;
        else delete vals2[inp.dataset.flag];
        inp.closest('.orow').classList.toggle('set', !!v);
        await save({ optionValues: vals2 });
      }, 300);
    };
  });
}

$('#optSearch').addEventListener('input', () => { if (S.schema) renderOptions(); });
$('#chkChanged').addEventListener('change', () => { if (S.schema) renderOptions(); });

/* ─────────────────────────── settings screen ─────────────────────────── */
const sw3 = (id, on) => { const el = $(id); if (el) el.classList.toggle('on', !!on); };

function syncSettingsUI() {
  const s = S.settings;
  $('#folderText').textContent = s.downloadDir || '';
  const sf = $('#setFolder');
  if (sf) sf.value = s.downloadDir || '';
  if ($('#setTemplate')) $('#setTemplate').value = s.outputTemplate || '';
  if ($('#setAudioFmt')) $('#setAudioFmt').value = s.audioFormat || 'mp3';
  if ($('#setSubLangs')) $('#setSubLangs').value = s.subsLangs || '';
  if ($('#setCookies')) $('#setCookies').value = s.cookiesBrowser || 'none';
  if ($('#setSpeed')) $('#setSpeed').value = s.speedLimit || '';
  if ($('#setFragments')) $('#setFragments').value = s.fragments || 1;
  if ($('#setConcurrency')) $('#setConcurrency').value = s.concurrency || 1;
  if ($('#setRetries')) $('#setRetries').value = s.retries ?? 10;
  if ($('#setSB')) $('#setSB').value = s.sponsorblock || 'off';
  if ($('#setExtra')) $('#setExtra').value = s.extraArgs || '';
  if ($('#setCodec')) $('#setCodec').value = s.codecPreference || 'h264';
  if ($('#selCookies')) $('#selCookies').value = s.cookiesBrowser || 'none';
  if ($('#inpSpeed')) $('#inpSpeed').value = s.speedLimit || '';

  if ($('#setCookiesFile')) $('#setCookiesFile').value = s.cookiesFile || '';
  sw3('#setImpersonate', s.impersonate !== false);
  sw3('#setGroupFolders', s.groupFolders !== false);

  const sw = (id, on) => { const el = $(id); if (el) el.classList.toggle('on', !!on); };
  sw('#swSubs', s.subs);
  sw('#setSubs', s.subs);
  sw('#setSubsAuto', s.subsAuto);
  sw('#setSubsEmbed', s.subsEmbed);
  sw('#swMeta', s.embedMetadata);
  sw('#swThumb', s.embedThumbnail);

  $$('#segContainer button').forEach((b) => b.classList.toggle('on', b.dataset.v === (s.container || 'mp4')));
  $$('#segTheme button').forEach((b) => b.classList.toggle('on', b.dataset.v === (s.theme || 'dark')));
  $$('#accents button').forEach((b) => b.classList.toggle('on', b.dataset.a === (s.accent || 'violet')));
  $('#subsLangs').textContent = (s.subsLangs || '').replace(/,/g, ', ');
  $('#chipSB').textContent = 'SponsorBlock: ' + (s.sponsorblock || 'off');
  $('#chipThumb').textContent = s.embedThumbnail ? 'Embed thumbnail' : 'No thumbnail';
}

/* bind the small widgets */
$$('#segContainer button').forEach((b) =>
  b.onclick = async () => { await save({ container: b.dataset.v }); }
);
$('#swSubs').onclick = () => save({ subs: !S.settings.subs });
$('#swMeta').onclick = () => save({ embedMetadata: !S.settings.embedMetadata });
$('#swThumb').onclick = () => save({ embedThumbnail: !S.settings.embedThumbnail });
$('#selCookies').onchange = (e) => save({ cookiesBrowser: e.target.value });
$('#inpRange').onchange = () => {};
$('#inpSpeed').onchange = (e) => save({ speedLimit: e.target.value.trim() });

$('#btnFolder').onclick = async () => {
  const dir = await bridge.pickFolder();
  if (!dir) return;
  // the picker already saved it in main, but the renderer's copy has to follow:
  // new rows snapshot S.settings.downloadDir when they are queued, so a stale
  // copy here sends them to the folder the user just changed away from
  await save({ downloadDir: dir });
  toast('New videos will be saved in: ' + dir, 'ok');
};

if ($('#btnPickFolder')) $('#btnPickFolder').onclick = async () => {
  const dir = await bridge.pickFolder();
  if (!dir) return;
  await save({ downloadDir: dir });
  toast('New videos will be saved in: ' + dir, 'ok');
};
if ($('#setFolder')) {
  // typing a path by hand must be saved too, not just written into the box
  $('#setFolder').onchange = (e) => save({ downloadDir: e.target.value.trim() });
  $('#setTemplate').onchange = (e) => save({ outputTemplate: e.target.value.trim() });
  $('#setAudioFmt').onchange = (e) => save({ audioFormat: e.target.value });
  $('#setSubLangs').onchange = (e) => { save({ subsLangs: e.target.value.trim() }); };
  $('#setCookies').onchange = (e) => save({ cookiesBrowser: e.target.value });
  $('#setSpeed').onchange = (e) => save({ speedLimit: e.target.value.trim() });
  $('#setFragments').onchange = (e) => save({ fragments: Math.max(1, Number(e.target.value) || 1) });
  if ($('#setConcurrency'))
    $('#setConcurrency').onchange = async (e) => {
      const n = Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1)));
      e.target.value = n;
      await save({ concurrency: n });
      toast(n === 1 ? 'Downloads run one after another.' : `Up to ${n} videos download at once.`, 'ok');
    };
  $('#setRetries').onchange = (e) => save({ retries: Math.max(0, Number(e.target.value) || 0) });
  $('#setSB').onchange = (e) => save({ sponsorblock: e.target.value });
  $('#setExtra').onchange = (e) => save({ extraArgs: e.target.value.trim() });
  $('#setCodec').onchange = (e) => save({ codecPreference: e.target.value });
  $('#setSubs').onclick = () => save({ subs: !S.settings.subs });
  $('#setSubsAuto').onclick = () => save({ subsAuto: !S.settings.subsAuto });
  $('#setSubsEmbed').onclick = () => save({ subsEmbed: !S.settings.subsEmbed });
  $('#setImpersonate').onclick = () => save({ impersonate: !(S.settings.impersonate !== false) });
  $('#setGroupFolders').onclick = () => save({ groupFolders: !(S.settings.groupFolders !== false) });
  $('#btnPickCookies').onclick = async () => {
    const f = await bridge.pickFile({ title: 'Choose cookies.txt', filters: [{ name: 'Cookies', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }] });
    if (f) { await save({ cookiesFile: f }); toast('Cookies file: ' + f, 'ok'); }
  };
  $$('#segTheme button').forEach((b) => (b.onclick = async () => { await save({ theme: b.dataset.v }); applyTheme(); }));
  $$('#accents button').forEach((b) => (b.onclick = async () => { await save({ accent: b.dataset.a }); applyTheme(); }));
}

/* backup & restore settings */
$('#btnBackupSettings').onclick = async () => {
  const res = await bridge.backupSettings();
  if (!res || !res.ok) {
    if (res && res.error) toast(res.error, 'err');
    return;
  }
  const jars = res.cookies ? ` · ${res.cookies} cookie file${res.cookies > 1 ? 's' : ''} included` : '';
  toast(`Backup saved to ${res.path}${jars}`, 'ok');
};

$('#btnRestoreSettings').onclick = async () => {
  const ok = await askConfirm(
    'Restore settings from a backup?',
    'Every setting will be replaced by the backup file. Your download history and queue stay as they are.',
    'Restore'
  );
  if (!ok) return;
  const res = await bridge.restoreSettings();
  if (!res || !res.ok) {
    toast((res && res.error) || 'That backup could not be restored.', 'err');
    return;
  }
  S.settings = res.settings;
  applyTheme();
  syncSettingsUI();
  toast('Settings restored' + (res.cookies ? ` · ${res.cookies} cookie file${res.cookies > 1 ? 's' : ''} put back` : '') + '.', 'ok');
};

/* pause */
const isActiveStatus = (s) => s === 'running' || s === 'processing' || s === 'resolving';

function selectionHasActive() {
  for (const id of selIds) {
    const it = S.queue.find((x) => x.id === id);
    if (it && isActiveStatus(it.status)) return true;
  }
  return false;
}

function setPauseLabels() {
  const n = selIds.size;
  // the label follows the selection: running rows can be paused, waiting rows started
  const label = n
    ? selectionHasActive()
      ? `Pause selected (${n})`
      : `Resume selected (${n})`
    : pauseState
    ? 'Resume all'
    : 'Pause all';
  $$('#btnPause, #btnPauseAll').forEach((b) => (b.textContent = label));
}

async function togglePause() {
  const ids = [...selIds];
  // with rows selected the button works on them only, not on the whole queue
  if (ids.length) {
    if (selectionHasActive()) {
      const n = await bridge.pauseSelected(ids);
      toast(
        n ? `Paused ${n} selected video${n === 1 ? '' : 's'} — the rest keep going.` : 'Nothing in the selection is running.',
        n ? 'ok' : 'err'
      );
    } else {
      const n = await bridge.resumeSelected(ids);
      toast(
        n ? `Starting ${n} selected video${n === 1 ? '' : 's'} — the rest stay paused.` : 'Nothing in the selection can be resumed.',
        n ? 'ok' : 'err'
      );
    }
    selIds.clear();
    selAnchor = null;
    renderFullQueue();
    return;
  }
  const isPaused = await bridge.paused();
  pauseState = !isPaused;
  if (pauseState) await bridge.pauseAll();
  else await bridge.resumeAll();
  setPauseLabels();
}
$('#btnPause').onclick = togglePause;
$('#btnPauseAll').onclick = togglePause;

/* update */
async function doUpdate() {
  const btns = $$('#btnUpdate, #btnUpdate2');
  btns.forEach((b) => (b.disabled = true));
  const old = $('#btnUpdate').innerHTML;
  $('#btnUpdate').textContent = 'Updating…';
  try {
    const r = await bridge.update();
    $('#verText').textContent = 'yt-dlp ' + r.version;
    $('#chipVersion').textContent = 'yt-dlp ' + r.version;
    const upToDate = /up to date/i.test(r.output || '');
    toast(
      r.ok
        ? upToDate
          ? `yt-dlp ${r.version} is already the latest version.`
          : `yt-dlp updated to ${r.version}.`
        : 'Update failed: ' + (r.output || 'unknown error').slice(0, 160),
      r.ok ? 'ok' : 'err'
    );
  } catch (e) {
    toast('Update failed: ' + e.message, 'err');
  } finally {
    btns.forEach((b) => (b.disabled = false));
    $('#btnUpdate').innerHTML = old;
  }
}
$('#btnUpdate').onclick = doUpdate;
$('#btnUpdate2').onclick = doUpdate;

/* engines: version line, rollback, portable import */
async function refreshEngines() {
  try {
    const info = await bridge.enginesInfo();
    const line = $('#engVersionLine');
    if (line) {
      const same = info.version === info.bundledVersion;
      line.textContent = `yt-dlp ${info.version}` +
        (info.bundledVersion ? ` · shipped with this build: ${info.bundledVersion}` : '') +
        (same ? '' : ' · using your updated copy');
    }
    if (info.data) S.dataDir = info.data;
  } catch (_) {}
}
if ($('#btnRestoreEngines')) {
  $('#btnRestoreEngines').onclick = async () => {
    const ok = await askConfirm('Restore bundled yt-dlp?', 'The yt-dlp that shipped with this build replaces the one you updated to. Your queue and settings are not touched.', 'Restore');
    if (!ok) return;
    const r = await bridge.restoreEngines();
    await refreshEngines();
    toast(r && r.ok ? `Bundled engines restored — yt-dlp ${r.version}.` : 'Could not restore the bundled engines.', r && r.ok ? 'ok' : 'err');
  };
}
if ($('#btnImportPortable')) {
  $('#btnImportPortable').onclick = async () => {
    const r = await bridge.importData();
    if (!r || r.cancelled) return;
    if (!r.ok) { toast((r && r.error) || 'Import failed.', 'err'); return; }
    toast(`Imported ${r.queue} queue rows and ${r.history} history entries. Reloading…`, 'ok');
    setTimeout(() => location.reload(), 1200);
  };
}
if ($('#btnOpenData')) {
  $('#btnOpenData').onclick = async () => {
    const info = await bridge.enginesInfo().catch(() => null);
    if (info && info.data) bridge.openPath(info.data);
  };
}

/* ─────────────────────────── cookie jars ─────────────────────────── */
function guessDomain() {
  const raw = (urlInput.value || '').trim();
  try {
    if (raw) return new URL(raw.startsWith('http') ? raw : 'https://' + raw).hostname.replace(/^www\./, '');
  } catch (_) {}
  return '';
}

async function renderJars() {
  const box = $('#jarList');
  if (!box) return;
  const jars = await bridge.listCookies();
  box.innerHTML = jars.length
    ? jars.map((j) => `<div class="jar"><b>${esc(j.domain)}</b> · ${j.count} cookies<span class="x" data-x="${esc(j.domain)}">remove</span></div>`).join('')
    : '';
  box.querySelectorAll('[data-x]').forEach((el) => {
    el.onclick = async () => {
      await bridge.clearCookies(el.dataset.x);
      renderJars();
      toast('Cookies removed for ' + el.dataset.x, 'ok');
    };
  });
}

function openCookieModal() {
  const modal = $('#cookieModal');
  const guess = guessDomain();
  $('#ckDomain').value = guess;
  $('#ckRaw').value = '';
  $('#ckStatus').textContent = /(^|\.)vk\.(com|ru)$|vkvideo\./i.test(guess)
    ? 'For VK: export the cookies while you are on https://vk.com (not vkvideo.ru) — the sign-in cookie “remixsid” only exists there. Cookie-Editor → Export → JSON, then paste it here. The app copies it to vkvideo.ru for you.'
    : '';
  modal.classList.remove('hidden');
  ($('#ckRaw').value ? $('#ckRaw') : ($('#ckDomain').value ? $('#ckRaw') : $('#ckDomain'))).focus();
}

function closeCookieModal() {
  $('#cookieModal').classList.add('hidden');
}

async function saveCookieModal() {
  const raw = $('#ckRaw').value;
  const domain = $('#ckDomain').value.trim();
  if (!raw.trim()) { $('#ckStatus').textContent = 'Paste the Cookie value first.'; return; }
  const res = await bridge.saveCookies({ raw, domain });
  if (!res || !res.ok) { $('#ckStatus').textContent = (res && res.error) || 'Could not save those cookies.'; return; }
  renderJars();
  if (res.warning) {
    // keep the dialog open so he can fix it right away instead of hunting later
    $('#ckStatus').textContent = res.warning;
    toast('Those cookies are saved, but none of them logs you in.', 'err');
    return;
  }
  closeCookieModal();
  const extra = res.copies ? ' (copied to vk.com / vk.ru / vkvideo.ru)' : '';
  toast(`Saved ${res.count} cookie${res.count === 1 ? '' : 's'} for ${res.domain}${extra} — login cookie included.`, 'ok');
}

if ($('#btnPasteCookies')) $('#btnPasteCookies').onclick = openCookieModal;
if ($('#btnPasteCookies2')) $('#btnPasteCookies2').onclick = openCookieModal;
if ($('#ckTest')) $('#ckTest').onclick = async () => {
  const status = $('#ckStatus');
  const url = ($('#urlInput') && $('#urlInput').value.trim()) || '';
  if (!url) { status.textContent = 'Put the video link in the address bar first, then press Test.'; return; }
  status.textContent = 'Asking the site with these cookies…';
  const res = await bridge.testCookies({ url, domain: $('#ckDomain').value.trim() });
  if (res && res.ok) {
    status.textContent = `Cookies work — the site answered with: ${res.title}`;
    toast('These cookies are signed in.', 'ok');
  } else {
    status.textContent = (res && res.error) || 'That did not work.';
  }
};
if ($('#ckCancel')) $('#ckCancel').onclick = closeCookieModal;
if ($('#ckSave')) $('#ckSave').onclick = saveCookieModal;
if ($('#ckRaw')) $('#ckRaw').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCookieModal(); });

/* ─────────────────────────── drag & drop ─────────────────────────── */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropOverlay').classList.remove('hidden'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.add('hidden'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.add('hidden');
  const files = Array.from(e.dataTransfer.files || []);
  const text = e.dataTransfer.getData('text');
  if (files.length) {
    const txt = files.find((f) => /\.txt$/i.test(f.name));
    if (txt) {
      const content = await txt.text();
      const urls = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
      for (const u of urls) await bridge.download({ url: u, title: u, preset: S.preset });
      toast(`Queued ${urls.length} links from ${txt.name}.`, 'ok');
      return;
    }
  }
  if (text && /^https?:/i.test(text.trim())) { urlInput.value = text.trim(); fetchUrl(); }
});

/* ─────────────────────────── init ─────────────────────────── */
function showOnboarding() {
  const ob = $('#onboarding');
  ob.classList.remove('hidden');
  const folderEl = $('#obFolder');
  const cont = $('#obContinue');
  const suggested = S.suggestedDir || '';
  if (suggested) folderEl.textContent = suggested;
  $('#obChoose').onclick = async () => {
    const dir = await bridge.pickFolder();
    if (!dir) return;
    S.settings.downloadDir = dir;
    folderEl.textContent = dir;
    cont.disabled = false;
    $('#obHint').textContent = 'Good. You can change this any time in Settings.';
  };
  cont.onclick = async () => {
    if (!S.settings.downloadDir) return;
    await save({ downloadDir: S.settings.downloadDir, setupDone: true });
    ob.classList.add('hidden');
    syncSettingsUI();
    toast('Downloads will be saved to ' + S.settings.downloadDir, 'ok');
  };
}

async function init() {
  const st = await bridge.getState();
  S.settings = st.settings;
  S.queue = st.queue || [];
  applyTheme();
  syncSettingsUI();

  S.suggestedDir = st.defaultDir || '';
  pauseState = !!st.paused;
  setPauseLabels();
  if (!S.settings.setupDone || !S.settings.downloadDir) showOnboarding();

  $('#verText').textContent = 'yt-dlp ' + st.deps.ytdlp;
  $('#chipVersion').textContent = 'yt-dlp ' + st.deps.ytdlp;
  $('#verSub').textContent = st.deps.ffmpeg && st.deps.deno ? 'ffmpeg + deno ready' : 'some engines missing';
  $('#chipEngines').innerHTML = `<span class="dot ${st.deps.ffmpeg && st.deps.deno ? '' : 'bad'}"></span> ${st.deps.ffmpeg && st.deps.deno ? 'engines ready' : 'missing engine'}`;
  $('#aboutVersion').textContent = 'v' + st.appVersion;
  $('#engDir').textContent = st.deps.binDir;
  $('#engList').innerHTML = [
    ['yt-dlp', st.deps.ytdlp, true],
    ['ffmpeg', st.deps.ffmpeg ? 'bundled' : 'missing', st.deps.ffmpeg],
    ['deno (YouTube JS)', st.deps.deno ? 'bundled' : 'missing', st.deps.deno],
  ]
    .map(([n, v, ok]) => `<div class="erow"><span>${n}</span><span class="st ${ok ? '' : 'bad'}">${esc(v)}</span></div>`)
    .join('');

  const free = st.freeSpace ? ` · ${fmtBytes(st.freeSpace)} free` : '';
  $('#dockFree').textContent = (S.settings.downloadDir || '') + free;

  renderQueue();
  renderPresetsView();
  renderHistory();
  urlInput.focus();

  bridge.events.queue((q) => { S.queue = q; renderQueue(); });
  bridge.events.paused((p) => { pauseState = !!p; setPauseLabels(); });
  bridge.events.log(() => {});
  bridge.events.toast((t) => toast(t.text, t.kind));

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'v' && document.activeElement !== urlInput) {
      /* native paste works inside inputs; nothing to do elsewhere */
    }
    if (e.key === 'Escape') $('#dropOverlay').classList.add('hidden');
  });
}

init();
})();
