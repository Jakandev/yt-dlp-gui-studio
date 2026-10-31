'use strict';
/**
 * Site resolvers.
 *
 * yt-dlp's own plugin loader does not work inside its frozen (PyInstaller) exe,
 * so sites that yt-dlp cannot parse are handled here: we fetch the page with the
 * Chromium network stack (real TLS fingerprint, system proxy, no bot markers),
 * pull the direct media URL out of the HTML, and hand that URL to yt-dlp.
 *
 * A resolver returns:
 *   { mediaUrl, title, thumbnail, referer }   for a single video
 *   { playlist: true, title, items: [...] }   for a playlist page
 *   null                                      when it does not know the site
 */
const { net } = require('electron');
const sniffer = require('./sniffer');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function grab(url, referer) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(referer ? { Referer: referer } : {}),
  };
  try {
    const res = await net.fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    // Chromium's Safe Browsing blocks some embed hosts outright
    // (net::ERR_BLOCKED_BY_CLIENT). Node's fetch has no such blocklist.
    if (!/ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i.test(String(e && e.message))) return null;
    try {
      const res2 = await fetch(url, { headers, redirect: 'follow' });
      if (!res2.ok) return null;
      return await res2.text();
    } catch (_) {
      return null;
    }
  }
}

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();

function meta(html, prop) {
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

/** All absolute .mp4 / .m3u8 URLs in a page, de-duplicated and quality-sorted. */
function mediaUrls(html, base) {
  const out = new Set();
  const re = /(?:https?:)?\/\/[^"'\\\s<>()]+?\.(?:mp4|m3u8)[^"'\\\s<>()]*/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[0];
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.includes('.jpg') || u.includes('.webp') || u.includes('.png')) continue;
    out.add(decodeEntities(u.replace(/\\\//g, '/')));
  }
  const score = (u) => {
    const p = u.match(/[_\/](\d{3,4})(?:p|\.mp4)/i);
    if (p) return Number(p[1]);
    if (/_hd|_1080|_720/i.test(u)) return 720;
    if (/preview|thumbnail|trailer|_mobile/i.test(u)) return 1;
    return 100;
  };
  return [...out].sort((a, b) => score(b) - score(a));
}

/* ---------------------------------------------------------------- *
 *  VK Video playlists: yt-dlp's extractor throws "list index out of
 *  range" on these, but the rendered page lists every video link.
 * ---------------------------------------------------------------- */
function cleanVkTitle(t) {
  return String(t || 'VK playlist')
    .replace(/\s*[|—–]\s*VK.*$/i, '')
    .replace(/\s*—\s*Видео.*$/i, '')
    .trim() || 'VK playlist';
}

const VK_CHALLENGE = /робот|captcha|are you (a )?human|verify (that )?you|подтвердите|не робот/i;

/** UI noise VK puts in its row text ("Перенести ячейку", "135K views · 6 years ago"). */
const VK_NOISE = [
  /^перенести ячейку\s*/i,
  /^переместить\s*/i,
  /\s*\d[\d.,]*\s*[kmb]?\s*(views?|просмотр\w*)\s*(·.*)?$/i,
  /\s*\d+\s*(years?|months?|weeks?|days?|hours?|minutes?)\s+ago$/i,
  /\s*(лет|год\w*|месяц\w*|недел\w*|дн\w*|час\w*|минут\w*)\s+назад$/i,
];

/** "1:02:03" / "12:34" -> seconds (0 when it is not a duration). */
function durToSec(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Pick the video title out of a row's anchors.
 *
 * A VK row exposes several anchors with the same href — the duration ("12:34"),
 * the drag handle ("Перенести ячейку"), and the title itself — so the longest
 * remaining string is the title. Do NOT "clean up" comma-separated titles:
 * uploaders really do put tags and commas straight into the title.
 */
function vkPickTitle(candidates) {
  let best = '';
  for (const raw of candidates) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    for (const re of VK_NOISE) t = t.replace(re, '').trim();
    if (!t) continue;
    if (/^\d+:\d+(:\d+)?$/.test(t)) continue; // bare duration
    if (t.length > best.length) best = t;
  }
  return best.slice(0, 200);
}

async function vkPlaylist(pageUrl, cookieFile) {
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = await sniffer.renderPage(pageUrl, { timeout: 45000, cookieFile, maxRounds: 25 });
    if (!page || !page.links || !page.links.length) continue;

    const titleText = page.title || page.docTitle || '';
    const blocked = VK_CHALLENGE.test(titleText);

    // Group every anchor we saw by video id, so a row's duration link and its
    // title link end up on the same queue item.
    const byId = new Map();
    for (const href of page.links) {
      const m = String(href).match(/vk(?:video)?\.(?:ru|com)\/video(-?\d+_\d+)/) || String(href).match(/\/video(-?\d+_\d+)/);
      if (!m) continue;
      if (!byId.has(m[1])) byId.set(m[1], { texts: [], img: '', dur: '' });
    }
    for (const c of page.cards || []) {
      const m = String(c.href || '').match(/video(-?\d+_\d+)/);
      if (!m || !byId.has(m[1])) continue;
      const slot = byId.get(m[1]);
      if (c.text) slot.texts.push(c.text);
      if (c.aria) slot.texts.push(c.aria);
      if (!slot.img && c.img) slot.img = c.img;
      if (!slot.dur && c.dur) slot.dur = c.dur;
    }

    if (byId.size) {
      const items = [...byId.entries()].map(([id, slot]) => {
        const item = { url: `https://vkvideo.ru/video${id}` };
        const title = vkPickTitle(slot.texts);
        if (title) item.title = title;
        if (slot.img) item.thumbnail = slot.img;
        // the row's duration keeps rows telling apart even when several videos
        // share the exact same spam title
        const dur = durToSec(slot.dur);
        if (dur) item.duration = dur;
        return item;
      });
      const withThumb = items.find((i) => i.thumbnail);
      const result = {
        playlist: true,
        title: blocked ? '' : cleanVkTitle(titleText),
        thumbnail: withThumb ? withThumb.thumbnail : null,
        items,
      };
      if (!blocked) return result;
      if (!best || result.items.length > best.items.length) best = result; // keep as fallback
    }
    await new Promise((r) => setTimeout(r, 2500)); // let the challenge expire, try again
  }
  if (best) return best; // got links even though VK showed a challenge
  return { _blocked: true };
}

/**
 * Resolve a URL the app cannot hand straight to yt-dlp.
 * Returns null when the site is none of our business (yt-dlp handles it).
 */
async function resolve(url, cookieFile = null) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return null;
  }

  try {
    if (/(^|\.)(vkvideo\.ru|vk\.com|vkvideo\.com)$/.test(host) && /\/playlist\//i.test(url)) {
      return await vkPlaylist(url, cookieFile);
    }
    // unknown host: leave it to yt-dlp
    return null;
  } catch (e) {
    return { _debug: 'exception: ' + (e && e.message) };
  }
}

/** Last resort: yt-dlp could not read the page — look for a direct media URL. */
async function fallbackResolve(url) {
  try {
    const html = await grab(url, new URL(url).origin + '/');
    if (!html) return null;
    const urls = mediaUrls(html, url).filter((u) => !/preview|trailer|screenshot/i.test(u));
    if (!urls.length) return null;
    return {
      mediaUrl: urls[0],
      title: meta(html, 'og:title') || meta(html, 'twitter:title') || null,
      thumbnail: meta(html, 'og:image') || null,
      referer: new URL(url).origin + '/',
      fallback: true,
    };
  } catch (_) {
    return null;
  }
}

module.exports = { resolve, fallbackResolve, mediaUrls, meta };
