'use strict';
/**
 * yt-dlp engine wrapper: metadata, option schema, download queue, self-update.
 * Talks to the bundled yt-dlp.exe only — never to a PATH copy.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exe, binDir, dataDir, ensureBins } = require('./paths');
const resolvers = require('./resolvers');

// Sites whose pages yt-dlp cannot read: the stream URL has to be sniffed.
// Sites that must be resolved by app/resolvers.js before yt-dlp sees the URL.
// yt-dlp handles everything else on its own.
const NEEDS_RESOLVE = [];
function needsResolve(url) {
  return NEEDS_RESOLVE.some((re) => re.test(String(url || '')));
}

const PROGRESS_TPL =
  'download:P|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|' +
  '%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|' +
  '%(progress.fragment_index)s|%(progress.fragment_count)s';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const POSTPROC_TPL = 'postprocess:PP|%(progress.postprocessor)s|%(progress.status)s|%(progress.eta)s';

function childEnv() {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env };
  env[pathKey] = binDir() + ';' + (process.env[pathKey] || '');
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

/**
 * VK serves its video pages from vkvideo.ru / vk.ru, but yt-dlp asks
 * https://vk.com/al_video.php — so a jar saved for one of those hosts has to
 * serve all of them, otherwise the request goes out with no Cookie header and
 * VK answers "Access restricted".
 */
function jarFamily(host) {
  return /(^|\.)(vk\.com|vk\.ru|vkvideo\.ru|vkvideo\.com|vk\.me)$/i.test(String(host || '')) ? 'vk' : null;
}

function cookieJarFor(url, settings = {}) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch (_) {}
  const jars = settings.cookieJars || {};
  let best = null;
  for (const [domain, file] of Object.entries(jars)) {
    if (!file || !fs.existsSync(file)) continue;
    const d = String(domain).replace(/^\./, '').toLowerCase();
    const exact = host === d || host.endsWith('.' + d);
    const sameFamily = !exact && jarFamily(host) && jarFamily(host) === jarFamily(d);
    if (!exact && !sameFamily) continue;
    const score = exact ? 2 : 1;
    if (!best || score > best.score || (score === best.score && d.length > best.len)) best = { score, len: d.length, file };
  }
  if (best) return best.file;
  if (settings.cookiesFile && fs.existsSync(settings.cookiesFile)) return settings.cookiesFile;
  return null;
}

function baseArgs(settings = {}, url = null) {
  const a = [
    '--no-colors',
    '--no-warnings',
    '--ignore-config', // user config must not fight the GUI
    '--no-mtime',
    '--ffmpeg-location', binDir(),
    '--socket-timeout', '20',
  ];
  // Deno lives next to yt-dlp.exe and is pushed onto PATH by childEnv()
  if (settings.jsRuntime === 'none') a.push('--no-js-runtimes');
  else a.push('--js-runtimes', settings.jsRuntime || 'deno');

  // Cloudflare / bot-walled tube sites only answer to a real browser fingerprint
  if (settings.impersonate !== false) {
    a.push('--impersonate', 'chrome', '--extractor-args', 'generic:impersonate');
  }
  const jar = url ? cookieJarFor(url, settings) : settings.cookiesFile && fs.existsSync(settings.cookiesFile) ? settings.cookiesFile : null;
  if (jar) a.push('--cookies', jar);
  if (settings.cookiesBrowser && settings.cookiesBrowser !== 'none') {
    a.push('--cookies-from-browser', settings.cookiesBrowser);
  }
  return a;
}

/** Windows-safe single path segment. */
function safeSegment(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\. ]+|[\. ]+$/g, '')
    .slice(0, 90)
    .trim();
}

function splitArgs(str) {
  if (!str) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function runCapture(args, { timeout = 90000, exePath = null } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    try {
      child = spawn(exePath || exe('yt-dlp.exe'), args, { env: childEnv(), windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message) });
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { killTree(child.pid); } catch (_) {}
      resolve({ code: -2, stdout: out, stderr: err || 'Timed out' });
    }, timeout);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String(e && e.message) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

let ffmpegOk = null;

/** Is the bundled ffmpeg actually runnable (not just present)? */
function ffmpegWorks() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise((resolve) => {
    let done = false;
    let proc;
    try {
      proc = spawn(exe('ffmpeg.exe'), ['-version'], { windowsHide: true });
    } catch (_) {
      ffmpegOk = false;
      return resolve(false);
    }
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ffmpegOk = ok;
      resolve(ok);
    };
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} finish(false); }, 8000);
    proc.on('error', () => finish(false));
    proc.on('close', (code) => finish(code === 0));
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
      resolve();
    }
  });
}

/* ------------------------------------------------------------------ *
 *  Metadata
 * ------------------------------------------------------------------ */
async function getInfo(url, settings, extra = []) {
  const args = ['-J', '--flat-playlist', ...baseArgs(settings, url), ...extra, url];
  const { code, stdout, stderr } = await runCapture(args, { timeout: 120000 });
  if (code !== 0) {
    return { ok: false, error: friendlyError(stderr || 'Could not read that link.') };
  }
  // stdout may start with log noise before the JSON object
  const start = stdout.indexOf('{');
  if (start < 0) return { ok: false, error: 'yt-dlp returned no data for that link.' };
  let data;
  try {
    data = JSON.parse(stdout.slice(start));
  } catch (e) {
    return { ok: false, error: 'Could not parse the metadata yt-dlp returned.' };
  }
  return { ok: true, data };
}

/**
 * Compact view of the JSON for the renderer: no megabytes of URLs.
 */
function compactInfo(data) {
  const isPlaylist = data._type === 'playlist' || Array.isArray(data.entries);
  if (isPlaylist) {
    const entries = (data.entries || []).filter(Boolean);
    const first = entries[0] || {};
    return {
      kind: 'playlist',
      id: data.id,
      title: data.title || 'Playlist',
      uploader: data.uploader || data.channel || data.playlist_uploader || '',
      thumbnail: data.thumbnails?.length ? data.thumbnails[data.thumbnails.length - 1].url : first.thumbnails?.length ? first.thumbnails.at(-1).url : null,
      count: data.playlist_count || entries.length,
      entries: entries.slice(0, 300).map((e) => ({
        id: e.id,
        title: e.title || e.id,
        duration: e.duration || 0,
        url: e.url || e.webpage_url || '',
      })),
      // one queue item per video: real "x of y" counts, per-video retry/cancel
      items: entries
        .map((e) => e.url || e.webpage_url || '')
        .filter((u) => /^https?:\/\//i.test(u))
        .slice(0, 800),
      formats: [],
    };
  }
  const formats = (data.formats || [])
    .filter((f) => {
      if (f.format_note === 'storyboard') return false;
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';
      if (!hasVideo && !hasAudio) return false;
      if (f.ext === 'mhtml') return false;
      return true;
    })
    .map((f) => ({
      id: f.format_id,
      ext: f.ext,
      height: f.height || 0,
      width: f.width || 0,
      fps: f.fps ? Math.round(f.fps) : 0,
      vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec.split('.')[0] : '',
      acodec: f.acodec && f.acodec !== 'none' ? f.acodec.split('.')[0] : '',
      abr: f.abr || 0,
      tbr: f.tbr || 0,
      size: f.filesize || f.filesize_approx || (f.tbr && data.duration ? Math.round((f.tbr * 1000 / 8) * data.duration) : 0),
      hdr: f.dynamic_range && f.dynamic_range !== 'SDR',
      audioOnly: !(f.vcodec && f.vcodec !== 'none'),
      note: f.format_note || '',
      protocol: f.protocol || '',
      isLive: !!(f.is_live || f.was_live),
      url: undefined,
    }))
    .sort((a, b) => (b.height - a.height) || (b.tbr - a.tbr));

  return {
    kind: 'video',
    id: data.id,
    title: data.title || 'Untitled',
    uploader: data.uploader || data.channel || '',
    uploaderInitials: (data.uploader || data.channel || '?').slice(0, 2).toUpperCase(),
    thumbnail: data.thumbnail || (data.thumbnails?.length ? data.thumbnails.at(-1).url : null),
    duration: data.duration || 0,
    viewCount: data.view_count || 0,
    live: !!data.is_live,
    ext: data.ext,
    description: (data.description || '').slice(0, 400),
    subtitles: Object.keys(data.subtitles || {}),
    autoSubtitles: Object.keys(data.automatic_captions || {}),
    chapters: (data.chapters || []).length,
    formats,
    webpage_url: data.webpage_url || '',
  };
}

/* ------------------------------------------------------------------ *
 *  Option schema from `--help`
 * ------------------------------------------------------------------ */
let schemaCache = null;

async function getSchema() {
  if (schemaCache) return schemaCache;
  const { stdout } = await runCapture(['--help'], { timeout: 60000 });
  const HELP_COL = 36; // yt-dlp's optparse aligns help text at this column
  const groups = [];
  let current = null;
  let last = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // group header: "  General Options:"
    const g = line.match(/^\s{0,3}([A-Z][A-Za-z0-9 ,\/&()'\-]*):\s*$/);
    if (g) {
      current = { name: g[1], options: [] };
      groups.push(current);
      last = null;
      continue;
    }

    // option line: 4-6 spaces, flags, optional metavar, help at HELP_COL
    const om = line.match(/^\s{4,6}((?:--?[A-Za-z0-9][^\s,]*)(?:,\s*--?[A-Za-z0-9][^\s,]*)*)(.*)$/);
    if (om && current) {
      const flags = om[1].split(/,\s*/).filter(Boolean);
      const head = line.slice(0, HELP_COL);
      const tail = line.length > HELP_COL ? line.slice(HELP_COL) : '';
      const flagsEnd = line.indexOf(om[1]) + om[1].length;
      const metavar = head.slice(Math.min(flagsEnd, HELP_COL)).trim();
      const opt = {
        flags,
        key: flags.find((f) => f.startsWith('--')) || flags[0],
        metavar,
        help: tail.trim(),
        takesValue: !!metavar,
      };
      current.options.push(opt);
      last = opt;
      continue;
    }

    // continuation of the previous help text
    if (last && /^\s{8,}\S/.test(line) && line.length > HELP_COL - 8) {
      last.help = (last.help ? last.help + ' ' : '') + line.trim();
      continue;
    }
  }

  schemaCache = groups.filter((g) => g.options.length).map((g) => ({ name: g.name, options: g.options }));
  return schemaCache;
}

/* ------------------------------------------------------------------ *
 *  Download queue
 * ------------------------------------------------------------------ */
let seq = 0;

class Engine extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.active = new Map();   // id -> item currently downloading (may be several)
    this.children = new Map(); // id -> yt-dlp child process
    this.running = null;       // first active item, kept for the existing UI code
    this.paused = false;
    // ids the user threw away while they were mid-download; their child process
    // still fires 'close' afterwards and must not report a file or a history row
    this.dropped = new Set();
  }

  /** How many downloads may run at once (Settings → Parallel downloads). */
  get concurrency() {
    const n = Number(this.settings && this.settings.concurrency);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.max(1, Math.min(8, Math.round(n)));
  }

  /** Restore a queue read from disk; anything mid-flight becomes queued again. */
  hydrate(items) {
    if (!Array.isArray(items) || !items.length) return;
    let maxSeq = 0;
    this.queue = items
      .filter((i) => i && i.url)
      .map((i) => {
        const m = String(i.id || '').match(/^q(\d+)$/);
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
        const wasActive = ['running', 'processing', 'resolving'].includes(i.status);
        return {
          ...i,
          status: wasActive ? 'queued' : i.status,
          percent: wasActive ? 0 : i.percent || 0,
          speed: '',
          eta: '',
          stage: '',
          logs: [],
        };
      });
    seq = Math.max(seq, maxSeq);
    this.emitUpdate();
  }

  snapshot() {
    return this.queue.map((i) => ({ ...i, logs: undefined }));
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  add(item) {
    const it = {
      id: 'q' + ++seq,
      url: item.url,
      title: item.title || item.url,
      thumbnail: item.thumbnail || null,
      duration: item.duration || 0,
      // folder as it was when this row was queued: the download folder can change
      // for the next batch without moving rows that are already waiting
      downloadDir: item.downloadDir || '',
      preset: item.preset || 'best',
      formatId: item.formatId || null,
      formatSpec: item.formatSpec || null,
      playlistRange: item.playlistRange || '',
      noPlaylist: !!item.noPlaylist,
      folder: item.folder || '',
      fixedTitle: item.fixedTitle || '',
      resolvedUrl: item.resolvedUrl || '',
      resolvedReferer: item.resolvedReferer || '',
      resolvedCookies: item.resolvedCookies || '',
      directFormats: !!item.directFormats,
      status: 'queued',
      percent: 0,
      hold: false,       // paused by the user while the rest of the queue keeps going
      forceStart: false, // "resume selected": start even though the queue is paused
      speed: '',
      eta: '',
      downloaded: 0,
      total: 0,
      filepath: '',
      error: '',
      logs: [],
      startedAt: 0,
      finishedAt: 0,
    };
    this.queue.push(it);
    this.emitUpdate();
    this.pump();
    return it;
  }

  pauseAll() {
    this.paused = true;
    for (const id of [...this.active.keys()]) this.cancel(id, true);
    this.emitUpdate();
  }

  resumeAll() {
    this.paused = false;
    // "resume all" means all: forget the per-row holds as well
    for (const i of this.queue) i.hold = false;
    this.emitUpdate();
    this.pump();
  }

  /**
   * Pause just the given rows: stop the ones running and hold the ones waiting,
   * while the rest of the queue carries on.
   */
  pauseSelected(ids) {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    let n = 0;
    for (const item of this.queue) {
      if (!wanted.has(item.id)) continue;
      if (this.active.has(item.id)) {
        this.cancel(item.id, true); // back to queued, process killed
        item.hold = true;
        n++;
      } else if (item.status === 'queued') {
        item.hold = true;
        n++;
      }
    }
    if (n) this.emitUpdate();
    return n;
  }

  /**
   * Start just the given rows, even when the whole queue is paused. They jump the
   * line (forceStart) and the rows around them stay paused.
   */
  resumeSelected(ids) {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    let n = 0;
    for (const item of this.queue) {
      if (!wanted.has(item.id)) continue;
      if (this.active.has(item.id)) continue; // already running
      if (!['queued', 'cancelled', 'failed'].includes(item.status)) continue;
      item.status = 'queued';
      item.hold = false;
      item.forceStart = true;
      item.percent = 0;
      item.error = '';
      item.lastLine = '';
      item.speed = '';
      item.eta = '';
      n++;
    }
    if (n) {
      this.emitUpdate();
      this.pump();
    }
    return n;
  }

  cancel(id, silent) {
    const item = this.queue.find((i) => i.id === id);
    if (!item) return;
    if (this.active.has(id)) {
      item._stop = true;
      item.status = silent ? 'queued' : 'cancelled';
      // yt-dlp.exe is a PyInstaller one-file build: it spawns a CHILD copy of
      // itself, so killing only the process we spawned leaves the real worker
      // running. Always kill the whole tree, and never kill the parent alone.
      const child = this.children.get(id);
      const pid = (child && child.pid) || item.pid;
      if (pid) {
        killTree(pid);
        setTimeout(() => killTree(pid), 1200);
      }
      this.emitUpdate();
    } else if (item.status === 'queued') {
      item.status = 'cancelled';
      this.emitUpdate();
    }
  }

  retry(id) {
    const item = this.queue.find((i) => i.id === id);
    if (!item) return;
    item.status = 'queued';
    item.percent = 0;
    item.error = '';
    item.speed = '';
    item.eta = '';
    item.filepath = '';
    this.emitUpdate();
    this.pump();
  }

  /** Queue every failed row again (after fixing cookies, for example). */
  retryFailed() {
    let n = 0;
    for (const item of this.queue) {
      if (item.status !== 'failed') continue;
      item.status = 'queued';
      item.percent = 0;
      item.error = '';
      item.lastLine = '';
      item.speed = '';
      item.eta = '';
      item.stage = '';
      item.filepath = '';
      n++;
    }
    if (n) {
      this.emitUpdate();
      this.pump();
    }
    return n;
  }

  /**
   * Re-point waiting rows at another folder (the queue page's "Change folder").
   * A row that is already downloading keeps its folder: the engine command for it
   * was built when it started, so "moving" it would only move the label.
   * Returns how many rows actually changed.
   */
  setFolderFor(ids, dir) {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    const busy = ['running', 'processing', 'resolving'];
    let n = 0;
    for (const i of this.queue) {
      if (!wanted.has(i.id)) continue;
      if (busy.includes(i.status)) continue;
      if (i.downloadDir === dir) continue;
      i.downloadDir = dir;
      n++;
    }
    if (n) this.emitUpdate();
    return n;
  }

  remove(id) {
    const i = this.queue.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (this.active.has(id)) return; // stop it first, then remove
    this.queue.splice(i, 1);
    this.emitUpdate();
  }

  clearDone() {
    this.queue = this.queue.filter((i) => i.status !== 'done' && i.status !== 'cancelled');
    this.emitUpdate();
  }

  /** "Remove all": stop every running download and empty the queue in one go. */
  removeAll() {
    for (const i of this.queue) this.dropped.add(i.id);
    for (const child of this.children.values()) {
      const pid = child && child.pid;
      if (!pid) continue;
      killTree(pid);
      setTimeout(() => killTree(pid), 1200);
    }
    this.queue = [];
    this.active.clear();
    this.children.clear();
    this.running = null;
    this.paused = false; // an empty queue cannot be paused; the next download starts at once
    this.emitUpdate();
    return true;
  }

  /**
   * Start as many queued items as the "Parallel downloads" setting allows.
   * Each one runs on its own yt-dlp process; nothing waits for a neighbour.
   */
  pump() {
    const limit = this.concurrency;
    while (this.active.size < limit) {
      // rows the user explicitly resumed jump the line and run even while the
      // whole queue is paused; held rows are skipped entirely
      let next = this.queue.find((i) => i.status === 'queued' && i.forceStart && !this.active.has(i.id));
      if (!next && !this.paused) {
        next = this.queue.find((i) => i.status === 'queued' && !i.hold && !this.active.has(i.id));
      }
      if (!next) break;
      next.forceStart = false;
      this.startOne(next);
    }
  }

  startOne(item) {
    item.status = 'running';
    item._stop = false;
    this.active.set(item.id, item);
    this.running = item;
    this.emitUpdate();
    this.execute(item, this.settings || {})
      .catch(() => {})
      .finally(() => {
        this.active.delete(item.id);
        this.children.delete(item.id);
        const left = [...this.active.values()];
        this.running = left[0] || null;
        this.emitUpdate();
        this.pump();
      });
  }

  buildArgs(item, settings) {
    const a = [
      '--no-colors',
      '--newline',
      '--progress',
      '--progress-template', PROGRESS_TPL,
      '--progress-template', POSTPROC_TPL,
      '--print', 'after_move:FP|%(filepath)s',
      '--print', 'before_dl:TH|%(thumbnail)s',
      '--print', 'before_dl:TI|%(title)s',
      ...baseArgs(settings, item.resolvedCookies ? null : item.url),
    ];
    // the folder is remembered per row at the moment it was queued, so changing
    // the download folder only affects the videos added afterwards ("next batch")
    const baseDir = item.downloadDir || settings.downloadDir;
    a.push('-P', baseDir);
    let outTmpl = settings.outputTemplate || '%(title)s [%(id)s].%(ext)s';
    if (item.folder && settings.groupFolders !== false) {
      outTmpl = safeSegment(item.folder) + '/' + outTmpl;
    }
    if (item.fixedTitle) {
      outTmpl = (item.folder && settings.groupFolders !== false ? safeSegment(item.folder) + '/' : '') +
        safeSegment(item.fixedTitle) + '.%(ext)s';
    }
    a.push('-o', outTmpl);

    // a media URL we resolved ourselves (yt-dlp cannot parse the page)
    if (item.resolvedReferer) a.push('--referer', item.resolvedReferer);
    if (item.resolvedCookies && fs.existsSync(item.resolvedCookies)) a.push('--cookies', item.resolvedCookies);
    if (item.resolvedUrl) {
      a.push('--user-agent', BROWSER_UA, '--no-playlist');
    }

    // format: an explicitly picked stream always wins over the preset
    if (item.formatSpec || item.formatId) {
      a.push('-f', item.formatSpec || `${item.formatId}+ba/b`);
    } else if (item.preset === 'audio') {
      a.push('-f', 'ba/b');
      a.push('-x', '--audio-format', settings.audioFormat || 'mp3', '--audio-quality', '0');
    } else if (item.directFormats) {
      a.push('-f', directFormatSpec(item.preset, settings.codecPreference || 'h264'));
    } else if (isVkUrl(item.url)) {
      // VK throttles a single connection to a crawl: take the HLS variants
      a.push('-f', vkFormatSpec(item.preset));
    } else {
      a.push('-f', presetFormat(item.preset));
    }

    if (settings.container && settings.container !== 'original' && item.preset !== 'audio') {
      a.push('--merge-output-format', settings.container);
    }
    if (settings.cookiesBrowser && settings.cookiesBrowser !== 'none') {
      // already added by baseArgs, kept for clarity
    }
    // subtitles
    if (settings.subs) {
      a.push('--write-subs');
      if (settings.subsAuto) a.push('--write-auto-subs');
      if (settings.subsLangs) a.push('--sub-langs', settings.subsLangs);
      if (settings.subsEmbed) a.push('--embed-subs');
      if (settings.subsFormat && settings.subsFormat !== 'original') a.push('--convert-subs', settings.subsFormat);
    }
    // metadata
    if (settings.embedMetadata) a.push('--embed-metadata');
    if (settings.embedChapters) a.push('--embed-chapters');
    if (settings.embedThumbnail && !item.noThumb) {
      a.push('--embed-thumbnail');
      // Some hosts serve an AVIF/WebP image under a .jpg URL. The MP4 muxer
      // refuses to store those as an attached picture
      // ("Could not write header (incorrect codec parameters ?): Invalid
      // argument"), so make yt-dlp turn the thumbnail into a real JPEG first.
      a.push('--convert-thumbnails', 'jpg');
    }
    if (settings.sponsorblock === 'mark') a.push('--sponsorblock-mark', 'all');
    if (settings.sponsorblock === 'remove') a.push('--sponsorblock-remove', 'all');
    if (settings.noOverwrite) a.push('--no-overwrites');
    if (settings.archiveFile) a.push('--download-archive', path.join(path.dirname(baseDir), 'archive.txt'));

    if (settings.speedLimit) a.push('--limit-rate', settings.speedLimit);
    // VK is throttled per connection, so it always gets a generous fragment count
    const frags = isVkUrl(item.url) ? Math.max(VK_FRAGMENTS, Number(settings.fragments) || 0) : Number(settings.fragments) || 0;
    if (frags > 1) a.push('--concurrent-fragments', String(frags));
    if (settings.retries) a.push('--retries', String(settings.retries));

    if (item.noPlaylist) a.push('--no-playlist');
    else if (item.playlistRange) a.push('--playlist-items', item.playlistRange);

    for (const [flag, value] of Object.entries(settings.optionValues || {})) {
      if (value === true) a.push(flag);
      else if (typeof value === 'string' && value.trim()) a.push(flag, value.trim());
    }
    if (settings.extraArgs) a.push(...splitArgs(settings.extraArgs));

    a.push(item.resolvedUrl || item.url);
    return a;
  }

  async execute(item, settings) {
    const s0 = settings || this.settings || {};
    if (!item.resolvedUrl && needsResolve(item.url)) {
      item.status = 'resolving';
      item.stage = 'Preparing stream';
      this.emitUpdate();
      try {
        const r = await resolvers.resolve(item.url, cookieJarFor(item.url, s0));
        if (r && r.mediaUrl) {
          item.resolvedUrl = r.mediaUrl;
          item.resolvedReferer = r.referer || '';
          item.resolvedCookies = r.cookiesFile || '';
          item.directFormats = true;
          if (r.title) item.fixedTitle = r.title;
          if (!item.thumbnail && r.thumbnail) item.thumbnail = r.thumbnail;
        }
      } catch (_) {}
      item.stage = '';
    }

    // engines can vanish if Windows cleans the temp extraction folder
    if (!(await ffmpegWorks())) {
      try { ensureBins(); ffmpegOk = null; } catch (_) {}
      if (!(await ffmpegWorks())) {
        item.status = 'failed';
        item.error = 'ffmpeg is missing or cannot run from ' + binDir() + ' — the engines folder was probably cleaned up. Restart the app to restore it.';
        this.emitUpdate();
        return;
      }
    }

    return new Promise((resolve) => {
      const s = settings || this.settings || {};
      const args = this.buildArgs(item, s);
      item.status = 'running';
      item.startedAt = Date.now();
      this.emitUpdate();
      let child;
      try {
        child = spawn(exe('yt-dlp.exe'), args, { env: childEnv(), windowsHide: true });
      } catch (e) {
        item.status = 'failed';
        item.error = 'Could not start yt-dlp: ' + e.message;
        return resolve();
      }
      this.children.set(item.id, child);
      item.pid = child.pid;

      const onLine = (line) => {
        if (!line) return;
        if (line.startsWith('P|')) {
          const p = line.split('|');
          const pct = parseFloat(String(p[1] || '').replace('%', '').trim());
          if (!Number.isNaN(pct)) item.percent = Math.min(100, Math.max(0, pct));
          item.speed = (p[2] || '').trim();
          item.eta = (p[3] || '').trim();
          item.downloaded = Number(p[4]) || item.downloaded;
          item.total = Number(p[5]) || Number(p[6]) || item.total;
          if (item.fragmentsTotal) {
            /* handled below */
          }
          const fi = Number(p[7]);
          const fc = Number(p[8]);
          if (fc) { item.fragmentIndex = fi; item.fragmentsTotal = fc; }
          this.emitUpdate();
          return;
        }
        if (line.startsWith('PP|')) {
          const p = line.split('|');
          item.status = 'processing';
          item.stage = (p[1] || '').replace('PostProcessor', '') || 'Processing';
          this.emitUpdate();
          return;
        }
        if (line.startsWith('TI|')) {
          // yt-dlp's own title — but only as a fill-in for a row we could not
          // name. On VK the engine's title is the same uploader tag soup, so
          // letting it win would throw away a good title scraped from the page.
          const ti = line.slice(3).trim();
          const placeholder = !item.title || /^Item \d+$/i.test(item.title) || /^https?:\/\//i.test(item.title);
          if (ti && ti !== 'NA' && !item.fixedTitle && placeholder && ti !== item.title) {
            item.title = ti;
            this.emitUpdate();
          }
          return;
        }
        if (line.startsWith('TH|')) {
          const th = line.slice(3).trim();
          if (th && th !== 'NA' && !item.thumbnail) {
            item.thumbnail = th;
            this.emitUpdate();
          }
          return;
        }
        if (line.startsWith('FP|')) {
          item.filepath = line.slice(3).trim();
          return;
        }
        const dest = line.match(/^\[download\] Destination:\s*(.+)$/);
        if (dest) { item.filepath = dest[1].trim(); return; }
        const merg = line.match(/^\[Merger\] Merging formats into "(.+)"$/);
        if (merg) { item.filepath = merg[1].trim(); item.stage = 'Merging'; return; }
        const mv = line.match(/^\[MoveFiles\] Moving file ".+" to "(.+)"$/);
        if (mv) { item.filepath = mv[1].trim(); return; }
        const already = line.match(/^\[download\] (.+) has already been downloaded/);
        if (already) { item.percent = 100; item.stage = 'Already downloaded'; return; }
        const ext = line.match(/^\[(ExtractAudio|VideoConvertor|VideoRemuxer|EmbedThumbnail|Metadata|Fixup\w*|SponsorBlock|SplitChapters|RecodeVideo)\]/);
        if (ext) { item.stage = ext[1].replace(/([a-z])([A-Z])/g, '$1 $2'); return; }
        if (/^\[download\]\s+\d/.test(line)) return; // plain progress noise
        item.lastLine = String(line).slice(0, 300);
        item.logs.push(line);
        if (item.logs.length > 400) item.logs.shift();
        this.emit('log', { id: item.id, line });
      };

      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const l of parts) onLine(l.trimEnd());
      });
      child.stderr.on('data', (d) => {
        const text = d.toString('utf8');
        for (const l of text.split(/\r?\n/)) {
          const line = l.trim();
          if (!line) continue;
          if (line.startsWith('WARNING:') || line.startsWith('ERROR:')) {
            item.logs.push(line);
            this.emit('log', { id: item.id, line });
          }
        }
      });
      child.on('error', (e) => {
        item.status = 'failed';
        item.error = 'Could not start yt-dlp: ' + e.message;
        item.finishedAt = Date.now();
        this.emitUpdate();
        resolve();
      });
      child.on('close', (code) => {
        if (buf) onLine(buf);
        item.finishedAt = Date.now();
        // the row was removed with "Remove all" while this child was running:
        // do not announce it as finished and do not write a history entry
        if (this.dropped.has(item.id)) {
          this.dropped.delete(item.id);
          item._stop = false;
          resolve();
          return;
        }
        if (item._stop) {
          item.status = item.status === 'queued' ? 'queued' : 'cancelled';
        } else if (code === 0) {
          item.status = 'done';
          item.percent = 100;
          item.stage = '';
          item.speed = '';
          item.eta = '';
          this.emit('done', { ...item, logs: undefined });
        } else {
          const tail = item.logs.slice(-8).join('\n');
          // The video itself finished; only the final rewrite of the file failed
          // (almost always the thumbnail embed). Retry once without it instead of
          // showing a finished download as failed.
          if (!item._ppRetry && /Postprocessing|Unable to embed|Conversion failed|Could not write header/i.test(tail)) {
            item._ppRetry = true;
            item.noThumb = true;
            item.status = 'queued';
            item.percent = 100;
            item.stage = 'Finishing without thumbnail';
            item.error = '';
            item.note = 'The thumbnail could not be embedded, so it finished without one.';
            item._stop = false;
            this.emitUpdate();
            resolve();
            return;
          }
          item.status = 'failed';
          item.error = friendlyError(tail);
          const rawErr = (tail.split('\n').map((l) => l.trim()).filter((l) => /ERROR|error|failed|Conversion|Invalid/i.test(l)).pop() || '').trim();
          if (rawErr) item.lastLine = rawErr.slice(0, 300);
        }
        item._stop = false;
        this.emitUpdate();
        resolve();
      });
    });
  }
}

/** HLS/DASH variants are muxed, so pick a whole stream honouring the codec wish. */
function directFormatSpec(preset, codecPref) {
  const codec = codecPref === 'av1' ? 'av01' : codecPref === 'h265' ? 'hvc1' : codecPref === 'best' ? null : 'avc1';
  const h = /^\d+$/.test(String(preset)) ? String(preset) : null;
  const cap = h ? `[height<=${h}]` : '';
  const order = [];
  if (codec) order.push(`b${cap}[vcodec^=${codec}]`);
  if (cap) order.push(`b${cap}`);
  order.push('b');
  return order.join('/');
}

/* ------------------------------------------------------------------ *
 *  VK: one connection is throttled, many are not
 *
 *  VK's CDN answers a plain HTTPS file with roughly 250 KiB/s per
 *  connection, so the progressive mp4 (format "url1080") crawls however
 *  good the line is (measured 0.25 MiB/s on a 116 Mbit line). The same
 *  video as HLS is served in ~1-2 MB fragments, and fetching them in
 *  parallel scales almost linearly: 4 → 0.8, 16 → 3.4, 32 → 6.2 MiB/s.
 *  So for VK prefer the m3u8 variants and run many fragments at once.
 * ------------------------------------------------------------------ */
const VK_HOST = /(^|\.)(vkvideo\.ru|vkvideo\.com|vk\.com)$/i;

function isVkUrl(u) {
  try {
    return VK_HOST.test(new URL(String(u || '')).hostname);
  } catch (_) {
    return false;
  }
}

function vkFormatSpec(preset) {
  const h = /^\d+$/.test(String(preset)) ? String(preset) : '';
  const cap = h ? `[height<=${h}]` : '';
  return [
    `bv*[protocol^=m3u8]${cap}+ba[protocol^=m3u8]`, // 1080p video + audio, both HLS
    `b[protocol^=m3u8]${cap}`, // muxed HLS
    `bv*${cap}+ba`, // anything, if the page has no HLS
    `b${cap}`,
  ].join('/');
}

/** fragments to run at once; VK needs a lot or it downloads at a crawl */
const VK_FRAGMENTS = 32;

function presetFormat(preset) {
  switch (preset) {
    case 'best': return 'bv*+ba/b';
    case 'audio': return null; // handled separately
    case 'smallest': return 'wv*+wa/w';
    default: {
      const h = String(preset).replace(/\D/g, '');
      if (!h) return 'bv*+ba/b';
      return `bv*[height<=${h}]+ba/b[height<=${h}]`;
    }
  }
}

const ERROR_MAP = [
  [/Access restricted/i,
    'VK refuses this video for these cookies — it is private or age-restricted, and VK only serves those to a signed-in account. ' +
    'Settings → Paste cookies: sign in at https://vk.com (your avatar must be showing), export with Cookie-Editor → JSON, paste it, press Test, then Retry.'],
  [/Sign in to confirm you.?re not a bot|confirm your age|age-restricted|cookies/i,
    'This video needs your browser cookies. Turn on "Cookies from browser" in Settings (pick Chrome or Edge) and try again.'],
  [/Private video|This video is private/i, 'This video is private — the uploader has not made it public.'],
  [/Video unavailable|has been removed|no longer available/i, 'That video is no longer available on the site.'],
  [/not available in your country|geo.?restricted/i, 'The site blocks this video in your region. A proxy in Settings may help.'],
  [/Unsupported URL/i, 'This link is not supported by yt-dlp. Check the address, or add a direct media URL.'],
  [/HTTP Error 403|403 Forbidden/i, 'The site refused the download (403). Usually fixed by enabling browser cookies or updating yt-dlp.'],
  [/HTTP Error 429|Too Many Requests/i, 'The site is rate-limiting you. Slow down (add a speed limit) or wait a few minutes.'],
  [/Could not write header|Unable to embed using ffprobe|Conversion failed/i,
    'The video finished downloading, but the last step that rewrites the file failed. This is almost always an image the MP4 format cannot hold (a WebP/AVIF thumbnail); it is retried automatically without the thumbnail.'],
  [/ffmpeg not found|ffprobe not found|ffmpeg is not installed/i,
    'ffmpeg is missing from the engines folder, so streams cannot be merged. Settings → Engines → repair copies it back.'],
  [/ffmpeg|ffprobe/i, 'ffmpeg failed while finishing the file (merging or rewriting it).'],
  [/Could not copy Chrome cookie database|Failed to decrypt|DPAPI/i,
    'Chrome keeps its cookies locked while it runs (and newer Chrome encrypts them). Close Chrome completely and try again, or switch to Firefox in Settings, or point Settings → Cookies file at an exported cookies.txt.'],
  [/No space left/i, 'The download drive is full.'],
  [/name or service not known|getaddrinfo|Failed to resolve/i, 'No internet connection, or the site is blocked by your network.'],
];

function friendlyError(text) {
  if (!text) return 'Download failed.';
  for (const [re, msg] of ERROR_MAP) if (re.test(text)) return msg;
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = lines.filter((l) => /ERROR/i.test(l)).pop() || lines[lines.length - 1] || '';
  const clean = errLine.replace(/^ERROR:\s*/, '').trim();
  // VK (and a few others) sometimes answer with an empty error: "ERROR: [vk]"
  // and nothing else. Saying that verbatim tells the user nothing.
  if (!clean || /^\[[\w:.\- ]+\]$/.test(clean)) {
    return 'The site refused the request without a reason' + (clean ? ' (' + clean + ')' : '') +
      '. If this is VK, the cookies are not signed in — Settings → Paste cookies, exported from vk.com.';
  }
  return clean.slice(0, 300) || 'Download failed.';
}

async function version() {
  const { code, stdout } = await runCapture(['--version'], { timeout: 30000 });
  return code === 0 ? stdout.trim() : 'unknown';
}

async function depsInfo() {
  const v = await version();
  const denoExe = path.join(binDir(), 'deno.exe');
  const ffmpegExe = path.join(binDir(), 'ffmpeg.exe');
  return {
    ytdlp: v,
    ffmpeg: fs.existsSync(ffmpegExe),
    deno: fs.existsSync(denoExe),
    binDir: binDir(),
    dataDir: dataDir(),
  };
}

async function updateYtDlp() {
  const { code, stdout, stderr } = await runCapture(['-U'], { timeout: 180000 });
  schemaCache = null;
  return { ok: code === 0, output: (stdout + '\n' + stderr).trim(), code };
}

module.exports = { Engine, getInfo, compactInfo, getSchema, version, depsInfo, updateYtDlp, friendlyError, killTree, cookieJarFor, runCapture };
