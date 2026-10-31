'use strict';
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Resolve the folder that holds the bundled engines.
 * dev  -> <project>/bin
 * prod -> <install>/resources/bin (extraResources)
 */
function resourcesBinDir() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'bin'));
  candidates.push(path.join(app.getAppPath(), 'bin'));
  candidates.push(path.join(__dirname, '..', 'bin'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const BIN_FILES = ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe'];

/**
 * Packaged portable builds run from a temp extraction folder that Windows may
 * clean up underneath us. Keep a stable copy of the engines in the app's data
 * folder and prefer that one.
 */
function stableBinDir() {
  // outside the portable folder and outside the temp extraction, so a Windows
  // temp cleanup can never take the engines away mid-download
  return path.join(app.getPath('appData'), 'yt-dlp-studio', 'bin');
}

function ensureBins() {
  if (!app.isPackaged) return resourcesBinDir();
  const stable = stableBinDir();
  const src = resourcesBinDir();
  try {
    fs.mkdirSync(stable, { recursive: true });
    for (const name of BIN_FILES) {
      const from = path.join(src, name);
      const to = path.join(stable, name);
      if (!fs.existsSync(from)) continue;
      if (!fs.existsSync(to)) { fs.copyFileSync(from, to); continue; }
      // NEVER overwrite a newer engine: `yt-dlp -U` replaces the copy in the
      // stable folder, and the old size check used to silently undo that on the
      // next launch. Only a bundled file that is actually newer (a fresh build)
      // is allowed to win.
      try {
        const fromTime = fs.statSync(from).mtimeMs;
        const toTime = fs.statSync(to).mtimeMs;
        if (fromTime > toTime + 1000) fs.copyFileSync(from, to);
      } catch (_) {}
    }
    return stable;
  } catch (_) {
    return src;
  }
}

/** Force-copy the engines that shipped inside this build (rollback path). */
function restoreBundledBins() {
  const stable = stableBinDir();
  const src = resourcesBinDir();
  fs.mkdirSync(stable, { recursive: true });
  const done = [];
  for (const name of BIN_FILES) {
    const from = path.join(src, name);
    const to = path.join(stable, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, to);
    done.push(name);
  }
  return done;
}

function binDir() {
  const stable = stableBinDir();
  if (fs.existsSync(path.join(stable, 'ffmpeg.exe')) && fs.existsSync(path.join(stable, 'yt-dlp.exe'))) return stable;
  return resourcesBinDir();
}

function exe(name) {
  const p = path.join(binDir(), name);
  return fs.existsSync(p) ? p : name;
}

function dataDir() {
  const d = app.getPath('userData');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function defaultDownloadDir() {
  return path.join(app.getPath('downloads'), 'yt-dlp Studio');
}

module.exports = { binDir, ensureBins, restoreBundledBins, resourcesBinDir, stableBinDir, exe, dataDir, defaultDownloadDir };
