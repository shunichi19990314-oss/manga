import express from 'express';
import * as cheerio from 'cheerio';

const TARGET_ORIGIN = (process.env.TARGET_ORIGIN || 'https://miuraw.net').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 10000);
const PREFIX = '/_u/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.raw({ type: () => true, limit: '30mb' }));

/* ---------- URL helpers ---------- */

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
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
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
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

/* ---------- rewriters ---------- */

const URL_ATTRS = [
  'href', 'src', 'action', 'poster', 'data-src',
  'data-lazy-src', 'data-original', 'data-bg', 'data-srcset',
];

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      if (/^(data:|blob:|#)/i.test(u)) return m;
      return `url(${q}${toProxy(abs(u, base))}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => `@import ${q}${toProxy(abs(u, base))}${q}`);
}

function rewriteSrcset(v, base) {
  return v
    .split(',')
    .map((part) => {
      const t = part.trim();
      if (!t) return '';
      const seg = t.split(/\s+/);
      seg[0] = toProxy(abs(seg[0], base));
      return seg.join(' ');
    })
    .filter(Boolean)
    .join(', ');
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
  XMLHttpRequest.prototype.open=function(m,u){
    arguments[1]=e(u); return xo.apply(this,arguments);
  };
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
        if (name === 'data-srcset') attrs[name] = rewriteSrcset(val, pageUrl);
        else attrs[name] = toProxy(abs(val, pageUrl));
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
    (el.children || []).forEach((c) => {
      if (c.type === 'text') c.data = rewriteCss(c.data, pageUrl);
    });
  });

  // relative URL 解決の基準点をプロキシ側に固定する
  $('base').remove();
  const dir = toProxy(new URL('.', pageUrl).toString());
  $('head').prepend(`<base href="${dir}">`);
  $('head').prepend(SHIM);

  return $.html();
}

function rewriteJs(js) {
  const esc = TARGET_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return js.replace(new RegExp(`(['"\`])${esc}([^'"\`\\s)]*)`, 'g'), (m, q, rest) =>
    q + toProxy(TARGET_ORIGIN + rest)
  );
}

/* ---------- proxy handler ---------- */

app.get('/__health', (_req, res) => res.type('text').send('ok'));

app.use(async (req, res) => {
  let targetUrl;
  try {
    if (req.url === '/' || req.url.startsWith('/?')) {
      return res.redirect(302, toProxy(TARGET_ORIGIN + '/'));
    }
    targetUrl = req.url.startsWith(PREFIX) ? fromProxyPath(req.url) : TARGET_ORIGIN + req.url;
  } catch {
    return res.status(400).type('text').send('Bad proxy URL');
  }
  if (isPrivate(targetUrl)) return res.status(403).type('text').send('private host');

  const headers = {
    'user-agent': UA,
    'accept': req.headers.accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
    'accept-language': req.headers['accept-language'] || 'ja,en-US;q=0.8,en;q=0.6',
    'accept-encoding': 'gzip, deflate, br',
    'referer': TARGET_ORIGIN + '/',
  };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['x-requested-with']) headers['x-requested-with'] = req.headers['x-requested-with'];

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'manual',
    });
  } catch (e) {
    return res.status(502).type('html').send(
      `<meta charset="utf-8"><h1>502</h1><p>取得できませんでした</p><pre>${String(e.message)}</pre>
       <p><a href="${toProxy(targetUrl)}">再読み込み</a></p>`
    );
  }

  // redirect
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get('location');
    if (loc) {
      res.set('cache-control', 'no-store');
      return res.redirect(upstream.status, toProxy(abs(loc, targetUrl)));
    }
  }

  // headers
  const ct = upstream.headers.get('content-type') || '';
  res.status(upstream.status);
  res.set('content-type', ct || 'application/octet-stream');
  const cc = upstream.headers.get('cache-control');
  res.set('cache-control', /text\/html/.test(ct) ? 'public, max-age=0, must-revalidate' : cc || 'public, max-age=86400');
  const sc = upstream.headers.getSetCookie?.() || [];
  for (const c of sc) {
    res.append('set-cookie', c.replace(/;\s*domain=[^;]+/i, '').replace(/;\s*samesite=none/i, '; SameSite=Lax'));
  }

  if (req.method === 'HEAD') return res.end();

  const buf = Buffer.from(await upstream.arrayBuffer());

  try {
    if (/text\/html/i.test(ct)) {
      return res.send(rewriteHtml(buf.toString('utf8'), targetUrl));
    }
    if (/text\/css/i.test(ct)) {
      return res.send(rewriteCss(buf.toString('utf8'), targetUrl));
    }
    if (/javascript|ecmascript/i.test(ct)) {
      return res.send(rewriteJs(buf.toString('utf8')));
    }
  } catch {
    /* 失敗したら素のバイト列を返す */
  }
  return res.send(buf);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`proxy for ${TARGET_ORIGIN} on :${PORT}`);
});