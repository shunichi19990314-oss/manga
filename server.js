// server.js
// mangaruu.com 用 広告除去プロキシ (Render / Node.js 20+)
import express from 'express';
import * as cheerio from 'cheerio';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 10000);
const UPSTREAM = new URL(process.env.UPSTREAM || 'https://mangaruu.com');
const BLOCK_ADS = process.env.BLOCK_ADS !== '0';   // BLOCK_ADS=0 で素通し
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 25000);

// 画像CDNは直リンクのまま（速い・広告なし）
const DIRECT_IMG_HOSTS = new Set(['i.mangaraw.lat', 'mangaraw.lat']);

// 広告・解析・ポップアップ系ホスト（必要に応じて追記）
const AD_HOST_RE =
  /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|googleadservices\.com|adservice\.google\.[a-z.]+|popads\.net|propellerads\.com|propellerclick\.com|adsterra\.com|highperformanceformat\.com|exoclick\.com|exosrv\.com|juicyads\.com|trafficjunky\.net|hilltopads\.net|onclickalgo\.com|popcash\.net|mgid\.com|taboola\.com|outbrain\.com|cloudflareinsights\.com|histats\.com|monetag\.com|clickadu\.com|a-ads\.com|cointraffic\.io|pushengage\.com|onesignal\.com|amazon-adsystem\.com|adnxs\.com|rubiconproject\.com|pubmatic\.com|criteo\.(?:com|net)|smartadserver\.com|zedo\.com|yieldmo\.com|teads\.tv|vidoomy\.com|adpushup\.com|ezoic\.net|nitropay\.com|venatusmedia\.com|profitableratecpm\.com|adstir\.com|fluct\.com|geniee\.co\.jp|i-mobile\.co\.jp|nend\.net|adingo\.jp|microad\.co\.jp|popin\.cc|logly\.co\.jp|zucks\.net|yandex\.(?:ru|net)|sape\.ru)/i;

// インラインスクリプト内の広告コード判定
const AD_INLINE_RE =
  /(adsbygoogle|atOptions|popads|exoclick|propellerads|adsterra|highperformanceformat|juicyads|hilltop|onclickalgo|popcash|monetag|clickadu|a-ads|cointraffic|pushengage|onesignal|histats|metrika|gtag\(|googletagmanager|doubleclick|ezoic|nitropay|window\.open\s*\(|openPopunder)/i;

// 実行時に消す広告枠っぽいセレクタ
const HIDE_CSS = `
  .adsbygoogle, .ad, .ads, .ad-box, .ad-wrap, .ad-wrapper, .ad-container,
  .ad-slot, .ad-area, .ad-banner, .ad-unit, .advert, .advertisement,
  [class*="advert"], [class*="adsense"], [class*="popunder"], [class*="popunder"],
  [id^="google_ads"], [id*="div-gpt-ad"], [data-ad-slot],
  [class*="banner-ad"], [class*="ad-banner"], [class*="ads-box"],
  [class*="sponsor"], [class*="promo-box"],
  iframe[src*="doubleclick"], iframe[src*="googlesyndication"],
  iframe[src*="adsterra"], iframe[src*="propellerads"] { display:none !important; }
`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.raw({ type: '*/*', limit: '20mb' }));

const isAdHost = (host) => BLOCK_ADS && AD_HOST_RE.test(host);

function localPath(u) {
  return u.pathname + u.search + u.hash;
}

function proxyUrl(absUrl) {
  return '/__ext?u=' + encodeURIComponent(absUrl);
}

function stub(res, url) {
  const p = url.pathname.toLowerCase();
  if (p.endsWith('.css')) {
    res.set('content-type', 'text/css; charset=utf-8');
  } else if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(p)) {
    res.set('content-type', 'image/gif');
    return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  } else {
    res.set('content-type', 'application/javascript; charset=utf-8');
  }
  res.set('cache-control', 'public, max-age=86400');
  res.end('/* blocked by proxy */');
}

/* ---------- クライアント側クリーナー ---------- */
const CLIENT_JS = String.raw`
(function () {
  var UP = 'https://mangaruu.com';

  /* 1. ポップアップ (window.open) を外部ホストなら握り潰す */
  var nativeOpen = window.open;
  window.open = function (url, name, feat) {
    try {
      if (!url) return nativeOpen.apply(window, arguments);
      var u = new URL(url, UP);
      if (u.hostname !== 'mangaruu.com' && !/mangaraw\.lat$/.test(u.hostname)) return null;
      return nativeOpen.call(window, u.href, name || '_blank', 'noopener');
    } catch (e) { return null; }
  };

  /* 2. 広告ブロッカー検出対策のダミー */
  window.canRunAds = true;
  window.adsbygoogle = window.adsbygoogle || [];
  window.adsbygoogle.push = function () {};
  window.adsbygoogle.loaded = true;

  /* 3. Service Worker 解除（キャッシュでプロキシを迂回されるのを防ぐ） */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(function (rs) { rs.forEach(function (r) { r.unregister(); }); })
      .catch(function () {});
  }

  /* 4. fetch / XHR の URL をプロキシ経由へ書き換え */
  var toProxy = function (url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin === location.origin) return url;
      if (u.hostname === 'mangaruu.com') return u.pathname + u.search;
      if (/mangaraw\.lat$/.test(u.hostname)) return url;
      return '/__ext?u=' + encodeURIComponent(u.href);
    } catch (e) { return url; }
  };
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (typeof input === 'string') input = toProxy(input);
      else if (input && input.url) input = new Request(toProxy(input.url), input);
      return nativeFetch.call(window, input, init);
    };
  }
  var nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    var args = [].slice.call(arguments);
    args[1] = toProxy(url);
    return nativeXhrOpen.apply(this, args);
  };

  /* 5. 広告ブロッカー検出モーダル / オーバーレイを消す */
  var PHRASES = ['広告ブロッカー', 'AdBlock', 'ad blocker', '広告をブロック'];
  function killNotice() {
    var nodes = document.querySelectorAll('div,section,aside,dialog');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset.pxKilled) continue;
      var t = (el.textContent || '').trim();
      if (t.length > 600) continue;
      var hit = false;
      for (var j = 0; j < PHRASES.length; j++) if (t.indexOf(PHRASES[j]) !== -1) { hit = true; break; }
      if (!hit) continue;
      var target = el, cs = getComputedStyle(el);
      while (target.parentElement && target.parentElement !== document.body) {
        if (getComputedStyle(target.parentElement).position === 'fixed') target = target.parentElement;
        else break;
      }
      var tcs = getComputedStyle(target);
      if (tcs.position === 'fixed' || tcs.position === 'sticky' ||
          /modal|popup|overlay|dialog|notice/i.test(target.className || '')) {
        target.dataset.pxKilled = '1';
        target.style.setProperty('display', 'none', 'important');
      }
    }
  }

  /* 6. 後から挿入される広告ノードも監視して削除 */
  var SEL = '.adsbygoogle,.ad,.ads,.ad-box,.ad-wrapper,.ad-container,.advert,[class*="advert"],[id*="div-gpt-ad"],[class*="popunder"],[class*="banner-ad"]';
  function sweep() {
    document.querySelectorAll(SEL).forEach(function (n) { n.style.setProperty('display', 'none', 'important'); });
    document.querySelectorAll('iframe').forEach(function (f) {
      var s = f.getAttribute('src') || '';
      if (/doubleclick|googlesyndication|adsterra|propellerads|exoclick|hilltopads/.test(s)) {
        f.style.setProperty('display', 'none', 'important');
      }
    });
    killNotice();
  }
  var timer = null;
  new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(function () { timer = null; sweep(); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', sweep);
  window.addEventListener('load', function () { sweep(); setTimeout(sweep, 1500); });
})();
`;

/* ---------- HTML 書き換え ---------- */
function rewriteHtml(html, base) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // CSP / X-Frame-Options 系メタを除去
  $('meta[http-equiv]').each((_, el) => {
    const eq = ($(el).attr('http-equiv') || '').toLowerCase();
    if (eq.includes('content-security') || eq.includes('x-frame')) $(el).remove();
  });

  // base を無効化
  $('base').attr('href', '/');

  // 外部ホストの資産は /__ext 経由、広告ホストは削除
  const handleAsset = (el, attr) => {
    const raw = el.attr(attr);
    if (!raw) return;
    let u;
    try { u = new URL(raw, base); } catch { return; }
    if (isAdHost(u.hostname)) return el.remove();
    if (u.hostname === UPSTREAM.hostname) return el.attr(attr, localPath(u));
    return el.attr(attr, proxyUrl(u.href));
  };

  // script
  $('script[src]').each((_, el) => {
    const $el = $(el);
    let u;
    try { u = new URL($el.attr('src'), base); } catch { return $el.remove(); }
    if (isAdHost(u.hostname)) return $el.remove();
    $el.removeAttr('integrity').removeAttr('crossorigin');
    $el.attr('src', u.hostname === UPSTREAM.hostname ? localPath(u) : proxyUrl(u.href));
  });

  // インライン広告スクリプト
  $('script:not([src])').each((_, el) => {
    const code = $(el).html() || '';
    if (AD_INLINE_RE.test(code)) $(el).remove();
  });

  // 広告 iframe
  $('iframe').each((_, el) => {
    const $el = $(el);
    let u;
    try { u = new URL($el.attr('src') || '', base); } catch { return; }
    if (isAdHost(u.hostname)) return $el.remove();
    $el.attr('src', u.hostname === UPSTREAM.hostname ? localPath(u) : proxyUrl(u.href));
  });

  // link (css / preload)
  $('link[href]').each((_, el) => {
    const $el = $(el);
    const rel = ($el.attr('rel') || '').toLowerCase();
    if (rel.includes('manifest') || rel.includes('alternate')) return;
    $el.removeAttr('integrity').removeAttr('crossorigin');
    handleAsset($el, 'href');
  });

  // 画像
  const IMG_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-echo', 'poster'];
  $('img,source,video').each((_, el) => {
    const $el = $(el);
    IMG_ATTRS.forEach((a) => {
      const raw = $el.attr(a);
      if (!raw) return;
      let u;
      try { u = new URL(raw, base); } catch { return; }
      if (DIRECT_IMG_HOSTS.has(u.hostname)) return $el.attr('referrerpolicy', 'no-referrer');
      if (u.hostname === UPSTREAM.hostname) return $el.attr(a, localPath(u));
      if (isAdHost(u.hostname)) return $el.remove();
      return $el.attr(a, proxyUrl(u.href));
    });
    const ss = $el.attr('srcset');
    if (ss) {
      $el.attr('srcset', ss.split(',').map((part) => {
        const [url, desc] = part.trim().split(/\s+/);
        try {
          const u = new URL(url, base);
          const out = u.hostname === UPSTREAM.hostname ? localPath(u) : proxyUrl(u.href);
          return desc ? out + ' ' + desc : out;
        } catch { return part.trim(); }
      }).join(', '));
    }
  });

  // リンク
  $('a[href]').each((_, el) => {
    const $el = $(el);
    let u;
    try { u = new URL($el.attr('href'), base); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.hostname === UPSTREAM.hostname) {
      $el.attr('href', localPath(u));
    } else {
      $el.attr('href', u.href).attr('target', '_blank').attr('rel', 'noopener noreferrer');
    }
  });

  // インライン onclick のポップアップを無効化
  $('[onclick]').each((_, el) => {
    const $el = $(el);
    const oc = $el.attr('onclick') || '';
    if (/window\.open|popunder/i.test(oc)) $el.removeAttr('onclick');
  });

  // 注入
  $('head').prepend('<style id="px-hide">' + HIDE_CSS + '</style>');
  $('body').prepend(
    '<div class="adsbygoogle ad adsbox" style="position:absolute;left:-9999px;top:0;width:300px;height:250px"></div>'
  );
  $('body').append('<script id="px-clean">' + CLIENT_JS + '</script>');

  return $.html();
}

/* ---------- 汎用リソースプロキシ ---------- */
async function handleExt(req, res) {
  const raw = req.query.u;
  if (!raw) return res.status(400).send('missing u');
  let u;
  try { u = new URL(raw); } catch { return res.status(400).send('bad u'); }
  if (isAdHost(u.hostname)) return stub(res, u);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(u, {
      headers: {
        'user-agent': UA,
        accept: req.headers.accept || '*/*',
        'accept-encoding': 'gzip, deflate, br',
        referer: UPSTREAM.origin + '/',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    res.status(r.status);
    res.set('content-type', r.headers.get('content-type') || 'application/octet-stream');
    res.set('cache-control', 'public, max-age=604800, immutable');
    res.set('access-control-allow-origin', '*');
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(502).send('upstream error');
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- メイン ---------- */
app.all('*', async (req, res) => {
  if (req.path === '/__health') return res.send('ok');
  if (req.path === '/__ext') return handleExt(req, res);

  let target;
  try {
    target = new URL(req.originalUrl, UPSTREAM);
  } catch {
    return res.status(400).send('bad url');
  }
  if (target.hostname !== UPSTREAM.hostname) {
    return res.redirect(302, target.href);
  }
  if (isAdHost(target.hostname)) return stub(res, target);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const headers = {
    'user-agent': UA,
    accept: req.headers.accept || 'text/html,application/xhtml+xml,*/*',
    'accept-language': 'ja,en-US;q=0.8,en;q=0.6',
    'accept-encoding': 'gzip, deflate, br',
    referer: UPSTREAM.origin + '/',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body?.length) {
    headers['content-type'] = req.headers['content-type'] || 'application/octet-stream';
  }

  try {
    const r = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'manual',
      signal: ctrl.signal,
    });

    // リダイレクトをプロキシ内に閉じ込める
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return res.sendStatus(r.status);
      let lu;
      try { lu = new URL(loc, target); } catch { return res.redirect(302, loc); }
      if (lu.hostname === UPSTREAM.hostname) return res.redirect(302, localPath(lu));
      if (isAdHost(lu.hostname)) return res.redirect(302, localPath(target));
      return res.redirect(302, proxyUrl(lu.href));
    }

    const ctype = r.headers.get('content-type') || '';
    res.status(r.status);

    if (ctype.includes('text/html')) {
      const html = await r.text();
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'no-cache');
      return res.send(rewriteHtml(html, target.href));
    }

    res.set('content-type', ctype || 'application/octet-stream');
    res.set('cache-control', 'public, max-age=86400');
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.status(502).send('<h1>502</h1><p>upstream error</p>');
  } finally {
    clearTimeout(timer);
  }
});

app.listen(PORT, () => console.log('proxy listening on ' + PORT));