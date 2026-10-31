'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme, clipboard, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const engine = require('./engine');
const resolvers = require('./resolvers');
const sniffer = require('./sniffer');
const { dataDir, defaultDownloadDir, binDir, ensureBins } = require('./paths');

// Portable (single-exe) build: keep the settings NEXT TO the exe so the whole
// thing really is portable — but keep Chromium's cache/cookies in the temp
// folder so the user only ever sees a small settings file.
const PORTABLE_DATA = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'yt-dlp-studio-data')
  : null;

if (PORTABLE_DATA) {
  try {
    app.setPath('userData', PORTABLE_DATA);
    app.setPath('sessionData', path.join(app.getPath('temp'), 'yt-dlp-studio-session'));
  } catch (_) {}
} else if (app.isPackaged) {
  // Installed build: keep everything in one per-user folder that survives app
  // updates, reinstalls and uninstalls. Pinned explicitly so a change to the
  // package name can never silently move the user's queue somewhere else.
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'yt-dlp Studio'));
  } catch (_) {}
}

// Remove the cache folders older builds dumped next to the exe.
function purgeLegacyCacheDirs() {
  if (!PORTABLE_DATA) return;
  const junk = [
    'blob_storage', 'Cache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'GPUCache', 'Local Storage', 'Network', 'Session Storage', 'Shared Dictionary',
    'SharedStorage', 'DIPS', 'Local State', 'Preferences', 'Crashpad', 'Service Worker',
  ];
  for (const name of junk) {
    try { fs.rmSync(path.join(PORTABLE_DATA, name), { recursive: true, force: true }); } catch (_) {}
  }
}
purgeLegacyCacheDirs();

const DEFAULT_SETTINGS = {
  downloadDir: '',            // chosen by the user on first launch
  setupDone: false,           // first-launch wizard finished
  impersonate: true,          // Cloudflare / anti-bot workaround
  cookiesFile: '',            // optional cookies.txt
  groupFolders: true,         // put playlists/profiles in their own folder
  codecPreference: 'h264',    // h264 | av1 | h265 | best
  cookieJars: {},             // domain -> cookies.txt path
  playlistTitles: {},         // url -> last known playlist name
  outputTemplate: '%(title)s [%(id)s].%(ext)s',
  container: 'mp4',
  audioFormat: 'mp3',
  subs: false,
  subsAuto: false,
  subsLangs: 'en,ar',
  subsEmbed: true,
  subsFormat: 'srt',
  embedMetadata: true,
  embedChapters: true,
  embedThumbnail: true,
  sponsorblock: 'off',
  cookiesBrowser: 'none',
  noOverwrite: true,
  archiveFile: false,
  speedLimit: '',
  concurrency: 1, // how many videos download at once (Settings → Parallel downloads)
  fragments: 4,
  retries: 10,
  extraArgs: '',
  jsRuntime: 'deno',
  theme: 'dark',
  accent: 'violet',
  presetPills: ['best', '2160', '1440', '1080', '720', 'audio'],
  optionValues: {},
  presets: [],
  history: [],
};

let settings = { ...DEFAULT_SETTINGS };
let win = null;
let queueTimer = null;
const eng = new engine.Engine();

/* ---------------- storage ---------------- */
function settingsPath() { return path.join(dataDir(), 'settings.json'); }
function queuePath() { return path.join(dataDir(), 'queue.json'); }

/** Queue survives restarts. Thumbnails are data: URLs, so they are dropped. */
function persistQueue(queue) {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    try {
      const slim = (queue || []).map((i) => ({
        ...i,
        logs: undefined,
        thumbnail: String(i.thumbnail || '').startsWith('data:') ? '' : i.thumbnail,
      }));
      fs.writeFileSync(queuePath(), JSON.stringify(slim), 'utf8');
    } catch (_) {}
  }, 400);
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS };
  }
  try { fs.mkdirSync(settings.downloadDir, { recursive: true }); } catch (_) {}
  eng.settings = settings;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      settings.history = (settings.history || []).slice(0, 500);
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
    } catch (_) {}
  }, 200);
}

/* ---------------- window ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#08090c',
    backgroundMaterial: 'acrylic',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('maximize', () => win.webContents.send('settings:changed', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('settings:changed', { maximized: false }));

  // never let the app navigate away or spawn windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

/* ---------------- ipc ---------------- */
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());

ipcMain.handle('state:get', async () => {
  const deps = await engine.depsInfo(settings);
  let freeSpace = 0;
  try {
    const st = await fs.promises.statfs(settings.downloadDir || '.');
    freeSpace = st.bavail * st.bsize;
  } catch (_) {}
  return {
    settings,
    queue: eng.snapshot(),
    deps,
    freeSpace,
    platform: process.platform,
    appVersion: app.getVersion(),
    defaultDir: path.join(app.getPath('downloads'), 'yt-dlp Studio'),
    paused: eng.paused,
    maximized: win ? win.isMaximized() : false,
  };
});

ipcMain.handle('settings:save', async (_e, patch) => {
  settings = { ...settings, ...patch };
  if ('concurrency' in patch) {
    const n = Math.round(Number(patch.concurrency));
    settings.concurrency = Number.isFinite(n) ? Math.max(1, Math.min(8, n)) : 1;
  }
  eng.settings = settings;
  persist();
  try { fs.mkdirSync(settings.downloadDir, { recursive: true }); } catch (_) {}
  eng.pump(); // a raised limit should start the extra downloads right away
  return settings;
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose download folder',
    defaultPath: settings.downloadDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  settings.downloadDir = r.filePaths[0];
  eng.settings = settings;
  persist();
  return settings.downloadDir;
});

ipcMain.handle('dialog:file', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || 'Choose file',
    properties: ['openFile'],
    filters: (opts && opts.filters) || [{ name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

/** closest folder that still exists, walking up from a file or folder path */
function nearestExistingDir(p) {
  let dir = String(p || '');
  for (let i = 0; i < 8 && dir; i++) {
    if (fs.existsSync(dir)) {
      try { if (fs.statSync(dir).isDirectory()) return dir; } catch (_) {}
      const up = path.dirname(dir);
      return up !== dir ? up : dir;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '';
}

ipcMain.handle('shell:openPath', async (_e, p) => {
  const target = String(p || '').trim();
  if (!target) return { ok: false, reason: 'no path' };
  const fileExists = fs.existsSync(target);
  const openThis = fileExists ? target : nearestExistingDir(target);
  if (!openThis) return { ok: false, reason: 'missing' };
  const err = await shell.openPath(openThis);
  return { ok: !err, reason: err || '', missing: !fileExists, dir: openThis };
});

/**
 * Open Explorer with the file selected.
 *
 * shell.showItemInFolder() does open the folder, but it comes up behind our
 * frameless window, so the button looks dead — the user clicks it and nothing
 * appears to happen. `explorer.exe /select,` brings the window to the front.
 */
function revealInExplorer(target) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      // TWO arguments on purpose: '/select,' + path as a single token makes
      // Explorer ignore it (folder opens, file not selected). With the switch and
      // the path separated, Node quotes the path for us and the file is selected.
      const child = spawn('explorer.exe', ['/select,', target], { windowsHide: false });
      child.on('error', () => {
        try { shell.showItemInFolder(target); } catch (_) {}
        finish();
      });
      child.on('close', finish);
      setTimeout(finish, 2000);
    } catch (_) {
      try { shell.showItemInFolder(target); } catch (_) {}
      finish();
    }
  });
}

/**
 * "Show in folder". Windows shows nothing at all when the file is gone, which
 * reads as a dead button — so a missing file opens the nearest folder that still
 * exists and reports back, and the UI can say what happened.
 */
ipcMain.handle('shell:reveal', async (_e, p) => {
  const target = String(p || '').trim();
  if (!target) return { ok: false, reason: 'no path' };
  if (fs.existsSync(target)) {
    await revealInExplorer(target);
    return { ok: true, missing: false, dir: path.dirname(target) };
  }
  const dir = nearestExistingDir(path.dirname(target));
  if (!dir) return { ok: false, reason: 'missing' };
  await shell.openPath(dir);
  return { ok: true, missing: true, dir };
});
ipcMain.handle('shell:external', async (_e, url) => {
  if (!/^https?:/i.test(String(url || ''))) return { ok: false, reason: 'not a web link' };
  await shell.openExternal(url);
  return { ok: true, url };
});
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const thumbCache = new Map();

/**
 * Thumbnails are hotlink-protected on several sites (403 when the <img> asks
 * directly). Fetch the bytes here with a browser UA + the page's own Referer
 * and hand the renderer a data: URL.
 */
async function fetchThumbDataUrl(url, pageUrl) {
  if (!url) return null;
  if (thumbCache.has(url)) return thumbCache.get(url);
  try {
    let referer = '';
    try { referer = new URL(pageUrl || url).origin + '/'; } catch (_) {}
    const headers = { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(referer ? { Referer: referer } : {}) };
    let res = null;
    try {
      res = await net.fetch(url, { headers, cache: 'force-cache' });
      if (!res.ok) res = null;
    } catch (_) {
      res = null;
    }
    if (!res) {
      try {
        const r2 = await fetch(url, { headers, redirect: 'follow' });
        if (r2.ok) res = r2;
      } catch (_) {
        res = null;
      }
    }
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return null;
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\//i.test(type)) return null;
    const dataUrl = `data:${type};base64,${buf.toString('base64')}`;
    if (thumbCache.size > 60) thumbCache.clear();
    thumbCache.set(url, dataUrl);
    return dataUrl;
  } catch (_) {
    return null;
  }
}

/* ---------------------------------------------------------------- *
 *  History posters
 * ---------------------------------------------------------------- */

/** Run bundled ffmpeg with a short timeout; resolves with the exit code. */
function runFfmpeg(args, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    let proc;
    try {
      proc = spawn(path.join(binDir(), 'ffmpeg.exe'), args, { windowsHide: true });
    } catch (_) {
      return resolve(-1);
    }
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      finish(-2);
    }, timeout);
    proc.on('error', () => finish(-1));
    proc.on('close', (code) => finish(code));
  });
}

function historyThumbDir() {
  const d = path.join(dataDir(), 'thumbs');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

/**
 * Poster for a finished download.
 *
 * History rows are plain JSON, so no image is stored there (a data: URL per row
 * would bloat settings.json). Instead one frame is grabbed from the finished
 * file with the bundled ffmpeg and cached on disk under the settings folder:
 * the first look at a row costs a fraction of a second, every later one is
 * instant, and a file the user deleted later simply gets no picture.
 */
async function historyThumb(filepath) {
  const file = String(filepath || '');
  if (!file || !fs.existsSync(file)) return null;
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  if (!st.isFile() || st.size < 32 * 1024) return null;

  const key = crypto.createHash('sha1').update(file.toLowerCase()).digest('hex');
  const out = path.join(historyThumbDir(), key + '.jpg');
  const good = () => {
    try { return fs.existsSync(out) && fs.statSync(out).size > 512; } catch (_) { return false; }
  };

  if (!good()) {
    // image-only / audio-only files have no frame: try three offsets, then give up
    for (const at of ['00:00:05', '00:00:01', '00:00:00']) {
      const code = await runFfmpeg([
        '-hide_banner', '-loglevel', 'error',
        '-ss', at, '-i', file,
        '-frames:v', '1', '-vf', 'scale=320:-2', '-y', out,
      ]);
      if (code === 0 && good()) break;
    }
  }
  if (!good()) return null;
  try {
    return 'data:image/jpeg;base64,' + fs.readFileSync(out).toString('base64');
  } catch (_) {
    return null;
  }
}

function directInfo(url, resolved) {
  let height = 0;
  const h = String(resolved.mediaUrl).match(/_(\d{3,4})p/);
  if (h) height = Number(h[1]);
  return {
    kind: 'video',
    id: 'resolved',
    title: resolved.title || url,
    uploader: '',
    uploaderInitials: 'DL',
    thumbnail: resolved.thumbnail || null,
    duration: 0,
    viewCount: 0,
    live: false,
    description: 'Direct media link resolved by the app.',
    subtitles: [],
    autoSubtitles: [],
    chapters: 0,
    formats: [{ id: 'resolved', ext: 'mp4', height, width: 0, fps: 0, vcodec: '', acodec: '', abr: 0, tbr: 0, size: 0, hdr: false, audioOnly: false, note: 'direct', protocol: 'https', isLive: false }],
    webpage_url: url,
    resolvedUrl: resolved.mediaUrl,
    resolvedReferer: resolved.referer || '',
    resolvedCookies: resolved.cookiesFile || '',
  };
}

/**
 * A resolved stream (HLS master etc.) usually holds several qualities. Ask
 * yt-dlp to list them so the format table stays truthful and the user can pick
 * exactly the codec they want.
 */
async function infoFromResolved(pageUrl, resolved) {
  const extra = [];
  if (resolved.cookiesFile && fs.existsSync(resolved.cookiesFile)) extra.push('--cookies', resolved.cookiesFile);
  if (resolved.referer) extra.push('--referer', resolved.referer);
  extra.push('--user-agent', sniffer.UA);

  try {
    const res = await engine.getInfo(resolved.mediaUrl, settings, extra);
    if (res.ok) {
      const info = engine.compactInfo(res.data);
      info.webpage_url = pageUrl;
      info.resolvedUrl = resolved.mediaUrl;
      info.resolvedReferer = resolved.referer || '';
      info.resolvedCookies = resolved.cookiesFile || '';
      info.directFormats = true;
      if (!info.title || /\.(mp4|m3u8)$/i.test(info.title)) info.title = resolved.title || info.title;
      if (!info.thumbnail && resolved.thumbnail) info.thumbnail = resolved.thumbnail;
      // a resolver may hand us a ready data: URL — do not try to fetch that as
      // if it were a remote image
      if (info.thumbnail && !String(info.thumbnail).startsWith('data:')) {
        const d = await fetchThumbDataUrl(info.thumbnail, pageUrl);
        if (d) { info.thumbnailRemote = info.thumbnail; info.thumbnail = d; }
      }
      if (info.formats && info.formats.length) return { ok: true, info };
    }
  } catch (_) {}

  const info = directInfo(pageUrl, resolved);
  if (info.thumbnail && !String(info.thumbnail).startsWith('data:')) {
    const d = await fetchThumbDataUrl(info.thumbnail, pageUrl);
    if (d) { info.thumbnailRemote = info.thumbnail; info.thumbnail = d; }
  }
  return { ok: true, info };
}

ipcMain.handle('yt:info', async (_e, url) => {
  // sites yt-dlp cannot parse: resolve the media URL ourselves
  const resolved = await resolvers.resolve(url, engine.cookieJarFor(url, settings));
  if (resolved && resolved._blocked) {
    return {
      ok: false,
      error:
        'VK is asking to confirm you are not a robot. Wait a minute and try again, or refresh your vkvideo.ru cookies (Settings → Paste cookies).',
    };
  }
  if (resolved && resolved.playlist) {
    if (resolved.title) {
      settings.playlistTitles = { ...(settings.playlistTitles || {}), [url]: resolved.title };
      persist();
    }
    // Resolvers that scraped a rendered page can name each video; carry the
    // real title (and poster) through so queue rows never read "Item 7".
    const entries = [];
    for (let i = 0; i < resolved.items.length; i++) {
      const it = resolved.items[i] || {};
      let thumb = it.thumbnail || '';
      if (thumb) {
        const dataUrl = await fetchThumbDataUrl(thumb, url);
        if (dataUrl) thumb = dataUrl;
      }
      entries.push({
        id: String(i),
        title: it.title || `Item ${i + 1}`,
        duration: it.duration || 0,
        url: it.url,
        thumbnail: thumb,
      });
    }

    return {
      ok: true,
      info: {
        kind: 'playlist',
        id: 'pl',
        title:
          resolved.title ||
          (settings.playlistTitles || {})[url] ||
          (/vk(video)?\./i.test(url) ? 'VK playlist ' + (String(url).split('/').pop() || '') : 'Playlist'),
        uploader: '',
        thumbnail: resolved.thumbnail || null,
        count: resolved.items.length,
        entries,
        items: resolved.items.map((it) => it.url),
        formats: [],
      },
    };
  }
  if (resolved && resolved.mediaUrl) {
    return await infoFromResolved(url, resolved);
  }

  const res = await engine.getInfo(url, settings);
  if (!res.ok) {
    // yt-dlp gave up — try to find a plain media file on the page ourselves
    const fb = await resolvers.fallbackResolve(url);
    let picked = fb && fb.mediaUrl ? fb : null;
    if (!picked) {
      // last resort: run the page in a hidden window and catch its own stream
      try {
        const sn = await sniffer.sniff(url, { timeout: 40000 });
        if (sn && sn.mediaUrl) picked = sn;
      } catch (_) {}
    }
    if (picked) {
      return await infoFromResolved(url, picked);
    }
    return res;
  }
  const info = engine.compactInfo(res.data);
  if (info.thumbnail) {
    const pageUrl = info.webpage_url || url;
    const dataUrl = await fetchThumbDataUrl(info.thumbnail, pageUrl);
    info.thumbnailRemote = info.thumbnail;
    if (dataUrl) info.thumbnail = dataUrl;
  }
  return { ok: true, info };
});

ipcMain.handle('thumb:get', async (_e, url, pageUrl) => {
  if (!url || typeof url !== 'string') return null;
  return await fetchThumbDataUrl(url, pageUrl);
});

/**
 * Scan a download folder (and its playlist sub-folders) and report which of the
 * given tokens are already on disk.
 */
ipcMain.handle('files:scan', async (_e, payload) => {
  const dir = (payload && payload.dir) || settings.downloadDir;
  const tokens = ((payload && payload.tokens) || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!dir || !tokens.length) return [];
  const names = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth > 0) walk(full, depth - 1); }
      else names.push(e.name.toLowerCase());
    }
  };
  walk(dir, 2);
  const found = [];
  for (const t of tokens) {
    if (names.some((n) => n.includes(t))) found.push(t);
  }
  return found;
});

ipcMain.handle('yt:download', async (_e, payload) => {
  if (!settings.downloadDir) {
    return { error: 'Choose a download folder first (Settings → Download folder).' };
  }
  // Stamp the folder HERE, from the live settings, and never trust a folder the
  // renderer sends: the renderer keeps its own cached copy of the settings and a
  // folder picked in the native dialog used to leave that copy stale, so new rows
  // silently inherited the folder the user had just changed away from.
  const item = eng.add({ ...payload, downloadDir: settings.downloadDir });
  return { id: item.id };
});

ipcMain.handle('yt:cancel', (_e, id) => { eng.cancel(id); return true; });
ipcMain.handle('yt:retry', (_e, id) => { eng.retry(id); return true; });
ipcMain.handle('yt:remove', (_e, id) => { eng.remove(id); return true; });
ipcMain.handle('yt:clearDone', () => { eng.clearDone(); return true; });
function emitPaused() {
  try { if (win) win.webContents.send('engine:paused', eng.paused); } catch (_) {}
}

ipcMain.handle('yt:paused', () => eng.paused);
ipcMain.handle('yt:pauseAll', () => { settings.paused = true; persist(); eng.pauseAll(); emitPaused(); return true; });
ipcMain.handle('yt:resumeAll', () => { settings.paused = false; persist(); eng.resumeAll(); emitPaused(); return true; });

ipcMain.handle('yt:schema', async () => {
  try { return { ok: true, groups: await engine.getSchema() }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('yt:update', async () => {
  const before = await engine.version();
  const r = await engine.updateYtDlp();
  const after = await engine.version();
  return { ...r, version: after, before, changed: before !== after };
});

/* ---------------- engines: version / rollback ---------------- */
ipcMain.handle('engines:info', async () => {
  const stable = require('./paths').stableBinDir();
  const bundled = require('./paths').resourcesBinDir();
  const v = await engine.version();
  let bundledVersion = '';
  try {
    const r = await engine.runCapture(['--version'], { timeout: 20000, exePath: path.join(bundled, 'yt-dlp.exe') });
    bundledVersion = String(r.stdout || '').trim();
  } catch (_) {}
  return { version: v, bundledVersion, stable, bundled, data: dataDir() };
});

ipcMain.handle('engines:restore', async () => {
  const paths = require('./paths');
  const done = paths.restoreBundledBins();
  const v = await engine.version();
  return { ok: done.length > 0, restored: done, version: v };
});

/* ---------------- bring a portable setup over ---------------- */
/**
 * Copies settings, queue, history, cookie jars and cached thumbnails from a
 * portable build into this install. Nothing is deleted on either side.
 */
function importPortableData(srcRoot) {
  let src = String(srcRoot || '');
  if (!src) return { ok: false, error: 'No folder chosen.' };
  // accept either the data folder itself or the folder that contains it
  if (!fs.existsSync(path.join(src, 'settings.json')) && fs.existsSync(path.join(src, 'yt-dlp-studio-data', 'settings.json'))) {
    src = path.join(src, 'yt-dlp-studio-data');
  }
  if (!fs.existsSync(path.join(src, 'settings.json'))) {
    return { ok: false, error: 'That folder has no settings.json — pick the folder that contains “yt-dlp-studio-data”.' };
  }
  const dest = dataDir();
  const copied = [];
  for (const name of ['settings.json', 'queue.json']) {
    const from = path.join(src, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dest, name));
    copied.push(name);
  }
  for (const dir of ['cookies', 'thumbs']) {
    const from = path.join(src, dir);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dest, dir);
    fs.mkdirSync(to, { recursive: true });
    let n = 0;
    for (const f of fs.readdirSync(from)) {
      try { fs.copyFileSync(path.join(from, f), path.join(to, f)); n++; } catch (_) {}
    }
    if (n) copied.push(`${dir}/ (${n} files)`);
  }
  // reload from disk so the running app uses the imported state
  loadSettings(); // assigns the module-level `settings` itself
  eng.settings = settings;
  try {
    const q = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
    eng.hydrate(q);
  } catch (_) {}
  try { if (win) win.webContents.send('app:reloaded'); } catch (_) {}
  return { ok: true, copied, from: src, queue: eng.queue.length, history: (settings.history || []).length };
}

ipcMain.handle('data:import', async (_e, folder) => {
  let src = folder;
  if (!src) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pick the folder that holds yt-dlp-studio-data',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
    src = r.filePaths[0];
  }
  return importPortableData(src);
});

/** First launch of an installed build: offer to bring the portable setup over. */
async function offerPortableImport() {
  if (!app.isPackaged || PORTABLE_DATA) return;
  if (fs.existsSync(settingsPath())) return; // already has a setup
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Import my portable setup…', 'Start fresh'],
    defaultId: 0,
    cancelId: 1,
    title: 'yt-dlp-GUI Studio App',
    message: 'Do you want to bring over your queue, settings, history and cookies from the portable build?',
    detail: 'Nothing is deleted from the portable copy. You can also do this later in Settings.',
  });
  if (choice.response !== 0) return;
  const pick = await dialog.showOpenDialog({
    title: 'Pick the folder that holds yt-dlp-studio-data',
    properties: ['openDirectory'],
  });
  if (pick.canceled || !pick.filePaths.length) return;
  const res = importPortableData(pick.filePaths[0]);
  if (!res.ok) {
    dialog.showMessageBox({ type: 'error', message: 'Import failed', detail: res.error || 'Unknown error' });
  }
}

/* ---------------- cookie jars ---------------- */
function cookieDir() {
  const d = path.join(dataDir(), 'cookies');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Accepts either a Netscape cookies.txt or a raw `Cookie:` header string
 * (`a=b; c=d`) and writes a Netscape file yt-dlp can use.
 */
function netscapeLine(domain, opts = {}) {
  const d = String(domain || '').startsWith('.') ? String(domain) : '.' + String(domain);
  const name = opts.httpOnly ? '#HttpOnly_' + d : d;
  const safe = (v) => String(v == null ? '' : v).replace(/[\t\r\n]/g, ' ');
  return [name, 'TRUE', opts.path || '/', opts.secure ? 'TRUE' : 'FALSE',
    Math.max(0, Math.floor(opts.expires || 0)), safe(opts.name), safe(opts.value)].join('\t');
}

/**
 * Accepts any of:
 *   - a raw `Cookie:` header          (a=b; c=d)
 *   - a JSON export from Cookie-Editor / EditThisCookie / Playwright
 *     ([{name, value, domain, path, secure, httpOnly, expirationDate}])
 *   - a plain JSON object             ({"a": "b"})
 *   - a Netscape cookies.txt
 */
async function saveCookieJar(raw, domain) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Nothing pasted.' };
  let host = String(domain || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/^www\./, '');
  if (!host) return { ok: false, error: 'Enter the site domain (for example vimeo.com).' };
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return { ok: false, error: 'That does not look like a domain.' };
  const fallback = '.' + host;

  const lines = ['# Netscape HTTP Cookie File', ''];
  let count = 0;
  const names = []; // to tell a signed-in jar from a visitor jar

  const looksJson = text.startsWith('[') || text.startsWith('{');
  if (looksJson) {
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      return { ok: false, error: 'That looks like JSON but could not be parsed.' };
    }
    const push = (o) => {
      if (!o || !o.name) return;
      names.push(String(o.name));
      lines.push(netscapeLine(o.domain || fallback, {
        path: o.path,
        secure: !!o.secure,
        expires: o.expirationDate || o.expires || o.expiration || 0,
        httpOnly: !!(o.httpOnly || o.httponly),
        name: o.name,
        value: o.value,
      }));
      count++;
    };
    if (Array.isArray(data)) data.forEach(push);
    else if (data && typeof data === 'object') {
      // {"cookieName": "value"} or {"cookies": [...]}
      if (Array.isArray(data.cookies)) data.cookies.forEach(push);
      else Object.entries(data).forEach(([name, value]) => {
        if (typeof value === 'string' || typeof value === 'number') push({ name, value });
      });
    }
    if (!count) return { ok: false, error: 'No cookies with a name/value found in that JSON.' };
  } else if (/^#\s*Netscape/i.test(text) || /\n[^\n]*\t[^\n]*\t/.test(text)) {
    const body = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    for (const line of body) {
      const f = line.split('\t');
      if (f.length >= 7) names.push(f[5]);
    }
    lines.push(...body);
    count = body.length;
  } else {
    const pairs = text
      .replace(/^Cookie:\s*/i, '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !/^(path|domain|expires|max-age|secure|httponly|samesite|priority)=/i.test(p));
    for (const p of pairs) {
      const eq = p.indexOf('=');
      if (eq < 1) continue;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      if (!name) continue;
      lines.push(netscapeLine(fallback, { name, value }));
      count++;
    }
    if (!count) return { ok: false, error: 'No name=value pairs found in that text.' };
  }

  const file = path.join(cookieDir(), host.replace(/[^a-z0-9.-]/gi, '_') + '.txt');

  // VK's login cookie lives on vk.com, but its video pages are served from
  // vkvideo.ru — and yt-dlp asks https://vk.com/al_video.php. A jar scoped only
  // to the site the user happened to be browsing is useless: the request to
  // vk.com goes out without any Cookie header and VK answers "Access
  // restricted". Copy every cookie onto the other VK domains so the session
  // travels with it whichever site the export came from.
  const VK_SITES = ['.vk.com', '.vk.ru', '.vkvideo.ru'];
  const isVkSite = VK_SITES.some((d) => host === d.slice(1) || host.endsWith(d));
  let copies = 0;
  if (isVkSite) {
    const body = lines.slice(2).filter(Boolean);
    const seen = new Set(body.map((l) => {
      const f = l.split('\t');
      return (f[0].replace(/^#HttpOnly_/, '') + '|' + (f[5] || '')).toLowerCase();
    }));
    for (const d of VK_SITES) {
      for (const line of body) {
        const f = line.split('\t');
        if (f.length < 7) continue;
        const key = (d + '|' + f[5]).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const copy = [...f];
        copy[0] = f[0].startsWith('#HttpOnly_') ? '#HttpOnly_' + d : d;
        lines.push(copy.join('\t'));
        copies++;
      }
    }
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  settings.cookieJars = { ...(settings.cookieJars || {}), [host]: file };
  persist();

  // A jar full of preference cookies but no login cookie is the classic trap: it
  // saves fine, then the site still treats the user as a visitor and every
  // "sign in / age-restricted" video keeps failing with no visible reason.
  // VK hands EVERY visitor a `remixsid`, so on VK the name proves nothing —
  // a signed-in account also carries `remixlhk` / `remix_userid` / `remix_userkey`.
  const SESSION_COOKIE = /^(remixsid|remixsid6|sid|sessionid|session_id|phpsessid|auth_token|li_at|csrftoken)$/i;
  const VK_LOGIN = /^(remixlhk|remix_userid|remix_userkey)$/i;
  const hasLogin = isVkSite ? names.some((n) => VK_LOGIN.test(n)) : names.some((n) => SESSION_COOKIE.test(n));
  const vkSession = isVkSite ? await vkSessionState(file) : null;
  let warning = '';
  if (isVkSite && vkSession === 'anonymous') {
    warning =
      `Saved ${count} cookie${count === 1 ? '' : 's'}, but VK answered as a visitor, not as you: the browser you exported ` +
      'from was not signed in (VK gives even signed-out visitors a “remixsid”, so it looks like a session but is not one). ' +
      'Open https://vk.com, sign in until your avatar shows in the top-right corner, then Cookie-Editor → Export → JSON and paste it here again.';
  } else if (!hasLogin) {
    warning = isVkSite
      ? `Saved ${count} cookie${count === 1 ? '' : 's'}, but VK's login cookie (“remixlhk” / “remix_userid”) is not among them. ` +
        'Sign in at https://vk.com (avatar visible), then export again with Cookie-Editor and paste that JSON.'
      : `Saved ${count} cookie${count === 1 ? '' : 's'}, but none of them is a login cookie. ` +
        'The site will still treat you as signed out. Open the site in your browser, make sure you are really logged in ' +
        '(your name or avatar is showing), then export again with Cookie-Editor.';
  }
  return { ok: true, domain: host, count, copies, file, hasLogin, vkSession, warning };
}

/**
 * Asks vk.com who these cookies belong to. VK marks an anonymous visitor's page
 * with an `anonymId` and a signed-in one with a logout link, so this is the only
 * way to answer "am I really signed in?" without guessing from cookie names.
 */
function readJarRows(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\u000d$/, ''))
    .filter((l) => l && l.includes('\t'))
    .map((l) => l.split('\t'))
    .filter((f) => f.length >= 7);
}

function vkSessionState(jarFile) {
  return new Promise((resolve) => {
    let jar = [];
    try { jar = readJarRows(jarFile); } catch (_) { return resolve('unknown'); }
    const now = Math.floor(Date.now() / 1000);
    const header = jar.filter((f) => {
      const dom = f[0].replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
      const exp = Number(f[4]) || 0;
      return (dom === 'vk.com' || 'vk.com'.endsWith('.' + dom)) && (!exp || exp > now);
    }).map((f) => f[5] + '=' + f[6]).join('; ');    if (!header) return resolve('unknown');
    const req = require('https').request({
      host: 'vk.com', path: '/feed', method: 'GET', timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: header,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 500000) body += d; });
      res.on('end', () => {
        const anon = /"anonymId"/.test(body);
        const loggedIn = /"loggedIn":\s*true/.test(body) || /\/logout/.test(body);
        resolve(loggedIn && !anon ? 'signed_in' : anon ? 'anonymous' : 'unknown');
      });
    });
    req.on('error', () => resolve('unknown'));
    req.on('timeout', () => { req.destroy(); resolve('unknown'); });
    req.end();
  });
}

ipcMain.handle('cookies:save', (_e, payload) => saveCookieJar(payload && payload.raw, payload && payload.domain));

/* ---------------- VK: capture a stream from a real player window ---------------- */
// Some VK videos only hand out their stream after a real click in a real browser,
// so this opens the page in its own window and watches the network for the media
// playlist. No login is stored here — it is a capture window, nothing else.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VK_PARTITION = 'persist:vk-login';
/**
 * Opens the video in a real, visible VK window and waits for YOU to press play.
 * VK's player only requests the stream after a real click, and the login lives in
 * that window's own storage — so a human click is the one thing that reliably gets
 * the media URL out. Whatever it plays, we capture and download.
 */
ipcMain.handle('vk:capture', async (_e, url, opts = {}) => {
  const pageUrl = String(url || '');
  if (!/^https?:/i.test(pageUrl)) return { ok: false, error: 'Not a link.' };
  const ses = session.fromPartition(VK_PARTITION);
  const win = new BrowserWindow({
    width: 900, height: 640, title: 'Press play — the download starts by itself',
    webPreferences: { partition: VK_PARTITION, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  const found = [];
  const filter = { urls: ['*://*/*.m3u8*', '*://*/*.mp4*'] };
  const listener = (details) => {
    if (details && details.url && /m3u8|\.mp4/i.test(details.url) && !found.includes(details.url)) found.push(details.url);
  };
  try { ses.webRequest.onBeforeRequest(filter, listener); } catch (_) {}
  try { win.webContents.setUserAgent(CHROME_UA); } catch (_) {}
  await win.loadURL(pageUrl).catch(() => {});
  const deadline = Date.now() + (Number(opts.timeoutMs) || 180000);
  while (Date.now() < deadline && !found.length) {
    await new Promise((r) => setTimeout(r, 800));
    if (win.isDestroyed()) break;
  }
  try { ses.webRequest.onBeforeRequest(null); } catch (_) {}
  if (!win.isDestroyed()) win.destroy();
  const media = found.filter((u) => /m3u8/i.test(u))[0] || found[0] || '';
  return media ? { ok: true, mediaUrl: media, referer: pageUrl } : { ok: false, error: 'Nothing was played in that window, so there was no stream to capture.' };
});

/**
 * Runs yt-dlp once against the link the user is trying, using the saved jar, and
 * reports whether the site accepts the session. This is the only honest answer
 * to "did my cookies work?" — anything else is a guess.
 */
ipcMain.handle('cookies:test', async (_e, payload) => {
  const url = String((payload && payload.url) || '').trim();
  const domain = String((payload && payload.domain) || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    // No link yet: for VK we can still answer the real question by asking vk.com
    // who these cookies belong to.
    const jar0 = domain && (settings.cookieJars || {})[domain];
    if (jar0 && fs.existsSync(jar0)) {
      const st = await vkSessionState(jar0);
      if (st === 'signed_in') return { ok: true, title: 'you are signed in to VK' };
      if (st === 'anonymous') {
        return { ok: false, error: 'VK answers as a visitor, not as you — these cookies come from a browser that was not signed in.' };
      }
    }
    return { ok: false, error: 'Put the video link in the address bar first, then press Test.' };
  }
  const jar = engine.cookieJarFor(url, settings) || (domain && (settings.cookieJars || {})[domain]) || null;
  if (!jar || !fs.existsSync(jar)) return { ok: false, error: 'No saved cookies for that site yet — save them first.' };
  const args = ['--no-colors', '--no-warnings', '--ignore-config', '--cookies', jar,
    '--js-runtimes', 'deno', '--impersonate', 'chrome', '--simulate', '--print', '%(title)s', url];
  const { code, stdout, stderr } = await engine.runCapture
    ? await engine.runCapture(args, { timeout: 90000 })
    : { code: 1, stdout: '', stderr: 'internal: runCapture missing' };
  if (code === 0) {
    const title = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '(no title)';
    return { ok: true, title };
  }
  return { ok: false, error: engine.friendlyError(stderr || stdout) };
});
ipcMain.handle('cookies:list', () => {
  const jars = settings.cookieJars || {};
  return Object.entries(jars).map(([domain, file]) => {
    let count = 0;
    try {
      count = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).length;
    } catch (_) {}
    return { domain, file, count };
  });
});
ipcMain.handle('cookies:clear', (_e, domain) => {
  const jars = { ...(settings.cookieJars || {}) };
  const file = jars[domain];
  if (file) { try { fs.unlinkSync(file); } catch (_) {} }
  delete jars[domain];
  settings.cookieJars = jars;
  persist();
  return true;
});

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('page:probe', async (_e, url) => {
  const p = await sniffer.renderPage(url, {
    timeout: 45000,
    maxRounds: 3,
    collectRequests: true,
    cookieFile: engine.cookieJarFor(url, settings),
  });
  if (!p) return { ok: false };
  const api = (p.requests || []).filter((u) => /externulls|\/api\//i.test(u));
  return { ok: true, title: p.title, links: p.links.length, sample: p.links.slice(0, 4), api: [...new Set(api)].slice(0, 25) };
});

ipcMain.handle('sniff:debug', async (_e, url) => {
  const r = await sniffer.sniff(url, { timeout: 40000 });
  return r || null;
});

ipcMain.handle('res:debug', async (_e, url) => {
  try { return { ok: true, result: await resolvers.resolve(url) }; }
  catch (e) { return { ok: false, error: String(e && e.message) }; }
});
ipcMain.handle('eng:debug', () => ({
  running: eng.running ? eng.running.id : null,
  runningStatus: eng.running ? eng.running.status : null,
  active: [...eng.active.keys()],
  concurrency: eng.concurrency,
  childPid: (() => { const c = [...eng.children.values()][0]; return c ? c.pid : null; })(),
  busy: eng.active.size > 0,
  paused: eng.paused,
  queue: eng.queue.map((i) => ({
    id: i.id, status: i.status, pct: Math.round(i.percent || 0), pid: i.pid || null,
    error: (i.error || '').slice(0, 200), note: (i.note || '').slice(0, 200), logs: (i.logs || []).slice(-6),
  })),
}));
/* ---------------- settings backup / restore ---------------- */

function cookieDir() {
  const d = path.join(dataDir(), 'cookies');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

/**
 * Everything the user configured, in one JSON file, plus his cookie jars (small
 * text files — without them a fresh Windows install cannot download from the
 * sites that need a login). History and the queue are data, not settings, and
 * stay out. `filePath` is only passed by tests; the UI leaves it out so the
 * native save dialog runs in main.
 */
ipcMain.handle('settings:backup', async (_e, filePath) => {
  let target = typeof filePath === 'string' ? filePath : '';
  if (!target) {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Save a copy of your settings',
      defaultPath: path.join(app.getPath('documents'), `yt-dlp-studio-settings-${stamp}.json`),
      filters: [{ name: 'Settings backup', extensions: ['json'] }],
      buttonLabel: 'Save backup',
    });
    if (r.canceled || !r.filePath) return { ok: false };
    target = r.filePath;
  }
  const cookies = {};
  for (const [domain, file] of Object.entries(settings.cookieJars || {})) {
    try { if (file && fs.existsSync(file)) cookies[domain] = fs.readFileSync(file, 'utf8'); } catch (_) {}
  }
  const payload = {
    app: 'yt-dlp-GUI Studio App',
    kind: 'settings-backup',
    version: app.getVersion(),
    exportedAt: new Date().toISOString(),
    settings: { ...settings, history: [] },
    cookies,
  };
  try {
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: 'Could not write the file: ' + (e && e.message) };
  }
  return { ok: true, path: target, cookies: Object.keys(cookies).length };
});

ipcMain.handle('settings:restore', async (_e, filePath) => {
  let source = typeof filePath === 'string' ? filePath : '';
  if (!source) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Restore settings from a backup',
      defaultPath: app.getPath('documents'),
      filters: [{ name: 'Settings backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    source = r.filePaths[0];
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (_) {
    return { ok: false, error: 'That file is not a backup — it could not be read as JSON.' };
  }
  // accept both our own export and a raw settings.json
  const incoming =
    data && data.settings && typeof data.settings === 'object'
      ? data.settings
      : data && (data.downloadDir || data.presetPills || data.presets || data.theme)
      ? data
      : null;
  if (!incoming) return { ok: false, error: 'That file does not look like a yt-dlp-GUI Studio App backup.' };

  // history is data: keep what this machine has
  const keptHistory = settings.history || [];
  settings = { ...settings, ...incoming, history: keptHistory };
  delete settings.queue;
  settings.paused = false;

  // cookie jars come back as files; the paths stored in the backup point at the
  // old machine, so anything that no longer exists is dropped
  const jars = {};
  for (const [domain, text] of Object.entries((data && data.cookies) || {})) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const safe = String(domain).replace(/[^\w.-]/g, '_');
    const file = path.join(cookieDir(), safe + '.txt');
    try { fs.writeFileSync(file, text, 'utf8'); jars[domain] = file; } catch (_) {}
  }
  if (Object.keys(jars).length) settings.cookieJars = { ...(settings.cookieJars || {}), ...jars };
  for (const [domain, file] of Object.entries(settings.cookieJars || {})) {
    if (!file || !fs.existsSync(file)) delete settings.cookieJars[domain];
  }

  eng.settings = settings;
  persist();
  try { fs.mkdirSync(settings.downloadDir, { recursive: true }); } catch (_) {}
  eng.pump();
  return { ok: true, settings, cookies: Object.keys(jars).length, path: source };
});

ipcMain.handle('history:get', () => settings.history || []);
ipcMain.handle('history:clear', () => { settings.history = []; persist(); return true; });
ipcMain.handle('history:thumb', async (_e, filepath) => historyThumb(filepath));
ipcMain.handle('queue:removeAll', () => { eng.removeAll(); settings.paused = false; persist(); emitPaused(); return true; });
ipcMain.handle('queue:retryFailed', () => eng.retryFailed());
ipcMain.handle('queue:pauseSelected', (_e, ids) => eng.pauseSelected(ids));
ipcMain.handle('queue:resumeSelected', (_e, ids) => eng.resumeSelected(ids));

/**
 * Move the selected queue rows to another folder. `dir` is only passed by tests —
 * the UI leaves it out so the native picker opens here, in main, and no stale
 * settings copy can sneak into the result.
 */
ipcMain.handle('queue:folderFor', async (_e, ids, dir) => {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  if (!list.length) return { ok: false, dropped: 0, moved: 0 };
  let target = typeof dir === 'string' && dir.trim() ? dir.trim() : '';
  if (!target) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Move the selected videos to…',
      defaultPath: settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Move here',
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, dropped: 0, moved: 0 };
    target = r.filePaths[0];
  }
  try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
  const moved = eng.setFolderFor(list, target);
  // rows that were mid-download cannot move: report them so the UI can say so
  const busy = eng.queue.filter((i) => list.includes(i.id) && ['running', 'processing', 'resolving'].includes(i.status)).length;
  return { ok: true, dir: target, moved, dropped: busy };
});

/* ---------------- engine events ---------------- */
eng.on('update', (queue) => {
  if (win) win.webContents.send('queue:update', queue);
  persistQueue(queue);
});
eng.on('log', (l) => win && win.webContents.send('queue:log', l));

eng.on('done', (item) => {
  const entry = {
    id: item.id,
    title: item.title,
    url: item.url,
    filepath: item.filepath,
    preset: item.preset,
    at: Date.now(),
  };
  settings.history = [entry, ...(settings.history || [])].slice(0, 500);
  persist();
  if (win) {
    win.webContents.send('app:toast', { kind: 'ok', text: `Finished: ${item.title}` });
    if (!win.isFocused()) {
      try {
        const n = new Notification({ title: 'Download finished', body: item.title, silent: true });
        n.on('click', () => { win.show(); win.focus(); });
        n.show();
      } catch (_) {}
    }
  }
});

/* ---------------- lifecycle ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    loadSettings();
    try { ensureBins(); } catch (_) {}
    try {
      const saved = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
      eng.hydrate(saved);
      // Pause is a decision, not a transient state: if the user paused and closed
      // the app, the restored queue must stay paused instead of starting itself.
      eng.paused = !!settings.paused;
      if (!eng.paused && eng.queue.some((i) => i.status === 'queued')) setTimeout(() => eng.pump(), 1500);
    } catch (_) {}
    await offerPortableImport();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', () => {
    try {
      clearTimeout(queueTimer);
      const slim = eng.snapshot().map((i) => ({ ...i, thumbnail: String(i.thumbnail || '').startsWith('data:') ? '' : i.thumbnail }));
      fs.writeFileSync(queuePath(), JSON.stringify(slim), 'utf8');
    } catch (_) {}
    for (const child of eng.children.values()) {
      try { if (child && child.pid) engine.killTree(child.pid); } catch (_) {}
    }
  });
}
