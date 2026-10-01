// ─── CHURCH LEDGER — CLOUD SERVER FOR RAILWAY ────────────────────────────────
// This standalone server replaces the Electron-embedded HTTP server.
// It stores all data as JSON files and serves the mobile web app.
// Deploy on Railway: https://railway.app
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'App_Data');

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR))                         fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(DATA_DIR, 'personal'))) fs.mkdirSync(path.join(DATA_DIR, 'personal'), { recursive: true });

const VAULT_PATH  = path.join(DATA_DIR, 'vault_data.json');
const CONFIG_PATH = path.join(DATA_DIR, 'firebase_config.json');

// In-memory admin request map (resets on server restart — for Railway this is fine,
// as admin approval usually happens within a session)
let pendingAdminRequests = {};

// ─── helpers ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type'                : 'application/json',
    'Content-Length'              : Buffer.byteLength(body),
    'Access-Control-Allow-Origin' : '*',
  });
  res.end(body);
}

function safeRead(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function safeWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function seedDatabase() {
  return {
    weeks: {}, months: {}, fixedDeposits: [], loansAndDeposits: [],
    landlordLease: { baseRent: 0, months: {} },
    settings: { tenantRates: {}, tenantNames: {}, columns: [] },
  };
}

function mergeArrayById(localArr, incomingArr) {
  const res = [...(localArr || [])];
  const map = {};
  res.forEach(item => { if (item.id) map[item.id] = item; });
  (incomingArr || []).forEach(item => {
    if (!item.id) return;
    const existing = map[item.id];
    if (!existing)                                           res.push(JSON.parse(JSON.stringify(item)));
    else if ((item.updatedAt || 0) > (existing.updatedAt || 0)) Object.assign(existing, JSON.parse(JSON.stringify(item)));
  });
  return res;
}

function mergeData(local, incoming) {
  if (!local)    return incoming;
  if (!incoming) return local;
  const merged = JSON.parse(JSON.stringify(local));
  if (!merged.months) merged.months = {};

  // Merge months / tenants (last-write-wins by updatedAt)
  Object.keys(incoming.months || {}).forEach(mKey => {
    if (!merged.months[mKey]) { merged.months[mKey] = JSON.parse(JSON.stringify(incoming.months[mKey])); return; }
    const localTenants    = merged.months[mKey].tenants    || {};
    const incomingTenants = incoming.months[mKey].tenants  || {};
    Object.keys(incomingTenants).forEach(tid => {
      const l = localTenants[tid]    || { paid: false, amount: 0, updatedAt: 0 };
      const r = incomingTenants[tid] || { paid: false, amount: 0, updatedAt: 0 };
      if ((r.updatedAt || 0) > (l.updatedAt || 0)) localTenants[tid] = JSON.parse(JSON.stringify(r));
    });
  });

  // Merge weeks
  if (!merged.weeks) merged.weeks = {};
  Object.keys(incoming.weeks || {}).forEach(wKey => {
    if (!merged.weeks[wKey]) { merged.weeks[wKey] = JSON.parse(JSON.stringify(incoming.weeks[wKey])); return; }
    const lw = merged.weeks[wKey];
    const rw = incoming.weeks[wKey];
    if (rw.offering > 0 && lw.offering === 0)                   lw.offering  = rw.offering;
    if (rw.label   && !lw.label)                                 lw.label     = rw.label;
    if (rw.outgoings?.length > 0 && !lw.outgoings?.length)      lw.outgoings = JSON.parse(JSON.stringify(rw.outgoings));
  });

  merged.fixedDeposits    = mergeArrayById(merged.fixedDeposits,    incoming.fixedDeposits);
  merged.loansAndDeposits = mergeArrayById(merged.loansAndDeposits, incoming.loansAndDeposits);
  return merged;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const MOBILE_DIR = path.join(__dirname, 'mobile');

const server = http.createServer((req, res) => {
  const url    = req.url.split('?')[0];
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── Status ──────────────────────────────────────────────────────────────
  if (url === '/api/status' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, version: '2.0.0', mode: 'cloud' });
  }

  // ── Church data ─────────────────────────────────────────────────────────
  if (url === '/api/data' && method === 'GET') {
    const data = safeRead(VAULT_PATH) || seedDatabase();
    return sendJSON(res, 200, data);
  }

  if (url === '/api/data' && method === 'POST') {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        if (!incoming?.weeks || !incoming?.settings) return sendJSON(res, 400, { error: 'Invalid data structure' });
        const merged = mergeData(safeRead(VAULT_PATH), incoming);
        safeWrite(VAULT_PATH, merged);
        return sendJSON(res, 200, merged);
      } catch (err) { return sendJSON(res, 500, { error: err.message }); }
    });
    return;
  }

  // ── Personal profiles ───────────────────────────────────────────────────
  if (url === '/api/personal' && method === 'GET') {
    const dir = path.join(DATA_DIR, 'personal');
    const profiles = {};
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          profiles[f.replace('.json', '')] = { name: d.name || f.replace('.json', ''), data: d.data };
        } catch {}
      });
    }
    return sendJSON(res, 200, profiles);
  }

  const personalMatch = url.match(/^\/api\/personal\/([^/]+)$/);
  if (personalMatch) {
    const devId    = personalMatch[1];
    const filePath = path.join(DATA_DIR, 'personal', devId + '.json');
    if (method === 'GET') {
      const d = safeRead(filePath);
      return sendJSON(res, 200, d);
    }
    if (method === 'POST') {
      let body = '';
      req.on('data', c => { body += c.toString(); });
      req.on('end', () => {
        try {
          safeWrite(filePath, JSON.parse(body));
          return sendJSON(res, 200, { ok: true });
        } catch (err) { return sendJSON(res, 500, { error: err.message }); }
      });
      return;
    }
  }

  // ── Config / PIN ────────────────────────────────────────────────────────
  if (url === '/api/config' && method === 'GET') {
    const cfg = safeRead(CONFIG_PATH) || {};
    return sendJSON(res, 200, { churchPin: cfg.churchPin || '1234' });
  }

  if (url === '/api/config' && method === 'POST') {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        const cfg      = safeRead(CONFIG_PATH) || {};
        if (incoming.churchPin !== undefined) cfg.churchPin = incoming.churchPin;
        safeWrite(CONFIG_PATH, cfg);
        return sendJSON(res, 200, { ok: true });
      } catch (err) { return sendJSON(res, 500, { error: err.message }); }
    });
    return;
  }

  // ── Admin requests ──────────────────────────────────────────────────────
  if (url === '/api/admin/request' && method === 'GET') {
    return sendJSON(res, 200, pendingAdminRequests);
  }

  if (url === '/api/admin/request' && method === 'POST') {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        if (!incoming.deviceId) return sendJSON(res, 400, { error: 'Missing deviceId' });
        if (incoming.status === 'none') { delete pendingAdminRequests[incoming.deviceId]; }
        else { incoming.status = 'pending'; pendingAdminRequests[incoming.deviceId] = incoming; }
        return sendJSON(res, 200, { ok: true });
      } catch (err) { return sendJSON(res, 500, { error: err.message }); }
    });
    return;
  }

  const adminGetMatch = url.match(/^\/api\/admin\/request\/([^/]+)$/);
  if (adminGetMatch && method === 'GET') {
    const s = pendingAdminRequests[adminGetMatch[1]] || { status: 'none' };
    return sendJSON(res, 200, { status: s.status });
  }

  // POST /api/admin/approve/:deviceId
  const adminApproveMatch = url.match(/^\/api\/admin\/approve\/([^/]+)$/);
  if (adminApproveMatch && method === 'POST') {
    const devId = adminApproveMatch[1];
    if (pendingAdminRequests[devId]) {
      pendingAdminRequests[devId].status = 'approved';
    }
    return sendJSON(res, 200, { ok: true });
  }

  // ── Static file serving (mobile web app) ───────────────────────────────
  const filePath = (url === '/' || url === '')
    ? path.join(MOBILE_DIR, 'index.html')
    : path.join(MOBILE_DIR, url);

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': mime });
    return res.end(fs.readFileSync(filePath));
  }
  // SPA fallback
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(MOBILE_DIR, 'index.html')));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅  Church Ledger Cloud Server running on port ${PORT}`);
});
