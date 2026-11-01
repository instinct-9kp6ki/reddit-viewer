// standalone-server.js - Runs the Reddit viewer as its own service with a passcode gate.
// Recommended deployment: its own Render free web service (separate origin from the
// generic proxy), so hostile proxied pages can never touch viewer storage.
// Env: PORT (default 3000), HOST (default 127.0.0.1; use 0.0.0.0 on Render),
//      PROXY_TOKEN (passcode; REQUIRED for non-loopback HOST - server refuses otherwise),
//      REDDIT_MIN_INTERVAL_MS (default 2500), REDDIT_FEED_TTL_MS (default 300000)
'use strict';
const http = require('http');
const crypto = require('crypto');
const { handleRedditRequest } = require('./reddit');

const TOKEN = process.env.PROXY_TOKEN || '';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);

if (HOST !== '127.0.0.1' && HOST !== '::1' && !TOKEN) {
  console.error('Refusing to start: non-loopback HOST requires PROXY_TOKEN (open viewers get abused).');
  process.exit(1);
}

const sessions = new Set();
function newSession(){ const t = crypto.randomBytes(24).toString('hex'); sessions.add(t); return t; }
function authed(req){
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)rv_session=([a-f0-9]+)/);
  return m && sessions.has(m[1]);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/login') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        const pass = new URLSearchParams(body).get('passcode') || '';
        if (TOKEN && crypto.timingSafeEqual(Buffer.from(pass.padEnd(64)), Buffer.from(TOKEN.padEnd(64)))) {
          res.writeHead(303, { 'Set-Cookie': 'rv_session=' + newSession() + '; HttpOnly; SameSite=Strict; Path=/', 'Location': '/reddit/' });
          res.end();
        } else { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<p>Wrong passcode. <a href="/login">Try again</a></p>'); }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="background:#0f1113;color:#e6e6e6;font-family:system-ui;display:flex;min-height:90vh;align-items:center;justify-content:center"><form method="post" action="/login" style="text-align:center"><h2>Reddit Viewer</h2><input type="password" name="passcode" placeholder="Passcode" style="padding:10px;border-radius:8px;border:1px solid #333;background:#0c0e10;color:#e6e6e6"><button style="padding:10px 18px;border-radius:8px;border:0;background:#2f6bd8;color:#fff">Enter</button></form></body>');
    return;
  }
  if (TOKEN && !authed(req)) { res.writeHead(303, { Location: '/login' }); return res.end(); }
  if (u.pathname === '/' || u.pathname === '') { res.writeHead(303, { Location: '/reddit/' }); return res.end(); }
  if (!handleRedditRequest(req, res)) { res.writeHead(404); res.end('not found'); }
});
server.listen(PORT, HOST, () => console.log('Reddit viewer on http://' + HOST + ':' + PORT + (TOKEN ? ' (passcode locked)' : '')));
