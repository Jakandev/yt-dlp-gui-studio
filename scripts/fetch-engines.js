'use strict';
/**
 * Downloads the engines the app drives, into ./bin:
 *
 *   yt-dlp.exe    the downloader itself
 *   ffmpeg.exe    muxing / merging / embedding
 *   ffprobe.exe   media inspection
 *   deno.exe      JavaScript runtime (YouTube and a few other sites need it)
 *
 * Nothing here is committed to the repository — binaries change often and would
 * bloat every clone. Run this once before `npm start` or before building:
 *
 *   npm run fetch-engines
 *
 * Existing files are kept unless you pass --force.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
const FORCE = process.argv.includes('--force');

const SOURCES = {
  'yt-dlp.exe': 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  'deno.zip': 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
  'ffmpeg.zip': 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
};

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'yt-dlp-gui-studio-setup' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        let lastPrint = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          const now = Date.now();
          if (total && now - lastPrint > 500) {
            lastPrint = now;
            process.stdout.write(`\r  ${path.basename(dest)}  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            if (total) process.stdout.write('\r' + ' '.repeat(60) + '\r');
            resolve(dest);
          });
        });
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function unzip(zip, destDir) {
  // Windows 10+ ships bsdtar, which reads zip files; no extra dependency needed.
  const r = spawnSync('tar', ['-xf', zip, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('could not extract ' + path.basename(zip));
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

(async () => {
  fs.mkdirSync(BIN, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-engines-'));

  console.log('Fetching engines into ' + BIN);
  try {
    // yt-dlp: a single exe
    const yt = path.join(BIN, 'yt-dlp.exe');
    if (FORCE || !fs.existsSync(yt)) {
      console.log('• yt-dlp');
      await download(SOURCES['yt-dlp.exe'], yt);
    } else console.log('• yt-dlp already present (use --force to refresh)');

    // ffmpeg + ffprobe: one zip, two exes
    if (FORCE || !fs.existsSync(path.join(BIN, 'ffmpeg.exe')) || !fs.existsSync(path.join(BIN, 'ffprobe.exe'))) {
      console.log('• ffmpeg + ffprobe (large download)');
      const zip = path.join(tmp, 'ffmpeg.zip');
      await download(SOURCES['ffmpeg.zip'], zip);
      const out = path.join(tmp, 'ffmpeg');
      fs.mkdirSync(out, { recursive: true });
      unzip(zip, out);
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        const found = findFile(out, name);
        if (!found) throw new Error(name + ' not found inside the ffmpeg archive');
        fs.copyFileSync(found, path.join(BIN, name));
      }
    } else console.log('• ffmpeg/ffprobe already present');

    // deno: one zip with a single exe
    if (FORCE || !fs.existsSync(path.join(BIN, 'deno.exe'))) {
      console.log('• deno');
      const zip = path.join(tmp, 'deno.zip');
      await download(SOURCES['deno.zip'], zip);
      const out = path.join(tmp, 'deno');
      fs.mkdirSync(out, { recursive: true });
      unzip(zip, out);
      const found = findFile(out, 'deno.exe');
      if (!found) throw new Error('deno.exe not found inside the archive');
      fs.copyFileSync(found, path.join(BIN, 'deno.exe'));
    } else console.log('• deno already present');

    console.log('\nDone. Engines in ' + BIN + ':');
    for (const f of fs.readdirSync(BIN)) {
      const size = (fs.statSync(path.join(BIN, f)).size / 1048576).toFixed(1);
      console.log(`  ${f.padEnd(14)} ${size} MB`);
    }
  } catch (e) {
    console.error('\nFailed: ' + e.message);
    console.error('You can also drop the four exes into bin/ by hand — see THIRD-PARTY-NOTICES.md for the sources.');
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
