"use strict";
/**
 * Media sniffer.
 *
 * Some sites build their stream URL inside JavaScript and bind it to the browser
 * session (signed key + cookies), so it cannot be reproduced from outside. For
 * those we open a hidden window with its own session, let the page run its own
 * player, watch the network for the real stream, then hand yt-dlp that URL
 * together with the cookies from the same session.
 */
const { BrowserWindow, session } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function isMedia(u) {
  if (!/\.(m3u8|mp4|webm)(\?|$)/i.test(u)) return false;
  if (/\.(m4s|ts|jpg|jpeg|png|webp|vtt|srt|key|css|js)(\?|$)/i.test(u)) return false;
  if (/preview|trailer|sprite|thumb|poster|_mobile\.mp4|sample/i.test(u)) return false;
  return true;
}

function baseDomain(host) {
  const parts = String(host || "").split(".");
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

/** Netscape cookies.txt, which yt-dlp understands. Only the site's own cookies. */
async function writeCookiesFile(ses, pageUrl) {
  let host = "";
  try { host = new URL(pageUrl).hostname; } catch (_) {}
  const base = baseDomain(host);
  const cookies = (await ses.cookies.get({})).filter((c) => {
    const d = String(c.domain || "").replace(/^\./, "").toLowerCase();
    if (!base || !(d === base || d.endsWith("." + base))) return false;
    if (/[\t\r\n]/.test(c.name || "") || /[\t\r\n]/.test(c.value || "")) return false;
    return true;
  });
  if (!cookies.length) return null;
  const lines = ["# Netscape HTTP Cookie File", ""];
  for (const c of cookies) {
    const domain = c.domain.startsWith(".") ? c.domain : "." + c.domain;
    const includeSub = "TRUE";
    const expires = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    const name = c.httpOnly ? "#HttpOnly_" + domain : domain;
    lines.push([name, includeSub, c.path || "/", c.secure ? "TRUE" : "FALSE", expires, c.name, c.value].join("\t"));
  }
  const file = path.join(os.tmpdir(), `ytdlp-sniff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

function sniff(pageUrl, { timeout = 40000, match = null } = {}) {
  return new Promise((resolve) => {
    const state = { settled: false, part: null, win: null, timer: null, hits: [] };

    const done = async (result) => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(state.timer);

      let meta = {};
      if (state.win && !state.win.isDestroyed()) {
        try {
          const raw = await state.win.webContents.executeJavaScript(
            "JSON.stringify((() => { const g = (p) => { const el = document.querySelector('meta[property=\"' + p + '\"]'); return el && el.content ? el.content : null; }; const v = document.querySelector('video'); return { t: g('og:title') || document.title || null, i: g('og:image') || (v && v.poster) || null }; })())"
          );
          meta = JSON.parse(raw);
        } catch (_) {}
      }

      let cookiesFile = null;
      if (state.part) {
        try { cookiesFile = await writeCookiesFile(state.part, pageUrl); } catch (_) {}
      }

      try { if (state.win && !state.win.isDestroyed()) state.win.destroy(); } catch (_) {}

      if (!result) return resolve(null);
      resolve({
        mediaUrl: result.mediaUrl,
        referer: pageUrl,
        cookiesFile,
        title: meta.t || null,
        thumbnail: meta.i || null,
      });
    };

    const best = () => state.hits.find((u) => /\.m3u8/i.test(u)) || state.hits[0];

    try {
      state.part = session.fromPartition("persist:ytdlp-render");
      state.part.setUserAgent(UA);
      state.win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: { session: state.part, javascript: true, images: true },
      });
      state.win.webContents.setAudioMuted(true);
    } catch (_) {
      return done(null);
    }

    state.timer = setTimeout(() => done(best() ? { mediaUrl: best() } : null), timeout);

    try {
      state.part.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, cb) => {
        const u = details.url;
        if (isMedia(u) && (!match || match.test(u))) {
          state.hits.push(u);
          if (/\.m3u8/i.test(u)) done({ mediaUrl: u });
        }
        cb({});
      });
    } catch (_) {}

    state.win.webContents.on("did-finish-load", async () => {
      try {
        await state.win.webContents.executeJavaScript(
          "(() => { const v = document.querySelector('video'); if (v) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } const b = document.querySelector('[class*=play],[id*=play]'); if (b && !v) b.click(); window.dispatchEvent(new Event('scroll')); return 1; })()"
        );
      } catch (_) {}
    });

    state.win.webContents.on("did-fail-load", () => {
      if (!state.hits.length) done(null);
    });

    state.win.loadURL(pageUrl, { userAgent: UA }).catch(() => done(null));
  });
}

/** Load a Netscape cookie file into a session so private pages render. */
async function applyCookies(ses, cookieFile) {
  if (!cookieFile || !fs.existsSync(cookieFile)) return;
  const lines = fs.readFileSync(cookieFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("# ") || line === "# Netscape HTTP Cookie File") continue;
    const isHttpOnly = line.startsWith("#HttpOnly_");
    const f = (isHttpOnly ? line.replace("#HttpOnly_", "") : line).split("\t");
    if (f.length < 7) continue;
    const [domain, , cpath, secureF, expires, name, ...rest] = f;
    const value = rest.join("\t");
    const host = domain.replace(/^\./, "");
    try {
      await ses.cookies.set({
        url: (secureF === "TRUE" ? "https://" : "http://") + host + (cpath || "/"),
        name,
        value,
        domain,
        path: cpath || "/",
        secure: secureF === "TRUE",
        httpOnly: isHttpOnly,
        expirationDate: Number(expires) || undefined,
      });
    } catch (_) {}
  }
}

/**
 * Runs inside the rendered page: returns the doc title, every link, and one
 * card per anchor (href, title text, poster, duration).
 *
 * Reading an anchor's own text is not enough on grids: the same video is
 * usually linked twice (once for the thumbnail with the duration, once for the
 * title), so the text of the video link can be just "12:34". Reading the whole
 * row is wrong too — it drags in the drag handle, the uploader and
 * "135K views · 6 years ago". So: find the row that owns the link, and take the
 * row's video link with the most text as the title.
 */
const SNAPSHOT_JS = function () {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const VID = /\/video-?\d+_\d+/;
  const DUR = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const ROW_CLASS = /vkuiCell__content|vkuiSimpleCell|(^|[\s_-])(card|row|item|cell)([\s_-]|$)/i;
  const rowOf = (a) => {
    let el = a;
    for (let d = 0; d < 6 && el; d++) {
      if (ROW_CLASS.test(String(el.className || ""))) return el;
      el = el.parentElement;
    }
    return a.parentElement || a;
  };
  const anchors = Array.from(document.querySelectorAll("a[href]")).slice(0, 20000);
  return {
    title: document.title,
    h1: (document.querySelector("h1") || {}).textContent || "",
    links: anchors.map((a) => a.href),
    cards: anchors.map((a) => {
      const img = a.querySelector("img") || (a.parentElement && a.parentElement.querySelector("img"));
      const own = clean(a.innerText || a.textContent || "");
      let text = own;
      let dur = "";
      if (VID.test(a.getAttribute("href") || "")) {
        const row = rowOf(a);
        const links = row ? Array.from(row.querySelectorAll("a[href]")).filter((x) => VID.test(x.getAttribute("href") || "")) : [];
        let best = "";
        for (const x of links.length ? links : [a]) {
          const t = clean(x.innerText || x.textContent || "");
          if (!t) continue;
          if (DUR.test(t)) {
            if (!dur) dur = t;
            continue;
          }
          if (t.length > best.length) best = t;
        }
        if (best) text = best;
        if (!dur && DUR.test(own)) dur = own;
      }
      return {
        href: a.href,
        text: text.slice(0, 200),
        aria: clean(a.getAttribute("aria-label") || "").slice(0, 200),
        img: img ? img.currentSrc || img.src || "" : "",
        dur,
      };
    }),
  };
};

/**
 * Load a page in a hidden window and return its title plus every link it
 * rendered. Used for playlist pages that cannot be read from static HTML.
 */
function renderPage(pageUrl, { timeout = 35000, cookieFile = null, maxRounds = 25, collectRequests = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let win = null;
    const finish = async (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(out);
    };
    const timer = setTimeout(() => finish(null), timeout);
    const requests = [];

    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: { session: session.fromPartition("persist:ytdlp-render"), javascript: true, images: false },
      });
      win.webContents.setAudioMuted(true);
    } catch (_) {
      return finish(null);
    }

    if (collectRequests) {
      try {
        win.webContents.session.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (d, cb) => {
          requests.push(d.url);
          cb({});
        });
      } catch (_) {}
    }

    // Collect the visible text and the poster image next to each link as well:
    // playlist rows carry the video title in the anchor text, and the page is
    // useless without it (queue rows would read "Item 1", "Item 2", …).
    const snapshot = () => win.webContents.executeJavaScript(`(${SNAPSHOT_JS.toString()})()`);

    win.webContents.on("did-finish-load", async () => {
      try {
        await new Promise((r) => setTimeout(r, 3500)); // let the SPA paint the list

        // Keep scrolling until the number of links stops growing: infinite
        // feeds (VK, playlists) load their rows in batches.
        let data = { title: "", h1: "", links: [], cards: [] };
        // Virtualised grids throw old rows away as new ones appear, so keep the
        // union of everything seen during the scroll, not just the last screen.
        const seen = new Set();
        // href -> best card seen so far (longest visible text wins: a playlist
        // row often exposes the duration link and the real title link for the
        // same video, in that order).
        const cards = new Map();
        let lastCount = -1;
        let stable = 0;
        for (let i = 0; i < maxRounds; i++) {
          data = (await snapshot()) || {};
          for (const l of data.links || []) seen.add(l);
          for (const c of data.cards || []) {
            if (!c || !c.href) continue;
            const prev = cards.get(c.href);
            const nextText = (c.text || c.aria || "").trim();
            if (!prev || (nextText.length > (prev.text || "").length)) {
              cards.set(c.href, {
                href: c.href,
                text: nextText,
                img: c.img || (prev && prev.img) || "",
                dur: c.dur || (prev && prev.dur) || "",
              });
            } else {
              if (!prev.img && c.img) prev.img = c.img;
              if (!prev.dur && c.dur) prev.dur = c.dur;
            }
          }
          const count = seen.size;
          if (count <= lastCount) {
            stable++;
            if (stable >= 2) break; // two rounds with nothing new -> done
          } else {
            stable = 0;
            lastCount = count;
          }
          await win.webContents
            .executeJavaScript("window.scrollTo(0, document.body.scrollHeight); 1")
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        }
        finish({
          title: data.h1 || data.title || "",
          docTitle: data.title || "",
          links: [...seen],
          cards: [...cards.values()],
          requests,
        });
      } catch (_) {
        finish(null);
      }
    });

    win.webContents.on("did-fail-load", () => finish(null));

    (async () => {
      try { await applyCookies(win.webContents.session, cookieFile); } catch (_) {}
      win.loadURL(pageUrl, { userAgent: UA }).catch(() => finish(null));
    })();
  });
}

module.exports = { sniff, renderPage, applyCookies, UA };
