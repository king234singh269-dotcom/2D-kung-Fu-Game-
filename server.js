// Kung Fu Duel - LAN multiplayer server (Node.js, no extra packages)
// Usage:  node server.js        then open  http://<this-computer-ip>:3000  on both devices
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const GAME = path.join(__dirname, 'kung-fu-duel-mp.html');

// Keep the window open on errors, so double-clicking this file shows the message
function pauseThenExit(code) {
  if (!process.stdin.isTTY) process.exit(code);   // on Render or any server: just exit
  console.log('\nPress Enter to close this window...');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}
process.on('uncaughtException', (err) => { console.error('Error: ' + err.message); pauseThenExit(1); });
if (!fs.existsSync(GAME)) {
  console.error('ERROR: kung-fu-duel-mp.html was not found next to server.js.');
  console.error('Put both files in the same folder and try again.');
  pauseThenExit(1);
}

// one room: the host and a single guest
const room = { guestSkin: null, guestName: null, started: false, snap: null, guestKeys: {}, acts: [] };

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 300000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/') {
    fs.readFile(GAME, (err, data) => {
      if (err) { res.writeHead(500); return res.end('kung-fu-duel-mp.html is missing next to server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && url === '/lobby') {
    return sendJson(res, { guestSkin: room.guestSkin, guestName: room.guestName, started: room.started });
  }
  if (req.method === 'POST' && url === '/join') {
    const b = await readBody(req);
    room.guestSkin = b.skin; room.guestName = String(b.name || 'PLAYER').slice(0, 12);
    room.started = false; room.snap = null; room.acts = []; room.guestKeys = {};
    return sendJson(res, { ok: true });
  }
  if (req.method === 'POST' && url === '/start') { room.started = true; return sendJson(res, { ok: true }); }
  if (req.method === 'POST' && url === '/end') {
    room.started = false; room.snap = null; room.guestSkin = null; room.guestName = null; room.acts = [];
    return sendJson(res, { ok: true });
  }
  if (req.method === 'POST' && url === '/state') { room.snap = await readBody(req); return sendJson(res, { ok: true }); }
  if (req.method === 'GET' && url === '/state') { return sendJson(res, { snap: room.snap, started: room.started }); }
  if (req.method === 'POST' && url === '/input') {
    const b = await readBody(req);
    room.guestKeys = b.keys || {};
    if (Array.isArray(b.acts)) room.acts.push(...b.acts.slice(0, 20));
    if (room.acts.length > 100) room.acts.splice(0, room.acts.length - 100);
    return sendJson(res, { ok: true });
  }
  if (req.method === 'GET' && url === '/input') {
    const acts = room.acts.splice(0);
    return sendJson(res, { keys: room.guestKeys, acts });
  }
  res.writeHead(404); res.end('not found');
});

server.on('error', (err) => { console.error('Could not start the server: ' + err.message); console.error('Is port ' + PORT + ' already in use?'); pauseThenExit(1); });
if (fs.existsSync(GAME)) server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  console.log('Kung Fu Duel LAN server running on port ' + PORT);
  ips.forEach((ip) => console.log('  open on the other device:  http://' + ip + ':' + PORT));
});
