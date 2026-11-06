// Kung Fu Duel - LAN/online multiplayer server (Node.js, no extra packages)
// Local:  node server.js        then open http://<this-computer-ip>:3000
// Render: start command  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GAME = path.join(__dirname, 'kung-fu-duel-mp.html');

function pauseThenExit(code) {
  if (!process.stdin.isTTY) process.exit(code);
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

// one room: one host and one guest
const room = { guestSkin: null, guestName: null, started: false };
const sockets = { host: null, guest: null };

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/') {
    fs.readFile(GAME, (err, data) => {
      if (err) { res.writeHead(500); return res.end('game file missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (req.method === 'GET' && url === '/lobby') {
    return sendJson(res, { guestSkin: room.guestSkin, guestName: room.guestName, started: room.started });
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
  req.on('end', () => {
    let b = {};
    try { b = JSON.parse(body || '{}'); } catch (e) {}
    if (req.method === 'POST' && url === '/join') {
      room.guestSkin = b.skin; room.guestName = String(b.name || 'PLAYER').slice(0, 12); room.started = false;
      return sendJson(res, { ok: true });
    }
    if (req.method === 'POST' && url === '/start') { room.started = true; return sendJson(res, { ok: true }); }
    if (req.method === 'POST' && url === '/end') {
      room.started = false; room.guestSkin = null; room.guestName = null;
      return sendJson(res, { ok: true });
    }
    res.writeHead(404); res.end('not found');
  });
});

// ---- WebSocket (RFC 6455), implemented here so no packages are needed ----
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, sock) => {
  if (req.url.split('?')[0] !== '/ws') { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, role: null, buf: Buffer.alloc(0), dropped: false };
  sock.on('data', (d) => { c.buf = Buffer.concat([c.buf, d]); readFrames(c); });
  sock.on('close', () => drop(c));
  sock.on('error', () => drop(c));
});

function readFrames(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { if (b.length < off + 4) return; mask = b.slice(off, off + 4); off += 4; }
    if (b.length < off + len) return;
    const payload = Buffer.from(b.slice(off, off + len));
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
    c.buf = b.slice(off + len);
    if (op === 0x8) { c.sock.end(); drop(c); return; }                 // close
    if (op === 0x9) { sendFrame(c.sock, payload, 0xA); continue; }     // ping -> pong
    if (op === 0x1) onMessage(c, payload.toString('utf8'));            // text
  }
}

function sendFrame(sock, data, op = 0x1) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let hdr;
  if (b.length < 126) { hdr = Buffer.from([0x80 | op, b.length]); }
  else if (b.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 126; hdr.writeUInt16BE(b.length, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(b.length), 2); }
  sock.write(Buffer.concat([hdr, b]));
}

function onMessage(c, text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (m.t === 'hello') {
    if (m.role === 'host' || m.role === 'guest') { c.role = m.role; sockets[m.role] = c; }
    return;
  }
  // host state goes to the guest, guest input goes to the host
  if (m.t === 'state' && c.role === 'host' && sockets.guest) {
    sendFrame(sockets.guest.sock, JSON.stringify({ t: 'state', snap: m.snap }));
  } else if (m.t === 'input' && c.role === 'guest' && sockets.host) {
    sendFrame(sockets.host.sock, JSON.stringify({ t: 'input', keys: m.keys, acts: m.acts }));
  }
}

function drop(c) {
  if (c.dropped) return;
  c.dropped = true;
  if (c.role && sockets[c.role] === c) sockets[c.role] = null;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  console.log('Kung Fu Duel server running on port ' + PORT);
  ips.forEach((ip) => console.log('  open on the other device:  http://' + ip + ':' + PORT));
});
