import express from 'express';
import * as cheerio from 'cheerio';
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const TARGET_ORIGIN = (process.env.TARGET_ORIGIN || 'https://miuraw.net').replace(/\/+$/, '');
const FALLBACK_ORIGIN = (process.env.TARGET_FALLBACK || 'https://miuraw.com').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 10000);
const PREFIX = '/_u/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.raw({ type: () => true, limit: '30mb' }));

/* ---------- helpers ---------- */

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

function toProxy(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return u;
    return PREFIX + b64(x.origin) + x.pathname + x.search;
  } catch {
    return u;
  }
}

function abs(href, base) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function fromProxyPath(rawUrl) {
  const rest = rawUrl.slice(PREFIX.length);
  const i = rest.indexOf('/');
  const origin = unb64(i === -1 ? rest : rest.slice(0, i));
  const tail = i === -1 ? '/' : rest.slice(i);
  if (!/^https?:\/\//.test(origin)) throw new Error('bad origin');
  return origin + tail;
}

function isPrivate(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' ||
      /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch { return false; }
}

function browserHeaders(req, referer) {
  const h = {
    'user-agent': UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'referer': referer || TARGET_ORIGIN + '/',
  };
  if (req?.headers?.cookie) h.cookie = req.headers.cookie;
  if (req?.headers?.['content-type']) h['content-type'] = req.headers['content-type'];
  if (req?.headers?.['x-requested-with']) h['x-requested-with'] = req.headers['x-requested-with'];
  return h;
}

/* ---------- upstream (2 系統 + リトライ) ---------- */

function viaHttpModule(urlStr, { method, headers, body, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      headers: { ...headers, 'accept-encoding': 'identity' },
      family: 4,
      servername: u.hostname,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        via: 'https',
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

async function viaFetch(urlStr, { method, headers, body }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(urlStr, {
      method, headers, body,
      redirect: 'manual',
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) h['set-cookie'] = sc;
    return { status: r.status, headers: h, body: buf, via: 'fetch' };
  } finally {
    clearTimeout(t);
  }
}

async function getUpstream(urlStr, opts) {
  const errors = [];
  const attempts = [
    () => viaHttpModule(urlStr, opts),
    () => viaFetch(urlStr, opts),
    () => new Promise((r) => setTimeout(r, 600)).then(() => viaHttpModule(urlStr, opts)),
  ];
  for (const a of attempts) {
    try {
      return await a();
    } catch (e) {
      errors.push(`${e.code || e.name || 'ERR'}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

/* ---------- rewriters ---------- */

const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-srcset'];

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) =>
      /^(data:|blob:|#)/i.test(u) ? m : `url(${q}${toProxy(abs(u, base))}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => `@import ${q}${toProxy(abs(u, base))}${q}`);
}

function rewriteSrcset(v, base) {
  return v.split(',').map((part) => {
    const t = part.trim();
    if (!t) return '';
    const seg = t.split(/\s+/);
    seg[0] = toProxy(abs(seg[0], base));
    return seg.join(' ');
  }).filter(Boolean).join(', ');
}

const SHIM = `<script>(function(){
  var P=${JSON.stringify(PREFIX)};
  function e(u){
    try{
      var x=new URL(u,location.href);
      if(x.origin===location.origin) return u;
      var b=btoa(unescape(encodeURIComponent(x.origin)))
        .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      return P+b+x.pathname+x.search;
    }catch(err){ return u; }
  }
  var of=window.fetch;
  if(of) window.fetch=function(i,o){
    if(typeof i==='string') i=e(i);
    else if(i&&i.url) i=new Request(e(i.url),i);
    return of.call(this,i,o);
  };
  var xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){ arguments[1]=e(u); return xo.apply(this,arguments); };
  var sb=navigator.sendBeacon;
  if(sb) navigator.sendBeacon=function(u,d){ return sb.call(navigator,e(u),d); };
})();</script>`;

function rewriteHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  $('*').each((_, el) => {
    if (el.type !== 'tag') return;
    const attrs = el.attribs || {};
    for (const name of Object.keys(attrs)) {
      const val = attrs[name];
      if (!val) continue;
      if (URL_ATTRS.includes(name)) {
        attrs[name] = name === 'data-srcset' ? rewriteSrcset(val, pageUrl) : toProxy(abs(val, pageUrl));
      } else if (name === 'srcset') {
        attrs[name] = rewriteSrcset(val, pageUrl);
      } else if (name === 'style') {
        attrs[name] = rewriteCss(val, pageUrl);
      } else if (name === 'integrity') {
        delete attrs[name];
      }
    }
  });
  $('style').each((_, el) => {
    (el.children || []).forEach((c) => { if (c.type === 'text') c.data = rewriteCss(c.data, pageUrl); });
  });
  $('base').remove();
  $('head').prepend(`<base href="${toProxy(new URL('.', pageUrl).toString())}">`);
  $('head').prepend(SHIM);
  return $.html();
}

function rewriteJs(js) {
  const esc = TARGET_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return js.replace(new RegExp(`(['"\`])${esc}([^'"\`\\s)]*)`, 'g'), (m, q, rest) => q + toProxy(TARGET_ORIGIN + rest));
}

/* ---------- diagnostics ---------- */

app.get('/__health', (_req, res) => res.type('text').send('ok'));

app.get('/__diag', async (req, res) => {
  const out = [`node ${process.version}`, `target ${TARGET_ORIGIN}`];
  try {
    const addrs = await dns.promises.lookup(new URL(TARGET_ORIGIN).hostname, { all: true });
    out.push('dns: ' + addrs.map((a) => `${a.address}/${a.family}`).join(', '));
  } catch (e) {
    out.push('dns: FAIL ' + (e.code || e.message));
  }
  try {
    const r = await viaHttpModule(TARGET_ORIGIN + '/', { method: 'GET', headers: browserHeaders(null), timeout: 15000 });
    out.push(`https module: ${r.status} ${r.headers['content-type'] || ''} ${r.body.length}b`);
  } catch (e) {
    out.push('https module: FAIL ' + (e.code || e.message));
  }
  try {
    const r = await viaFetch(TARGET_ORIGIN + '/', { method: 'GET', headers: browserHeaders(null) });
    out.push(`fetch: ${r.status} ${r.body.length}b`);
  } catch (e) {
    out.push('fetch: FAIL ' + (e.cause?.code || e.message));
  }
  try {
    const r = await viaHttpModule(FALLBACK_ORIGIN + '/', { method: 'GET', headers: browserHeaders(null), timeout: 15000 });
    out.push(`fallback ${FALLBACK_ORIGIN}: ${r.status}`);
  } catch (e) {
    out.push(`fallback: FAIL ${e.code || e.message}`);
  }
  res.type('text/plain').send(out.join('\n'));
});

/* ---------- proxy ---------- */

app.use(async (req, res) => {
  let targetUrl;
  try {
    if (req.url === '/' || req.url.startsWith('/?')) return res.redirect(302, toProxy(TARGET_ORIGIN + '/'));
    targetUrl = req.url.startsWith(PREFIX) ? fromProxyPath(req.url) : TARGET_ORIGIN + req.url;
  } catch {
    return res.status(400).type('text').send('Bad proxy URL');
  }
  if (isPrivate(targetUrl)) return res.status(403).type('text').send('private host');

  const opts = {
    method: req.method,
    headers: browserHeaders(req),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
  };

  let up;
  try {
    up = await getUpstream(targetUrl, opts);
  } catch (e) {
    // 同一パスをミラードメインで再試行
    try {
      const mirror = targetUrl.replace(new URL(targetUrl).origin, FALLBACK_ORIGIN);
      up = await viaHttpModule(mirror, { ...opts, timeout: 15000 });
      targetUrl = mirror;
    } catch (e2) {
      return res.status(502).type('html').send(
        `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
         <body style="font:16px/1.7 system-ui;padding:24px">
         <h1 style="margin:0 0 8px">502 取得できません</h1>
         <p style="color:#555">上流サーバーに届きませんでした。</p>
         <pre style="background:#f4f4f4;padding:12px;white-space:pre-wrap">${String(e.message)}</pre>
         <p><a href="${toProxy(targetUrl)}">再読み込み</a> / <a href="/__diag">診断</a></p></body>`
      );
    }
  }

  if (up.status >= 300 && up.status < 400) {
    const loc = up.headers.location;
    if (loc) {
      res.set('cache-control', 'no-store');
      return res.redirect(up.status, toProxy(abs(loc, targetUrl)));
    }
  }

  const ct = up.headers['content-type'] || 'application/octet-stream';
  res.status(up.status);
  res.set('content-type', ct);
  res.set('cache-control', /text\/html/i.test(ct) ? 'public, max-age=0, must-revalidate' : up.headers['cache-control'] || 'public, max-age=86400');
  const sc = up.headers['set-cookie'];
  for (const c of Array.isArray(sc) ? sc : sc ? [sc] : []) {
    res.append('set-cookie', c.replace(/;\s*domain=[^;]+/i, '').replace(/;\s*samesite=none/i, '; SameSite=Lax'));
  }

  if (req.method === 'HEAD') return res.end();

  try {
    if (/text\/html/i.test(ct)) return res.send(rewriteHtml(up.body.toString('utf8'), targetUrl));
    if (/text\/css/i.test(ct)) return res.send(rewriteCss(up.body.toString('utf8'), targetUrl));
    if (/javascript|ecmascript/i.test(ct)) return res.send(rewriteJs(up.body.toString('utf8')));
  } catch { /* fallthrough */ }
  return res.send(up.body);
});

app.listen(PORT, '0.0.0.0', () => console.log(`proxy ${TARGET_ORIGIN} on :${PORT}`));