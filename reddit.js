// reddit.js - Zero-dependency Reddit viewer module.
// Serves a /reddit section: feeds, sorts, search, comments, proxied media/video,
// device-local saves. No Reddit account features. Honest UA, throttled+cached upstream.
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

const UA = 'web:reddit-viewer:v1.0.0 (personal read-only viewer)';
const MIN_INTERVAL_MS = parseInt(process.env.REDDIT_MIN_INTERVAL_MS || '5000', 10);
const FEED_TTL_MS = parseInt(process.env.REDDIT_FEED_TTL_MS || '300000', 10);
const MEDIA_HOSTS = new Set([
  'i.redd.it','preview.redd.it','external-preview.redd.it','v.redd.it',
  'i.imgur.com','a.thumbs.redditmedia.com','b.thumbs.redditmedia.com',
  'thumbs.redditmedia.com','styles.redditmedia.com','www.redditstatic.com','reddit.com','www.reddit.com'
]);
const MEDIA_CT_OK = /^(image\/|video\/|audio\/|application\/(dash\+xml|x-mpegurl|vnd\.apple\.mpegurl|octet-stream)|video\/mp2t)/i;
const DISABLE_SAVES = process.env.RV_DISABLE_SAVES === '1';
const TRY_JSON = process.env.REDDIT_TRY_JSON === '1'; // .json is IP-blocked on many datacenters; RSS is the default route

const cache = new Map(); // key -> {t, ttl, status, ct, body:Buffer|string}
let lastReqAt = 0;
let cooldownUntil = 0; let cooldownSecs = 30;
let jsonOK; // undefined=unknown, true/false
let jsonProbeAt = 0;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function cached(key, fresh){
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t < e.ttl) return { ...e, stale:false };
  return fresh ? null : { ...e, stale:true };
}
function store(key, ttl, status, ct, body){
  if (cache.size > 400) cache.clear();
  cache.set(key, { t:Date.now(), ttl, status, ct, body });
}

function rawFetch(urlStr, redirects){
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch(e){ return reject(new Error('bad url')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('bad scheme'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, path: u.pathname + u.search, protocol: u.protocol,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 20000
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(rawFetch(new URL(res.headers.location, u).toString(), redirects+1));
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size > 60*1024*1024){ req.destroy(new Error('too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type']||'', headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Throttled, cached fetch of reddit listing/search/comments endpoints. Returns {status, ct, body, stale, cooldown}
async function redditGet(pathAndQuery){
  const key = 'r:' + pathAndQuery;
  const fresh = cached(key, true);
  if (fresh) return { ...fresh, body: fresh.body };
  const stale = cached(key, false);
  const now = Date.now();
  if (now < cooldownUntil) {
    if (stale) return { ...stale, stale:true, cooldown:true };
    const e = new Error('reddit-cooldown'); e.cooldown = true; e.retryIn = Math.ceil((cooldownUntil-now)/1000); throw e;
  }
  const wait = MIN_INTERVAL_MS - (now - lastReqAt);
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
  try {
    const r = await rawFetch('https://www.reddit.com' + pathAndQuery);
    if (r.status === 429) {
      cooldownSecs = Math.min(cooldownSecs*2, 300);
      cooldownUntil = Date.now() + cooldownSecs*1000;
      if (stale) return { ...stale, stale:true, cooldown:true };
      const e = new Error('reddit-429'); e.cooldown = true; e.retryIn = cooldownSecs; throw e;
    }
    cooldownSecs = 30;
    if (r.status === 200) store(key, FEED_TTL_MS, r.status, r.ct, r.body.toString('utf8'));
    else if (stale) return { ...stale, stale:true };
    return { status:r.status, ct:r.ct, body:r.body.toString('utf8'), stale:false };
  } catch (e) {
    if (stale) return { ...stale, stale:true };
    throw e;
  }
}

// ---------- parsing ----------
function unesc(s){ return String(s||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&apos;/g,"'").replace(/&#32;/g,' ').replace(/&amp;/g,'&'); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function mediaType(url){
  if (!url) return 'self';
  try {
    const h = new URL(url).hostname;
    if (h === 'v.redd.it') return 'video';
    if (h === 'i.redd.it' || h === 'i.imgur.com') return 'image';
    if (h === 'www.reddit.com' && /\/gallery\//.test(url)) return 'gallery';
    return 'link';
  } catch(e){ return 'link'; }
}

function parseRssFeed(xml){
  const posts = [];
  const entries = xml.split('<entry>').slice(1);
  for (const raw of entries) {
    const e = raw.split('</entry>')[0];
    const g = (re) => { const m = e.match(re); return m ? m[1] : ''; };
    const title = unesc(g(/<title>([\s\S]*?)<\/title>/));
    const permalink = unesc(g(/<link href="([^"]+)"/));
    const author = g(/<name>([^<]+)<\/name>/).replace(/^\/u\//,'');
    const subreddit = g(/<category term="([^"]+)"/);
    const published = g(/<published>([^<]+)<\/published>/) || g(/<updated>([^<]+)<\/updated>/);
    const thumb = unesc(g(/<media:thumbnail url="([^"]+)"/));
    const content = unesc(g(/<content type="html">([\s\S]*?)<\/content>/));
    let mediaUrl = '';
    const lm = content.match(/<span><a href="([^"]+)">\[link\]<\/a><\/span>/);
    if (lm) mediaUrl = lm[1];
    if (!mediaUrl){
      const im = content.match(/<a href="(https?:\/\/(?:i\.redd\.it|i\.imgur\.com|v\.redd\.it)[^"]*)"/);
      if (im) mediaUrl = im[1];
    }
    const idm = permalink.match(/\/comments\/([a-z0-9]+)\//i);
    const id = idm ? idm[1] : '';
    let mt = mediaType(mediaUrl);
    if (mediaUrl && /\/comments\//.test(mediaUrl)) { mt = 'self'; mediaUrl = ''; }
    const selfM = content.match(/<div class="md">([\s\S]*?)<\/div>/);
    posts.push({ id, title, permalink, author, subreddit, published, thumb, mediaUrl, mediaType: mt, selftextHtml: selfM ? sanitizeHtml(selfM[1]) : '', source:'rss' });
  }
  return posts;
}

function parseJsonListing(j){
  const posts = [];
  const kids = j && j.data && j.data.children || [];
  for (const k of kids) {
    const d = k.data || {};
    let mediaUrl = d.url_overridden_by_dest || d.url || '';
    let mt = mediaType(mediaUrl);
    if (d.is_video && d.media && d.media.reddit_video) mt = 'video';
    if (d.is_gallery) mt = 'gallery';
    const thumb = (d.thumbnail && /^https?:/.test(d.thumbnail)) ? d.thumbnail : '';
    posts.push({
      id: d.id || '', title: d.title || '', permalink: 'https://www.reddit.com' + (d.permalink||''),
      author: d.author || '', subreddit: d.subreddit || '', published: d.created_utc ? new Date(d.created_utc*1000).toISOString() : '',
      thumb, mediaUrl: mt==='video' ? ('https://v.redd.it/' + d.id) : mediaUrl, mediaType: mt,
      selftextHtml: d.selftext_html ? unesc(d.selftext_html) : '',
      score: (typeof d.score === 'number') ? d.score : undefined,
      numComments: (typeof d.num_comments === 'number') ? d.num_comments : undefined,
      source:'json'
    });
  }
  return posts;
}

function sanitizeHtml(html){
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<!-- SC_(?:OFF|ON) -->/g, '');
  s = s.replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/\son\w+="[^"]*"/gi, '').replace(/\son\w+='[^']*'/gi, '');
  s = s.replace(/<a\s+([^>]*?)href="([^"]*)"([^>]*)>/gi, (m, pre, href, post) => {
    const h = unesc(href);
    let nh = h;
    try {
      const u = new URL(h);
      if (u.hostname === 'www.reddit.com' || u.hostname === 'old.reddit.com' || u.hostname === 'reddit.com'){
        const cm = u.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)(\/[^/]*)?(\/([a-z0-9]+))?/i);
        const rm = u.pathname.match(/^\/r\/([^/]+)\/?$/);
        const um = u.pathname.match(/^\/(?:user|u)\/([^/]+)/);
        if (cm) nh = '/reddit/comments/' + cm[2] + '/';
        else if (rm) nh = '/reddit/r/' + rm[1];
        else if (um) nh = '/reddit/user/' + um[1];
        else if (u.pathname.startsWith('/gallery/')) nh = '/proxy/' + encodeURIComponent(h);
        else nh = '/proxy/' + encodeURIComponent(h);
      } else if (MEDIA_HOSTS.has(u.hostname)) {
        nh = '/reddit/media?u=' + encodeURIComponent(h);
      } else {
        return '<a href="' + esc(h) + '" target="_blank" rel="noopener noreferrer">';
      }
    } catch(e){}
    return '<a href="' + esc(nh) + '">';
  });
  s = s.replace(/<img\s+([^>]*?)src="([^"]*)"([^>]*)>/gi, (m, pre, src, post) => {
    return '<img loading="lazy" src="/reddit/media?u=' + encodeURIComponent(unesc(src)) + '" alt="">';
  });
  return s;
}

function parseCommentsRss(xml){
  const entries = xml.split('<entry>').slice(1);
  const comments = [];
  let post = null;
  for (let i=0;i<entries.length;i++){
    const e = entries[i].split('</entry>')[0];
    const g = (re) => { const m = e.match(re); return m ? m[1] : ''; };
    const title = unesc(g(/<title>([\s\S]*?)<\/title>/));
    const link = unesc(g(/<link href="([^"]+)"/));
    const author = g(/<name>([^<]+)<\/name>/).replace(/^\/u\//,'');
    const published = g(/<published>([^<]+)<\/published>/) || g(/<updated>([^<]+)<\/updated>/);
    const content = unesc(g(/<content type="html">([\s\S]*?)<\/content>/));
    const chtml = sanitizeHtml(content);
    if (i === 0 && /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+\/[^/]*\/?$/i.test(link) && !/^\/u\//.test(title)){
      // first entry is the post itself; selftext lives in the div.md, not the submitted-by table
      const lm = content.match(/<span><a href="([^"]+)">\[link\]<\/a><\/span>/);
      let mediaUrl = lm ? lm[1] : '';
      let mt = mediaType(mediaUrl);
      if (mediaUrl && /\/comments\//.test(mediaUrl)) { mt = 'self'; mediaUrl = ''; }
      const mdM = content.match(/<div class="md">([\s\S]*?)<\/div>/);
      post = { title, permalink: link, author, published, selftextHtml: mdM ? sanitizeHtml(mdM[1]) : '', mediaUrl, mediaType: mt, source:'rss' };
      continue;
    }
    const cm = link.match(/\/comments\/([a-z0-9]+)\/[^/]*\/([a-z0-9]+)\/?$/i);
    comments.push({ id: cm ? cm[2] : '', postId: cm ? cm[1] : '', author, published, html: chtml });
  }
  return { post, comments };
}

// ---------- upstream data ----------
async function fetchFeed(sub, sort, t, limit){
  limit = limit || 25;
  const sortPath = sort && sort !== 'hot' ? '/' + sort : '';
  const base = sub ? '/r/' + sub + sortPath : (sort && sort!=='hot' ? '/' + sort : '');
  const qs = '?limit=' + limit + (t ? '&t=' + t : '');
  if (TRY_JSON && jsonOK === undefined && Date.now() > jsonProbeAt) {
    jsonProbeAt = Date.now() + 3600000;
    try {
      const r = await redditGet(base + '.json' + qs + '&raw_json=1');
      if (r.status === 200) { jsonOK = true; return { posts: parseJsonListing(JSON.parse(r.body)), stale:r.stale, cooldown:r.cooldown, mode:'json' }; }
      jsonOK = false;
    } catch(e){ jsonOK = false; if (e.cooldown) throw e; }
  }
  if (TRY_JSON && jsonOK) {
    const r = await redditGet(base + '.json' + qs + '&raw_json=1');
    if (r.status === 200) return { posts: parseJsonListing(JSON.parse(r.body)), stale:r.stale, cooldown:r.cooldown, mode:'json' };
    jsonOK = false;
  }
  const r = await redditGet(base + '/.rss' + qs);
  if (r.status !== 200) { const e = new Error('reddit-' + r.status); e.status = r.status; throw e; }
  return { posts: parseRssFeed(r.body), stale:r.stale, cooldown:r.cooldown, mode:'rss' };
}

async function fetchSearch(q, sort, t, sub){
  const s = sort || 'relevance';
  const base = sub ? '/r/' + sub + '/search.rss' : '/search.rss';
  const qs = '?q=' + encodeURIComponent(q) + '&sort=' + s + '&t=' + (t||'all') + '&limit=25' + (sub ? '&restrict_sr=1' : '') + '&include_over_18=on';
  const r = await redditGet(base + qs);
  if (r.status !== 200) { const e = new Error('reddit-' + r.status); e.status = r.status; throw e; }
  return { posts: parseRssFeed(r.body), stale:r.stale, cooldown:r.cooldown, mode:'rss' };
}

async function fetchComments(id, sort){
  const qs = '?limit=200&sort=' + (sort || 'top');
  if (TRY_JSON && jsonOK) {
    try {
      const r = await redditGet('/comments/' + id + '/.json' + qs + '&raw_json=1');
      if (r.status === 200) {
        const arr = JSON.parse(r.body);
        const posts = parseJsonListing(arr[0]);
        const comments = [];
        const walk = (kids) => { for (const k of (kids||[])) { if (k.kind !== 't1') continue; comments.push({ id:k.data.id, author:k.data.author, published: k.data.created_utc?new Date(k.data.created_utc*1000).toISOString():'', html: sanitizeHtml(unesc(k.data.body_html||'')), score:k.data.score }); if (k.data.replies && k.data.replies.data) walk(k.data.replies.data.children); } };
        walk(arr[1] && arr[1].data && arr[1].data.children);
        return { post: posts[0] || null, comments, stale:r.stale, cooldown:r.cooldown, mode:'json' };
      }
      jsonOK = false;
    } catch(e){ jsonOK = false; if (e.cooldown) throw e; }
  }
  const r = await redditGet('/comments/' + id + '/.rss' + qs);
  if (r.status !== 200) { const e = new Error('reddit-' + r.status); e.status = r.status; throw e; }
  const pc = parseCommentsRss(r.body);
  return { ...pc, stale:r.stale, cooldown:r.cooldown, mode:'rss' };
}

async function fetchUserFeed(user, sort){
  const r = await redditGet('/user/' + encodeURIComponent(user) + '/.rss?limit=25' + (sort ? '&sort=' + sort : ''));
  if (r.status !== 200) { const e = new Error('reddit-' + r.status); e.status = r.status; throw e; }
  return { posts: parseRssFeed(r.body), stale:r.stale, cooldown:r.cooldown, mode:'rss' };
}

// ---------- rendering ----------
function layout(title, body, opts){
  opts = opts || {};
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  '<title>' + esc(title) + ' - Reddit Viewer</title>' +
  '<style>' + CSS + '</style></head><body>' +
  '<header><a class="brand" href="/reddit/">Reddit Viewer</a>' +
  '<form class="search" action="/reddit/search" method="get"><input type="search" name="q" placeholder="Search Reddit" value="' + esc(opts.q||'') + '"></form>' +
  '<nav><a href="/reddit/">Home</a>' + (DISABLE_SAVES ? '' : '<a href="/reddit/saved">Saved</a>') + '</nav></header>' +
  (opts.banner ? '<div class="banner">' + esc(opts.banner) + '</div>' : '') +
  '<main>' + body + '</main>' +
  '<footer>Anonymous viewing via this server. No Reddit account features (no voting, posting, or account saves).' +
  (DISABLE_SAVES ? ' Saves disabled on this deployment.' : ' Saves are stored only on this device.') + '</footer>' +
  (DISABLE_SAVES ? '' : SAVEJS) + '</body></html>';
}

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#0f1113;color:#e6e6e6;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;font-size:16px}
a{color:#7ab3ff;text-decoration:none}a:hover{text-decoration:underline}
header{position:sticky;top:0;background:#16181c;border-bottom:1px solid #2a2d33;padding:8px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:10}
.brand{font-weight:700;color:#fff;font-size:18px}
header nav a{color:#cfd3da;margin-right:12px}
.search{flex:1;min-width:140px}
.search input{width:100%;max-width:480px;padding:8px 10px;border-radius:8px;border:1px solid #33373f;background:#0c0e10;color:#e6e6e6}
main{max-width:820px;margin:0 auto;padding:12px}
.banner{background:#3a2f10;border:1px solid #6b5a1e;color:#f0d98c;padding:8px 12px;text-align:center}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
.tabs a{padding:6px 12px;border-radius:16px;background:#1c1f24;color:#cfd3da}
.tabs a.on{background:#2f6bd8;color:#fff}
.post{border-bottom:1px solid #23262c;padding:12px 0;display:flex;gap:12px}
.thumb{width:90px;height:68px;object-fit:cover;border-radius:6px;background:#1c1f24;flex:none}
.post .meta{color:#8b929e;font-size:13px;margin-top:4px}
.post h3{margin:0 0 4px;font-size:17px;font-weight:600}
.post h3 a{color:#e6e6e6}
.selftext,.comment .body{color:#cfd3da;font-size:15px;line-height:1.5;overflow-wrap:break-word}
.selftext img,.comment img{max-width:100%;height:auto}
.comment{border-left:2px solid #2a2d33;margin:10px 0;padding:2px 0 2px 12px}
.comment .meta{color:#8b929e;font-size:12px;margin-bottom:4px}
.savebtn{background:none;border:1px solid #3a3f47;color:#cfd3da;border-radius:14px;padding:3px 10px;font-size:12px;cursor:pointer}
.savebtn.on{background:#2f6bd8;border-color:#2f6bd8;color:#fff}
img.full{max-width:100%;height:auto;border-radius:8px}
video{max-width:100%;border-radius:8px;background:#000}
.error,.empty{text-align:center;color:#8b929e;padding:40px 12px}
footer{color:#6a7078;font-size:12px;text-align:center;padding:20px 12px;border-top:1px solid #23262c;margin-top:20px}
.subjump{display:flex;gap:8px;margin:10px 0}.subjump input{flex:1;padding:8px;border-radius:8px;border:1px solid #33373f;background:#0c0e10;color:#e6e6e6}
.subjump button{padding:8px 14px;border-radius:8px;border:0;background:#2f6bd8;color:#fff}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.chips a,.chips span{padding:4px 10px;border-radius:14px;background:#1c1f24;color:#cfd3da;font-size:13px;cursor:pointer}
.chips a.x{border:1px solid #6b3232}
`;

const SAVEJS = `<script>
(function(){
  var KEY='rv_saves';
  function get(){ try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch(e){return[]} }
  function set(v){ localStorage.setItem(KEY,JSON.stringify(v)) }
  window.rvSave=function(btn,id){
    var s=get(); var i=s.findIndex(function(x){return x.id===id});
    if(i>=0){s.splice(i,1);btn.classList.remove('on');btn.textContent='Save';}
    else{s.push({id:id,title:btn.dataset.title,permalink:btn.dataset.permalink,sub:btn.dataset.sub,thumb:btn.dataset.thumb,ts:Date.now()});btn.classList.add('on');btn.textContent='Saved';}
    set(s);
  };
  document.addEventListener('DOMContentLoaded',function(){
    var s=get(); var ids={}; s.forEach(function(x){ids[x.id]=1});
    document.querySelectorAll('.savebtn').forEach(function(b){ if(ids[b.dataset.pid]){b.classList.add('on');b.textContent='Saved';} });
    var host=document.getElementById('saved-list');
    if(host){
      if(!s.length){host.innerHTML='<div class="empty">Nothing saved yet. Saves live only in this browser.</div>';return;}
      host.innerHTML=s.slice().reverse().map(function(x){
        return '<div class="post">'+(x.thumb?'<a href="'+x.permalink+'"><img class="thumb" loading="lazy" src="'+x.thumb+'"></a>':'')+
        '<div><h3><a href="'+x.permalink+'"></a></h3><div class="meta">r/'+(x.sub||'')+'</div></div></div>';
      }).join('');
      host.querySelectorAll('h3 a').forEach(function(a,i){ a.textContent = s.slice().reverse()[i].title; });
    }
  });
})();
</script>`;

function sortTabs(base, sort, t){
  const sorts = ['hot','new','top','rising','controversial'];
  let h = '<div class="tabs">';
  for (const s of sorts) h += '<a class="' + (s===sort?'on':'') + '" href="' + base + (s==='hot'?'':'/'+s) + (t&&['top','controversial'].includes(s)?'?t='+t:'') + '">' + s + '</a>';
  h += '</div>';
  if (['top','controversial'].includes(sort)) {
    h += '<div class="tabs">';
    for (const tt of ['hour','day','week','month','year','all']) h += '<a class="' + (tt===(t||'day')?'on':'') + '" href="' + base + '/' + sort + '?t=' + tt + '">' + tt + '</a>';
    h += '</div>';
  }
  return h;
}

function postRow(p){
  const permalink = '/reddit/comments/' + p.id + '/';
  let media = '';
  const prox = p.thumb ? '/reddit/media?u=' + encodeURIComponent(p.thumb) : '';
  if (p.mediaType === 'image' && p.mediaUrl) media = '<a href="' + permalink + '"><img class="thumb" loading="lazy" src="/reddit/media?u=' + encodeURIComponent(p.mediaUrl) + '"></a>';
  else if (p.thumb) media = '<a href="' + permalink + '"><img class="thumb" loading="lazy" src="' + prox + '"></a>';
  else if (p.mediaType === 'video') media = '<a href="' + permalink + '"><div class="thumb" style="display:flex;align-items:center;justify-content:center;color:#8b929e">video</div></a>';
  let meta = 'r/' + esc(p.subreddit||'') + (p.author ? ' - u/' + esc(p.author) : '') + (p.published ? ' - ' + esc(new Date(p.published).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})) : '');
  if (typeof p.score === 'number') meta += ' - ' + p.score + ' pts';
  if (typeof p.numComments === 'number') meta += ' - ' + p.numComments + ' comments';
  const save = DISABLE_SAVES ? '' : '<button class="savebtn" data-pid="' + esc(p.id) + '" data-title="' + esc(p.title) + '" data-permalink="' + permalink + '" data-sub="' + esc(p.subreddit||'') + '" data-thumb="' + esc(prox) + '" onclick="rvSave(this,\'' + esc(p.id) + '\')">Save</button>';
  return '<div class="post">' + media + '<div style="min-width:0"><h3><a href="' + permalink + '">' + esc(p.title) + '</a></h3><div class="meta">' + meta + '</div><div style="margin-top:6px">' + save + '</div></div></div>';
}

function renderFeed(res, opts){
  let body = '';
  if (opts.header) body += opts.header;
  if (res.mode === 'rss') body += '<div class="banner" style="background:#1c1f24;border-color:#33373f;color:#8b929e">Vote and comment counts are not available in the current anonymous mode.</div>';
  if (!res.posts.length) body += '<div class="empty">No posts found. The subreddit may be empty, private, quarantined, or withheld by Reddit without a login.</div>';
  body += res.posts.map(postRow).join('');
  let banner = '';
  if (res.stale) banner = 'Reddit is rate-limiting requests right now. Showing cached results; pull to retry later.';
  else if (res.cooldown) banner = 'Reddit is rate-limiting requests; content may lag for a few minutes.';
  return { body, banner };
}

// ---------- media proxy ----------
async function handleMedia(req, res, u){
  let target;
  try { target = new URL(u); } catch(e){ res.writeHead(400); return res.end('bad url'); }
  if (target.protocol !== 'https:' || !MEDIA_HOSTS.has(target.hostname)) { res.writeHead(403); return res.end('host not allowed'); }
  try {
    const r = await rawFetch(target.toString());
    if (r.status !== 200) { res.writeHead(r.status === 404 ? 404 : 502); return res.end('upstream ' + r.status); }
    const ct = (r.ct || '').split(';')[0];
    if (!MEDIA_CT_OK.test(ct)) { res.writeHead(415); return res.end('unsupported media type'); }
    if (/mpegurl|dash\+xml/.test(ct)) {
      // rewrite playlist URIs through this proxy
      const base = target.toString();
      let text = r.body.toString('utf8');
      text = text.replace(/^(?!#)(\S.+)$/gm, (m) => {
        const abs = new URL(m.trim(), base).toString();
        return '/reddit/media?u=' + encodeURIComponent(abs);
      });
      text = text.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="/reddit/media?u=' + encodeURIComponent(new URL(uri, base).toString()) + '"');
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
      return res.end(text);
    }
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
    res.end(r.body);
  } catch(e){ res.writeHead(502); res.end('fetch failed'); }
}

// ---------- main handler ----------
async function handle(req, res){
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const send = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); };
  try {
    if (p === '/reddit/hls.min.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' });
      return res.end(require('fs').readFileSync(__dirname + '/hls.min.js'));
    }
    if (p === '/reddit/media') return await handleMedia(req, res, u.searchParams.get('u') || '');

    if (p === '/reddit/' || p === '/reddit') {
      const res2 = await fetchFeed('popular', 'hot');
      const header = '<div class="subjump"><input id="subbox" placeholder="Go to subreddit (e.g. nyc)"><button onclick="location.href=\'/reddit/r/\'+document.getElementById(\'subbox\').value.trim()">Go</button></div>' +
        '<div id="subchips" class="chips"></div>' +
        '<script>(function(){var K="rv_subs",d=["popular","pics","videos","AskReddit","nyc"];try{var s=JSON.parse(localStorage.getItem(K)||"null")||d;var h=document.getElementById("subchips");s.forEach(function(x){var a=document.createElement("a");a.href="/reddit/r/"+x;a.textContent="r/"+x;h.appendChild(a);});var b=document.createElement("span");b.textContent="+ add";b.onclick=function(){var v=document.getElementById("subbox").value.trim();if(v){s.push(v);localStorage.setItem(K,JSON.stringify(s));location.reload();}};h.appendChild(b);}catch(e){}})();</' + 'script>';
      const out = renderFeed(res2, { header });
      return send(200, layout('Home', '<h2 style="margin:8px 0 0">r/popular</h2>' + out.body, { banner: out.banner }));
    }

    let m = p.match(/^\/reddit\/r\/([^/]+)(?:\/(hot|new|top|rising|controversial))?\/?$/);
    if (m) {
      const sub = m[1], sort = m[2] || 'hot', t = u.searchParams.get('t') || undefined;
      const res2 = await fetchFeed(sub, sort, t);
      const out = renderFeed(res2, { header: '<h2 style="margin:8px 0 0">r/' + esc(sub) + '</h2>' + sortTabs('/reddit/r/' + esc(sub), sort, t) });
      return send(200, layout('r/' + sub, out.body, { banner: out.banner }));
    }

    if (p === '/reddit/search') {
      const q = u.searchParams.get('q') || '';
      const sort = u.searchParams.get('sort') || 'relevance';
      const t = u.searchParams.get('t') || 'all';
      const sub = u.searchParams.get('sub') || '';
      if (!q) return send(200, layout('Search', '<div class="empty">Type a search above.</div>', {}));
      const res2 = await fetchSearch(q, sort, t, sub);
      let header = '<h2 style="margin:8px 0 0">Search: ' + esc(q) + (sub ? ' in r/' + esc(sub) : '') + '</h2><div class="tabs">';
      for (const s of ['relevance','top','new']) header += '<a class="' + (s===sort?'on':'') + '" href="/reddit/search?q=' + encodeURIComponent(q) + '&sort=' + s + '&t=' + t + (sub?'&sub='+encodeURIComponent(sub):'') + '">' + s + '</a>';
      header += '</div><div class="tabs">';
      for (const tt of ['hour','day','week','month','year','all']) header += '<a class="' + (tt===t?'on':'') + '" href="/reddit/search?q=' + encodeURIComponent(q) + '&sort=' + sort + '&t=' + tt + (sub?'&sub='+encodeURIComponent(sub):'') + '">' + tt + '</a>';
      header += '</div>';
      const out = renderFeed(res2, { header });
      return send(200, layout('Search', out.body, { banner: out.banner, q }));
    }

    m = p.match(/^\/reddit\/comments\/([a-z0-9]+)\/?/i);
    if (m) {
      const sort = u.searchParams.get('sort') || 'top';
      const res2 = await fetchComments(m[1], sort);
      let body = '';
      if (res2.post) {
        const pp = res2.post;
        body += '<h2>' + esc(pp.title || 'Post') + '</h2>';
        if (pp.mediaType === 'image' && pp.mediaUrl) body += '<img class="full" src="/reddit/media?u=' + encodeURIComponent(pp.mediaUrl) + '">';
        else if (pp.mediaType === 'video' && pp.mediaUrl) {
          const vm = pp.mediaUrl.match(/v\.redd\.it\/(\w+)/) || (pp.permalink||'').match(/\/comments\/([a-z0-9]+)/i);
          if (vm) body += '<video controls playsinline preload="metadata" src="/reddit/media?u=' + encodeURIComponent('https://v.redd.it/' + vm[1] + '/HLSPlaylist.m3u8') + '"></video><script src="/reddit/hls.min.js"></script><script>(function(){var v=document.querySelector("video");if(window.Hls&&Hls.isSupported()){var h=new Hls();h.loadSource(v.src);h.attachMedia(v);}})();</' + 'script>';
        }
        else if (pp.mediaUrl && pp.mediaType === 'gallery') body += '<p><a href="/proxy/' + encodeURIComponent(pp.mediaUrl) + '">Open gallery via proxy</a> (gallery images are not available anonymously)</p>';
        else if (pp.mediaUrl && pp.mediaType === 'link') body += '<p><a href="' + esc(pp.mediaUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(pp.mediaUrl) + '</a></p>';
        if (pp.selftextHtml) body += '<div class="selftext">' + pp.selftextHtml + '</div>';
        body += '<div class="meta" style="color:#8b929e;font-size:13px;margin:8px 0">' + (pp.author ? 'u/' + esc(pp.author) : '') + '</div>';
      }
      body += '<div class="tabs">';
      for (const s of ['top','new','old','controversial']) body += '<a class="' + (s===sort?'on':'') + '" href="/reddit/comments/' + m[1] + '/?sort=' + s + '">' + s + '</a>';
      body += '</div>';
      if (!res2.comments.length) body += '<div class="empty">No comments available.</div>';
      body += res2.comments.map(c => '<div class="comment"><div class="meta">u/' + esc(c.author||'[deleted]') + (c.published ? ' - ' + esc(new Date(c.published).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})) : '') + (typeof c.score==='number' ? ' - ' + c.score + ' pts' : '') + '</div><div class="body">' + c.html + '</div></div>').join('');
      let banner = '';
      if (res2.stale) banner = 'Reddit is rate-limiting requests right now. Showing cached comments.';
      else if (res2.mode === 'rss') banner = '';
      return send(200, layout(res2.post ? res2.post.title : 'Comments', body, { banner }));
    }

    m = p.match(/^\/reddit\/user\/([^/]+)\/?$/);
    if (m) {
      const res2 = await fetchUserFeed(m[1]);
      const out = renderFeed(res2, { header: '<h2 style="margin:8px 0 0">u/' + esc(m[1]) + '</h2>' });
      return send(200, layout('u/' + m[1], out.body, { banner: out.banner }));
    }

    if (p === '/reddit/saved') {
      if (DISABLE_SAVES) return send(200, layout('Saved', '<div class="empty">Saves are disabled on this deployment.</div>', {}));
      return send(200, layout('Saved', '<h2 style="margin:8px 0 12px">Saved on this device</h2><div id="saved-list"></div><div class="empty" style="padding-top:8px"><button class="savebtn" onclick="(function(){var b=new Blob([localStorage.getItem(\'rv_saves\')||\'[]\'],{type:\'application/json\'});var a=document.createElement(\'a\');a.href=URL.createObjectURL(b);a.download=\'reddit-saves.json\';a.click();})()">Export saves</button></div>', {}));
    }

    send(404, layout('Not found', '<div class="empty">Not found.</div>', {}));
  } catch (e) {
    const msg = e.cooldown
      ? 'Reddit is rate-limiting this server right now. Try again in about ' + (e.retryIn || 60) + ' seconds.'
      : 'Reddit could not be reached (' + esc(e.message) + '). This may be a temporary block from Reddit on server traffic; try again later.';
    send(200, layout('Temporarily unavailable', '<div class="error">' + msg + '</div>', { banner: '' }));
  }
}

module.exports = {
  handleRedditRequest(req, res){
    if (!req.url.startsWith('/reddit')) return false;
    handle(req, res).catch(e => { try { res.writeHead(500); res.end('error'); } catch(_){} });
    return true;
  },
  _internal: { parseRssFeed, parseCommentsRss, sanitizeHtml, mediaType, layout }
};
