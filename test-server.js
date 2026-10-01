// Quick standalone test — run with: node test-server.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const PORT = 3000;

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const lanIp = getLanIp();
const mobileDir = path.join(__dirname, 'mobile');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/status') {
    const body = JSON.stringify({ ip: lanIp, port: PORT, ok: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }
  const filePath = url === '/' ? path.join(mobileDir, 'index.html') : path.join(mobileDir, url);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'text/plain';
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': mime });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(mobileDir, 'index.html')));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${lanIp}:${PORT}`);
  console.log(`\nOpen the network URL on your phone.\nPress Ctrl+C to stop.\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use. Close other apps and try again.`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
