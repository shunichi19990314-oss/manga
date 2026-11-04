import express from 'express';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';

const PORT = Number(process.env.PORT || 10000);
const UA =
  process.env.UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ALLOW = (process.env.UPSTREAM_ALLOW || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 20000);
const MAX_HTML = 8 * 1024 * 1024;
const CONCURRENCY = 8;

/* ---------------------------------------------------------------- サイト一覧 */

const SITES = [
  {
    group: '本編 raw',
    items: [
      { name: 'MiuRaw', url: 'https://miuraw.net/manga/陰の実力者になりたくて！-raw-free', note: '第86話台まで更新。話数分割が細かく最新話を追いやすい' },
      { name: 'Mangaruu', url: 'https://mangaruu.com/m/kage-no-jitsuryoku-sha-ni-nari-taku-te-3322', note: '話数の進行が最も早い' },
      { name: 'Soraraw', url: 'https://soraraw.com/manga/kage-no-jitsuryoku-sha-ni-nari-taku-te-6916', note: '登録不要・スマホ最適化' },
      { name: 'Soraraw (mirror)', url: 'https://soraraw.net/manga/陰の実力者になりたくて-raw', note: '上記のミラー' },
      { name: 'KLManga', url: 'https://klmanga.cloud/manga/陰の実力者になりたくて-raw', note: 'ミラー系' },
      { name: 'Dokiraw', url: 'https://dokiraw.icu/manga/yin-noshi-li-zhe-ninaritakute', note: '序盤から全話' },
      { name: 'RawMe', url: 'https://rawme.net/manga/yin-noshi-li-zhe-ninaritakute', note: 'ミラー系' },
      { name: 'RawMiu', url: 'https://rawmiu.com/manga/陰の実力者になりたくて！-raw-free', note: 'ミラー系' },
      { name: 'RawZo', url: 'https://rawzo.top/manga/陰の実力者になりたくて！-raw-free', note: 'ミラー系' },
      { name: 'MangaBubu', url: 'https://mangabubu.co/manga/陰の実力者になりたくて！-raw-free/', note: 'ミラー系' },
      { name: 'Manaraw', url: 'https://manaraw.art/manga/yin-noshi-li-zhe-ninaritakute', note: 'ミラー系' },
      { name: 'MangaRw', url: 'https://mangarw.com/read?id=41860', note: '縦スクロール型ビューア' },
      { name: 'JManga', url: 'https://jmanga.care/read/陰の実力者になりたくて！-raw/', note: 'ミラー系' },
    ],
  },
  {
    group: '保存・スピンオフ',
    items: [
      { name: 'DL-Raw', url: 'https://dl-raw.ac/陰の実力者になりたくて！-raw/', note: '単話ではなく巻単位の RAR 一括DL（1〜18巻）' },
      { name: 'MangaRaw.co.uk', url: 'https://mangaraw.co.uk/manga/8931', note: 'スピンオフ『しゃどーがいでん』のみ' },
    ],
  },
  {
    group: '公式',
    items: [
      { name: 'ニコニコ漫画 (ガンマぷらす)', url: 'https://manga.nicovideo.jp/official/gammaplus', note: '連載元。無料公開分あり／SPA のため崩れやすい' },
      { name: 'ピッコマ', url: 'https://piccoma.com/web/series/product/list/1605/K', note: '正規・試し読み' },
      { name: 'めちゃコミック', url: 'https://mechacomic.jp/books/139437', note: '正規・試し読み' },
      { name: 'BOOK☆WALKER', url: 'https://bookwalker.jp/series/212232/', note: '正規・試し読み' },
    ],
  },
];

const ALL_SITES = SITES.flatMap((g) => g.items);

/* ---------------------------------------------------------------- 広告判定 */

const AD_HOSTS =
  /(doubleclick|googlesyndication|google-analytics|googletagmanager|adservice|amazon-adsystem|popads|popcash|propellerads|profitablecpmrate|onclickads|adsterra|highperformanceformat|exoclick|juicyads|trafficjunky|mgid|taboola|outbrain|zergnet|revcontent|pushnami|onesignal|histats|mc\.yandex|cloudflareinsights|facebook\.net|scorecardresearch|quantserve|criteo|pubmatic|rubiconproject|openx|smartadserver|adnxs|casalemedia|33across|sharethrough|triplelift|smaato|mopub|unityads|applovin|ironsrc|chartboost|inmobi|tapjoy|fyber|supersonicads|adtng|tsyndicate|bngprm|pemsrv|push-sdk|senzapush)/i;

const AD_INLINE =
  /adsbygoogle|atOptions|popunder|popUnder|exoclick|adsterra|aads\.|adcash|window\.open\s*\(|_pop\s*=|adblock/i;

const BINARY = /^(image|font|video|audio)\/|^application\/(octet-stream|pdf|zip|rar)/i;

const ATTRS = [
  'src', 'href', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy',
  'data-echo', 'data-url', 'data-href', 'data-img', 'poster', 'action',
  'data-srcset', 'srcset',
];

/* ---------------------------------------------------------------- ユーティリティ */

const enc = (u) => Buffer.from(u, 'utf8').toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString('utf8');
const prox = (u) => `/p/${enc(u)}`;

const jar = new CookieJar();
const refMap = new Map();
const remember = (u, r) => {
  refMap.set(u, r);
  if (refMap.size > 5000) refMap.delete(refMap.keys().next().value);
};

let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function isPrivate(host) {
  if (/^(localhost|127\.|0\.0\.0\.0)/.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host === '[::1]') return true;
  return false;
}

const absolutize = (v, base) => {
  try {
    return new URL(v, base).href;
  } catch {
    return null;
  }
};

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

function rewriteSrcset(v, base) {
  return v
    .split(',')
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      const abs = absolutize(bits[0], base);
      return abs ? [prox(abs), ...bits.slice(1)].join(' ') : part;
    })
    .join(', ');
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------------- 注入物 */

const SHIM = `<script>(function(){
  var add = window.addEventListener;
  window.open = function(){ return null; };
  window.addEventListener = function(t, f, o){
    if (String(t).toLowerCase() === 'beforeunload') {
      return add.call(window, t, function(e){ if (e) e.returnValue = ''; }, o);
    }
    return add.call(window, t, f, o);
  };
  try { window.onbeforeunload = null; } catch(e){}
  document.addEventListener('DOMContentLoaded', function(){
    try { window.onbeforeunload = null; } catch(e){}
    document.querySelectorAll('a[target]').forEach(function(a){
      if (a.getAttribute('target') !== '_self') a.removeAttribute('target');
    });
  });
})();</script>`;

const CLEAN_CSS = `<style>
  ins.adsbygoogle, .adsbygoogle, [id^="div-gpt-ad"], [id^="google_ads"],
  [class*="ad-slot"], [class*="adslot"], [id*="ad-slot"], [class*="-ads"],
  .ad-container, .ads-container, .ad-wrapper, .ad-banner, .banner-ad,
  .adsbox, .ad-box, .ad-area, .adunit, .ad-unit,
  [class*="popunder"], [class*="pop-under"], .overlay-ad, [class*="interstitial"],
  .floating-ad, .sticky-ad,
  #ad, #ads, #ad-top, #ad-bottom, #banner-ad { display: none !important; }

  html, body { overflow-x: auto !important; max-width: 100% !important; }
  img, video, canvas { max-width: 100% !important; height: auto !important; }
  body { -webkit-text-size-adjust: 100%; }

  #__vp_bar {
    position: fixed; top: 8px; right: 8px; z-index: 2147483600;
    display: flex; gap: 6px; font: 12px/1.2 system-ui, sans-serif;
    padding: 6px; border-radius: 10px;
    background: rgba(20,20,24,.86); color: #fff;
    box-shadow: 0 4px 16px rgba(0,0,0,.4); backdrop-filter: blur(6px);
  }
  #__vp_bar button, #__vp_bar a {
    all: unset; cursor: pointer; padding: 5px 9px; border-radius: 7px;
    background: #33343c; color: #fff; font: 12px system-ui, sans-serif;
  }
  #__vp_bar button:active, #__vp_bar a:active { background: #4a4b57; }
  #__vp_bar .x { background: #5a2330; }
  #__vp_bar .list { background: #2c4a5e; }
</style>`;

const TOOLBAR = `<div id="__vp_bar">
  <button id="__vp_kill" title="オーバーレイを除去">掃除</button>
  <a class="list" href="/" title="サイト一覧へ">一覧</a>
  <a id="__vp_orig" href="#" target="_blank" rel="noreferrer">元サイト</a>
  <button class="x" id="__vp_x" title="閉じる">×</button>
</div>`;

const TOOLBAR_JS = `<script>(function(){
  var bar = document.getElementById('__vp_bar');
  if (!bar) return;
  document.getElementById('__vp_orig').href = document.documentElement.dataset.orig || '#';
  document.getElementById('__vp_x').onclick = function(){ bar.remove(); };
  function kill(aggressive){
    var vw = innerWidth, vh = innerHeight;
    document.querySelectorAll('body *').forEach(function(el){
      if (el.closest('#__vp_bar')) return;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return;
      var r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) return;
      var area = (r.width * r.height) / (vw * vh);
      var z = parseInt(cs.zIndex, 10) || 0;
      if (aggressive ? (area > 0.03 && z >= 1) : (area > 0.06 && z >= 500)) {
        el.style.setProperty('display', 'none', 'important');
      }
    });
    document.documentElement.style.setProperty('overflow', 'auto', 'important');
    document.body.style.setProperty('overflow', 'auto', 'important');
  }
  document.getElementById('__vp_kill').onclick = function(){ kill(true); };
  setTimeout(function(){ kill(false); }, 1200);
})();</script>`;

/* ---------------------------------------------------------------- 書き換え */

function rewriteHtml(html, pageUrl) {
  const pageOrigin = new URL(pageUrl).origin;
  const $ = cheerio.load(html);

  $('base').remove();
  $('head').prepend(`<base href="${pageUrl}">`);
  $('meta[http-equiv="refresh" i]').remove();
  $('meta[http-equiv="Content-Security-Policy" i]').remove();
  $('link[rel="preconnect" i], link[rel="dns-prefetch" i], link[rel="preload" i]').remove();

  $('script').each((_, el) => {
    const node = $(el);
    const src = node.attr('src');
    if (src) {
      const abs = absolutize(src, pageUrl);
      if (!abs) return node.remove();
      if (AD_HOSTS.test(hostOf(abs))) return node.remove();
      remember(abs, pageOrigin);
      return node.attr('src', prox(abs));
    }
    const text = node.html() || '';
    if (AD_HOSTS.test(text) || AD_INLINE.test(text)) return node.remove();
    if (text.includes('document.write') && /ad|ads|banner/i.test(text)) return node.remove();
  });

  $('iframe').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    const abs = absolutize(src, pageUrl);
    if (!abs || AD_HOSTS.test(hostOf(abs))) return $(el).remove();
    remember(abs, pageOrigin);
    $(el).attr('src', prox(abs));
  });

  $('*').each((_, el) => {
    const node = $(el);
    for (const attr of ATTRS) {
      const v = node.attr(attr);
      if (!v) continue;
      if (v.startsWith('#') || v.startsWith('javascript:') || v.startsWith('data:')) continue;
      if (attr === 'srcset' || attr === 'data-srcset') {
        node.attr(attr, rewriteSrcset(v, pageUrl));
        continue;
      }
      const abs = absolutize(v, pageUrl);
      if (!abs || !/^https?:/.test(abs)) continue;
      remember(abs, pageOrigin);
      node.attr(attr, prox(abs));
    }
  });

  $('a[target="_blank"]').attr('target', '_self');
  $('html').attr('data-orig', pageUrl);
  $('head').prepend(SHIM);
  $('head').append(CLEAN_CSS);
  $('body').append(TOOLBAR);
  $('body').append(TOOLBAR_JS);

  return $.html();
}

/* ---------------------------------------------------------------- 本体 */

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/healthz', (_, res) => res.type('text').send('ok'));

app.get('/sites.json', (_, res) => res.json(SITES));

app.get('/p/:token', async (req, res) => {
  let target;
  try {
    target = dec(req.params.token);
  } catch {
    return res.status(400).type('text').send('bad token');
  }

  let u;
  try {
    u = new URL(target);
  } catch {
    return res.status(400).type('text').send('bad url');
  }

  if (!/^https?:$/.test(u.protocol)) return res.status(400).type('text').send('bad protocol');
  if (isPrivate(u.hostname)) return res.status(403).type('text').send('private host');
  if (ALLOW.length && !ALLOW.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
    return res.status(403).type('text').send('host not allowed');
  }

  const referer = refMap.get(target) ? refMap.get(target) + '/' : u.origin + '/';

  let upstream;
  try {
    upstream = await withSlot(() =>
      fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          'user-agent': UA,
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'ja,en-US;q=0.8,en;q=0.6',
          'accept-encoding': 'gzip, deflate, br',
          referer,
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'cross-site',
          cookie: await jar.getCookieString(target).catch(() => ''),
        },
      })
    );
  } catch (err) {
    return res
      .status(502)
      .type('html')
      .send(noticePage('上流の取得に失敗しました', String(err?.message || err), target));
  }

  for (const c of upstream.headers.getSetCookie?.() || []) {
    await jar.setCookie(c, target).catch(() => {});
  }

  const ct = upstream.headers.get('content-type') || '';
  const looksBinary =
    BINARY.test(ct) ||
    /\.(png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|mp4|webm|ico)(\?|$)/i.test(u.pathname);

  if (looksBinary) {
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set('content-type', ct || 'application/octet-stream');
    res.set('cache-control', 'public, max-age=86400');
    res.set('access-control-allow-origin', '*');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  }

  if (upstream.status === 403 || upstream.status === 503) {
    return res
      .status(upstream.status)
      .type('html')
      .send(noticePage('上流がアクセスを拒否しました', 'Cloudflare 等の bot 判定の可能性があります。', target));
  }

  if (!upstream.ok) return res.status(upstream.status).type('text').send(`upstream ${upstream.status}`);

  let html = await upstream.text();
  if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);

  res.set('content-type', 'text/html; charset=utf-8');
  res.set('cache-control', 'no-store');
  res.set('x-frame-options', 'ALLOWALL');
  res.send(rewriteHtml(html, upstream.url || target));
});

/* ---------------------------------------------------------------- ページ */

function noticePage(title, detail, url) {
  const cards = ALL_SITES.map(
    (s) =>
      `<a class="c" href="${prox(s.url)}"><b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.note)}</span></a>`
  ).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>body{font:15px/1.7 system-ui,sans-serif;max-width:720px;margin:8vh auto;padding:0 18px;background:#111;color:#eee}
  h1{font-size:19px}.muted{color:#999}.c{display:block;padding:10px 12px;margin:6px 0;border-radius:9px;background:#1b1b20;color:#eee;text-decoration:none}
  .c b{display:block;font-size:14px}.c span{font-size:12px;color:#888}a{color:#6cf}</style>
  <h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(detail)}</p>
  <p><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">元サイトで直接開く →</a> ／ <a href="/">一覧へ戻る</a></p>
  <p class="muted" style="margin-top:22px">別のサイトで試す:</p>${cards}`;
}

app.get('/', (req, res) => {
  const origin = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const bm = `javascript:(function(){var u=location.href;var b=btoa(unescape(encodeURIComponent(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');location.href='${origin}/p/'+b;})()`;

  const groups = SITES.map((g) => {
    const cards = g.items
      .map(
        (s) => `<a class="card" data-k="${escapeHtml((s.name + ' ' + s.note).toLowerCase())}" href="${prox(s.url)}">
        <b>${escapeHtml(s.name)}</b><span>${escapeHtml(hostOf(s.url))}</span><em>${escapeHtml(s.note)}</em></a>`
      )
      .join('');
    return `<h2>${escapeHtml(g.group)}</h2><div class="grid">${cards}</div>`;
  }).join('');

  res.set('cache-control', 'no-store');
  res.type('html').send(`<!doctype html><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>raw reader — サイト選択</title>
  <style>
    :root{color-scheme:dark}
    body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:28px 18px 60px;background:#0e0e11;color:#eee}
    h1{font-size:19px;margin:0 0 6px}
    .lead{color:#8b8b96;font-size:13px;margin:0 0 18px}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#7f8798;margin:26px 0 8px}
    .grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
    .card{display:block;padding:11px 13px;border-radius:10px;background:#181820;border:1px solid #23232d;text-decoration:none;color:#eee}
    .card:hover{background:#1e1e28;border-color:#33374a}
    .card b{display:block;font-size:14px}
    .card span{font-size:11px;color:#6b7280;word-break:break-all}
    .card em{display:block;font-size:11.5px;color:#9aa0ad;font-style:normal;margin-top:4px}
    .card.hide{display:none}
    #q{width:100%;padding:11px 13px;border-radius:9px;border:1px solid #2a2a35;background:#15151c;color:#eee;font-size:14px;box-sizing:border-box}
    .tools{margin:22px 0 4px;padding-top:18px;border-top:1px solid #20202a}
    .tools input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #2a2a35;background:#15151c;color:#eee;box-sizing:border-box}
    button{padding:10px 16px;border-radius:8px;border:0;background:#33517a;color:#fff;font-size:14px;cursor:pointer;margin-top:8px}
    code{background:#1b1b24;padding:2px 6px;border-radius:4px;font-size:11px;word-break:break-all;display:inline-block}
    a{color:#6cf}
    .foot{color:#666;font-size:11.5px;margin-top:26px;line-height:1.7}
  </style>
  <h1>raw reader</h1>
  <p class="lead">サイトを選ぶと、広告・ポップアップ・自動リダイレクトを除去して開きます。</p>
  <input id="q" placeholder="サイト名で絞り込み（例: miu / dl / 公式）" autocomplete="off">
  ${groups}
  <div class="tools">
    <h2 style="margin-top:0">URL を直接開く</h2>
    <input id="u" placeholder="https://example.com/manga/...">
    <button id="go">開く</button>
    <p class="foot">ブックマークレット（サイト上で実行すると現在のページを経由して開きます）:<br><code>${escapeHtml(bm)}</code></p>
    <p class="foot">raw サイトは非公式のため、ドメインが頻繁に変わります。開けない場合は一覧の別サイトか「元サイト」から辿ってください。</p>
  </div>
  <script>
    var q = document.getElementById('q');
    q.addEventListener('input', function(){
      var v = q.value.trim().toLowerCase();
      document.querySelectorAll('.card').forEach(function(c){
        c.classList.toggle('hide', v !== '' && c.dataset.k.indexOf(v) === -1);
      });
      document.querySelectorAll('.grid').forEach(function(g){
        var any = g.querySelector('.card:not(.hide)');
        g.previousElementSibling.style.display = any ? '' : 'none';
      });
    });
    var u = document.getElementById('u');
    document.getElementById('go').onclick = function(){
      var v = u.value.trim();
      if (!v) return;
      if (!/^https?:\\/\\//.test(v)) v = 'https://' + v;
      var b = btoa(unescape(encodeURIComponent(v))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      location.href = '/p/' + b;
    };
    u.addEventListener('keydown', function(e){ if (e.key === 'Enter') document.getElementById('go').click(); });
  </script>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`listening on ${PORT}`));