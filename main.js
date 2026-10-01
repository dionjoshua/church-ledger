const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const QRCode = require('qrcode');

const DEFAULT_FIREBASE_URL = 'https://church-ledger-e11f1-default-rtdb.asia-southeast1.firebasedatabase.app';
let mainWindow;
let mobileServerInfo = { ip: null, port: 3000, qrDataUrl: null };
let pendingAdminRequests = {};

// ─── Get LAN IP Address ────────────────────────────────────────────────────
function getLanIp() {
  const interfaces = os.networkInterfaces();
  let fallbackIp = null;
  
  // Sort interface names to prioritize physical Wi-Fi/Ethernet
  const names = Object.keys(interfaces).sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aPref = aLower.includes('wi-fi') || aLower.includes('wlan') || aLower.includes('ethernet');
    const bPref = bLower.includes('wi-fi') || bLower.includes('wlan') || bLower.includes('ethernet');
    if (aPref && !bPref) return -1;
    if (!aPref && bPref) return 1;
    return 0;
  });

  for (const name of names) {
    const nameLower = name.toLowerCase();
    // Identify VPN/virtual adapter names to filter out
    const isVirtual = nameLower.includes('tailscale') || 
                      nameLower.includes('virtual') || 
                      nameLower.includes('vbox') || 
                      nameLower.includes('vmware') || 
                      nameLower.includes('vpn') || 
                      nameLower.includes('vethernet');

    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!isVirtual) {
          return iface.address; // Return first non-virtual, physical local IP
        } else if (!fallbackIp) {
          fallbackIp = iface.address; // Fallback to virtual if no physical found
        }
      }
    }
  }
  return fallbackIp || '127.0.0.1';
}

// ─── Start Mobile HTTP Server (Node built-in, no Express) ────────────────
function startMobileServer() {
  const http = require('http');
  const PORT = 3000;
  const lanIp = getLanIp();
  const mobileDir = path.join(__dirname, 'mobile');

  // MIME types for static files
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
    '.svg':  'image/svg+xml'
  };

  function serveStatic(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(filePath));
    } else {
      // Fallback to index.html for SPA routing
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(mobileDir, 'index.html')));
    }
  }

  function sendJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    const url = req.url.split('?')[0]; // strip query string

    // ── API routes ──────────────────────────────────────────────────────
    if (url === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, { ip: lanIp, port: PORT, version: '1.0.0', ok: true });
    }

    if (url === '/api/data' && req.method === 'GET') {
      try {
        // Always return church data — phones have their own personal endpoints
        const { appDataDir } = getPaths();
        const churchDbPath = path.join(appDataDir, 'vault_data.json');
        if (!fs.existsSync(churchDbPath)) {
          return sendJSON(res, 200, seedDatabase());
        }
        const raw = fs.readFileSync(churchDbPath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(raw);
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    }

    if (url === '/api/data' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          if (!incoming || !incoming.weeks || !incoming.settings) {
            return sendJSON(res, 400, { error: 'Invalid data structure' });
          }
          const { appDataDir } = getPaths();
          const churchDbPath = path.join(appDataDir, 'vault_data.json');
          
          let local = null;
          if (fs.existsSync(churchDbPath)) {
            try { local = JSON.parse(fs.readFileSync(churchDbPath, 'utf8')); } catch (e) {}
          }
          const mergedData = mergeMobileEdits(local, incoming);
          safeWriteJSON(churchDbPath, mergedData);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('remote-data-updated');
          }
          return sendJSON(res, 200, mergedData);
        } catch (err) {
          return sendJSON(res, 500, { error: err.message });
        }
      });
      return;
    }

    // ── Personal profile endpoints (per-device) ──────────────────────────
    // GET /api/personal — list all personal profiles
    if (url === '/api/personal' && req.method === 'GET') {
      try {
        const { appDataDir } = getPaths();
        const personalDir = path.join(appDataDir, 'personal');
        if (!fs.existsSync(personalDir)) return sendJSON(res, 200, {});
        const files = fs.readdirSync(personalDir).filter(f => f.endsWith('.json'));
        const profiles = {};
        files.forEach(f => {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(personalDir, f), 'utf8'));
            const devId = f.replace('.json', '');
            profiles[devId] = { name: raw.name || devId, data: raw.data };
          } catch(e) {}
        });
        return sendJSON(res, 200, profiles);
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    }

    // GET /api/personal/:deviceId — return one device's personal ledger
    const personalGetMatch = url.match(/^\/api\/personal\/([^/]+)$/);
    if (personalGetMatch && req.method === 'GET') {
      try {
        const deviceId = personalGetMatch[1];
        const { appDataDir } = getPaths();
        const personalDir = path.join(appDataDir, 'personal');
        const filePath = path.join(personalDir, deviceId + '.json');
        if (!fs.existsSync(filePath)) return sendJSON(res, 200, null);
        const raw = fs.readFileSync(filePath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(raw);
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    }

    // POST /api/personal/:deviceId — save one device's personal ledger
    const personalPostMatch = url.match(/^\/api\/personal\/([^/]+)$/);
    if (personalPostMatch && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const deviceId = personalPostMatch[1];
          const incoming = JSON.parse(body);
          const { appDataDir } = getPaths();
          const personalDir = path.join(appDataDir, 'personal');
          if (!fs.existsSync(personalDir)) fs.mkdirSync(personalDir, { recursive: true });
          safeWriteJSON(path.join(personalDir, deviceId + '.json'), incoming);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('personal-data-updated', deviceId);
          }
          
          // Background sync to Firebase if configured
          const configPath = path.join(appDataDir, 'firebase_config.json');
          if (fs.existsSync(configPath)) {
            try {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              const activeUrl = config.personalUrl || config.churchUrl || config.firebaseUrl;
              if (activeUrl) {
                const syncUrl = `${activeUrl.trim().replace(/\/$/, '')}/personal/${deviceId}.json`;
                fetch(syncUrl, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(incoming)
                }).catch(err => console.error('Personal Firebase background sync error:', err));
              }
            } catch (fbErr) {
              console.error('Personal Firebase sync config error:', fbErr);
            }
          }
          
          return sendJSON(res, 200, { ok: true });
        } catch (err) {
          return sendJSON(res, 500, { error: err.message });
        }
      });
      return;
    }

    // GET /api/admin/request
    if (url === '/api/admin/request' && req.method === 'GET') {
      return sendJSON(res, 200, pendingAdminRequests);
    }

    // POST /api/admin/request
    if (url === '/api/admin/request' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const deviceId = incoming.deviceId;
          if (!deviceId) return sendJSON(res, 400, { error: 'Missing deviceId' });
          if (incoming.status === 'none') {
            delete pendingAdminRequests[deviceId];
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('admin-requests-updated', pendingAdminRequests);
            }
            return sendJSON(res, 200, { ok: true });
          }
          incoming.status = 'pending';
          pendingAdminRequests[deviceId] = incoming;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('admin-request', incoming);
            mainWindow.webContents.send('admin-requests-updated', pendingAdminRequests);
          }
          return sendJSON(res, 200, { ok: true });
        } catch (err) {
          return sendJSON(res, 500, { error: err.message });
        }
      });
      return;
    }

    // GET /api/admin/request/:deviceId
    const adminGetMatch = url.match(/^\/api\/admin\/request\/([^/]+)$/);
    if (adminGetMatch && req.method === 'GET') {
      const deviceId = adminGetMatch[1];
      const reqState = pendingAdminRequests[deviceId] || { status: 'none' };
      return sendJSON(res, 200, { status: reqState.status });
    }

    // GET /api/config — return church config (PIN etc.)
    if (url === '/api/config' && req.method === 'GET') {
      try {
        const { appDataDir } = getPaths();
        const configPath = path.join(appDataDir, 'firebase_config.json');
        if (!fs.existsSync(configPath)) return sendJSON(res, 200, { churchPin: '1234' });
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return sendJSON(res, 200, { churchPin: config.churchPin || '1234' });
      } catch (err) {
        return sendJSON(res, 500, { error: err.message });
      }
    }

    // POST /api/config — set church config (PIN etc.)
    if (url === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const { appDataDir } = getPaths();
          const configPath = path.join(appDataDir, 'firebase_config.json');
          let config = {};
          if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (incoming.churchPin !== undefined) config.churchPin = incoming.churchPin;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
          return sendJSON(res, 200, { ok: true });
        } catch (err) {
          return sendJSON(res, 500, { error: err.message });
        }
      });
      return;
    }

    // ── Static file serving ──────────────────────────────────────────────
    // Map "/" → index.html
    const filePath = (url === '/' || url === '')
      ? path.join(mobileDir, 'index.html')
      : path.join(mobileDir, url);
    serveStatic(res, filePath);
  });

  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`[Mobile Server] Running on http://${lanIp}:${PORT}`);
    const url = `http://${lanIp}:${PORT}`;
    try {
      const qrDataUrl = await QRCode.toDataURL(url, {
        width: 200,
        margin: 1,
        color: { dark: '#ffffff', light: '#111118' }
      });
      mobileServerInfo = { ip: lanIp, port: PORT, url, qrDataUrl };
      // Push to renderer — it may already be loaded
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('server-info-ready', mobileServerInfo);
      }
    } catch (qrErr) {
      console.error('QR generation error:', qrErr);
      mobileServerInfo = { ip: lanIp, port: PORT, url, qrDataUrl: null };
    }
  });

  server.on('error', (err) => {
    console.error('[Mobile Server] Failed to start:', err.message);
  });
}

// ─── Merge Mobile Edits (LWW resolution for tenant records) ───────────────
function mergeMobileEdits(local, incoming) {
  if (!local) return incoming;
  if (!incoming) return local;

  // Clone local as the structural master
  const merged = JSON.parse(JSON.stringify(local));
  if (!merged.months) merged.months = {};

  const incomingMonths = incoming.months || {};
  Object.keys(incomingMonths).forEach(mKey => {
    if (!merged.months[mKey]) {
      merged.months[mKey] = JSON.parse(JSON.stringify(incomingMonths[mKey]));
      return;
    }

    const incomingTenants = incomingMonths[mKey].tenants || {};
    const localTenants = merged.months[mKey].tenants || {};

    Object.keys(incomingTenants).forEach(tid => {
      const localT = localTenants[tid] || { paid: false, amount: 0, paymentDate: '', updatedAt: 0 };
      const incomingT = incomingTenants[tid] || { paid: false, amount: 0, paymentDate: '', updatedAt: 0 };

      const localTime = localT.updatedAt || 0;
      const incomingTime = incomingT.updatedAt || 0;

      // Keep the tenant record with the higher timestamp (newest write)
      if (incomingTime > localTime) {
        localTenants[tid] = JSON.parse(JSON.stringify(incomingT));
      }
    });
  });

  // Merge weeks (Sunday entries)
  if (!merged.weeks) merged.weeks = {};
  const incomingWeeks = incoming.weeks || {};
  Object.keys(incomingWeeks).forEach(wKey => {
    if (!merged.weeks[wKey]) {
      merged.weeks[wKey] = JSON.parse(JSON.stringify(incomingWeeks[wKey]));
    } else {
      const localW = merged.weeks[wKey];
      const incomingW = incomingWeeks[wKey];
      if (incomingW.offering > 0 && localW.offering === 0) {
        localW.offering = incomingW.offering;
      }
      if (incomingW.label && !localW.label) {
        localW.label = incomingW.label;
      }
      if (incomingW.outgoings && incomingW.outgoings.length > 0 && (!localW.outgoings || localW.outgoings.length === 0)) {
        localW.outgoings = JSON.parse(JSON.stringify(incomingW.outgoings));
      }
    }
  });

  // Helper to merge array items by id with LWW resolution
  function mergeArrayById(localArray, incomingArray) {
    const res = [...(localArray || [])];
    const map = {};
    res.forEach(item => { if (item.id) map[item.id] = item; });
    (incomingArray || []).forEach(item => {
      if (!item.id) return;
      const existing = map[item.id];
      if (!existing) {
        res.push(JSON.parse(JSON.stringify(item)));
      } else if ((item.updatedAt || 0) > (existing.updatedAt || 0)) {
        Object.assign(existing, JSON.parse(JSON.stringify(item)));
      }
    });
    return res;
  }

  // Merge fixedDeposits
  merged.fixedDeposits = mergeArrayById(merged.fixedDeposits, incoming.fixedDeposits);

  // Merge loansAndDeposits
  merged.loansAndDeposits = mergeArrayById(merged.loansAndDeposits, incoming.loansAndDeposits);

  return merged;
}

// Helper to resolve writeable local storage paths
function getPaths() {
  const appDataDir = path.join(app.getPath('userData'), 'App_Data');
  const receiptsDir = path.join(appDataDir, 'Receipts');
  
  let activeProfile = 'church';
  try {
    const configPath = path.join(appDataDir, 'firebase_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.activeProfile === 'personal') {
        activeProfile = 'personal';
      }
    }
  } catch (e) {
    // Ignore config read failures during first launch before folder exists
  }
  
  const dbPath = path.join(appDataDir, activeProfile === 'personal' ? 'personal_vault_data.json' : 'vault_data.json');
  return { appDataDir, receiptsDir, dbPath, activeProfile };
}

// Secure IO Serialization Helper
function safeWriteJSON(filePath, data) {
  try {
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error(`FATAL IO ERROR writing to ${filePath}:`, error);
    throw error;
  }
}

function getSundaysOf2026() {
  const sundays = [];
  let d = new Date(2026, 0, 4); // First Sunday of 2026
  while (d.getFullYear() === 2026) {
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateStr = d.toLocaleDateString('en-US', options);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const isoDate = `${yyyy}-${mm}-${dd}`;
    sundays.push({
      dateKey: isoDate,
      label: dateStr.replace(', ', ' - ') // "Sunday - January 4, 2026"
    });
    d.setDate(d.getDate() + 7);
  }
  return sundays;
}

function seedDatabase() {
  const sundays = getSundaysOf2026();
  const weeks = {};
  sundays.forEach(s => {
    weeks[s.dateKey] = {
      sundayDate: s.dateKey,
      label: s.label,
      offering: 0.00,
      outgoings: [],
      customCells: {}
    };
  });

  // Pre-populate months of 2026 with default rent dates (first Sunday of the month)
  const months = {};
  const monthKeys = [
    "2026-01", "2026-02", "2026-03", "2026-04",
    "2026-05", "2026-06", "2026-07", "2026-08",
    "2026-09", "2026-10", "2026-11", "2026-12"
  ];
  monthKeys.forEach(m => {
    const yr = parseInt(m.substring(0, 4));
    const mo = parseInt(m.substring(5, 7)) - 1;
    let firstSunday = new Date(yr, mo, 1);
    while (firstSunday.getDay() !== 0) {
      firstSunday.setDate(firstSunday.getDate() + 1);
    }
    const yyyy = firstSunday.getFullYear();
    const mm = String(firstSunday.getMonth() + 1).padStart(2, '0');
    const dd = String(firstSunday.getDate()).padStart(2, '0');
    const firstSundayStr = `${yyyy}-${mm}-${dd}`;

    months[m] = {
      tenants: {
        "room1": { "paid": false, "paymentDate": firstSundayStr, "amount": 0.00 },
        "room2": { "paid": false, "paymentDate": firstSundayStr, "amount": 0.00 },
        "room3": { "paid": false, "paymentDate": firstSundayStr, "amount": 0.00 }
      }
    };
  });

  return {
    profileType: 'church',
    settings: {
      columns: [
        { "id": "date", "label": "Sunday Date", "type": "date", "editable": false },
        { "id": "offering", "label": "Sunday Collections", "type": "number", "editable": true },
        { "id": "rentalRevenue", "label": "Rental Revenue", "type": "number", "editable": false }
      ],
      tenantRates: {
        "room1": 0.00,
        "room2": 0.00,
        "room3": 0.00
      },
      tenantNames: {
        "room1": "Room 1",
        "room2": "Room 2",
        "room3": "Room 3"
      }
    },
    landlordLease: {
      baseRent: 0.00,
      months: {
        "2026-01": 0.00, "2026-02": 0.00, "2026-03": 0.00, "2026-04": 0.00,
        "2026-05": 0.00, "2026-06": 0.00, "2026-07": 0.00, "2026-08": 0.00,
        "2026-09": 0.00, "2026-10": 0.00, "2026-11": 0.00, "2026-12": 0.00
      }
    },
    fixedDeposits: [],
    loansAndDeposits: [],
    months: months,
    weeks: weeks,
    customSundays: []
  };
}

function getDaysOf2026() {
  const days = [];
  let d = new Date(2026, 0, 1); // Start of 2026
  while (d.getFullYear() === 2026) {
    const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
    const dateStr = d.toLocaleDateString('en-US', options);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const isoDate = `${yyyy}-${mm}-${dd}`;
    days.push({
      dateKey: isoDate,
      label: dateStr.replace(', ', ' - ') // "Thu - Jan 1, 2026"
    });
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function seedPersonalDatabase() {
  const days = getDaysOf2026();
  const weeks = {};
  days.forEach(d => {
    weeks[d.dateKey] = {
      sundayDate: d.dateKey, // keep schema key name for compatibility
      label: d.label,
      offering: 0.00, // represents daily income
      outgoings: [], // represents daily expenses
      customCells: {}
    };
  });
  return {
    profileType: 'personal',
    settings: {
      columns: [
        { "id": "date", "label": "Date", "type": "date", "editable": false },
        { "id": "offering", "label": "Income", "type": "number", "editable": true }
      ],
      tenantRates: {},
      tenantNames: {}
    },
    landlordLease: {
      baseRent: 0.00,
      months: {}
    },
    fixedDeposits: [],
    loansAndDeposits: [],
    months: {},
    weeks: weeks,
    customSundays: []
  };
}

process.on('uncaughtException', (error) => {
  fs.appendFileSync(path.join(app.getPath('desktop'), 'church_ledger_error.log'), 'Uncaught Exception: ' + error.stack + '\n');
});
process.on('unhandledRejection', (reason, promise) => {
  fs.appendFileSync(path.join(app.getPath('desktop'), 'church_ledger_error.log'), 'Unhandled Rejection: ' + reason + '\n');
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1000,
    minHeight: 600,
    frame: false, // Frameless for premium Apple UI
    icon: path.join(__dirname, 'mobile/icon-192.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#111111'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html')).catch(err => {
    fs.appendFileSync(path.join(app.getPath('desktop'), 'church_ledger_error.log'), 'LoadFile Error: ' + err.message + '\n');
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Register app-data protocol to securely load local files (receipts)
    protocol.handle('app-data', (request) => {
      const rawPath = request.url.slice('app-data://'.length);
      const { appDataDir } = getPaths();
      const absolutePath = path.join(appDataDir, decodeURIComponent(rawPath));
      return { filePath: absolutePath };
    });

    // Ensure AppData directories exist
    const { appDataDir, receiptsDir } = getPaths();
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true });
    }
    if (!fs.existsSync(receiptsDir)) {
      fs.mkdirSync(receiptsDir, { recursive: true });
    }

    createWindow();
    startMobileServer();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(err => {
    fs.appendFileSync(path.join(app.getPath('desktop'), 'church_ledger_error.log'), 'WhenReady Error: ' + err.stack + '\n');
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC HANDLERS ---

// 1. Load database
ipcMain.handle('db-load', async () => {
  try {
    const { dbPath, activeProfile } = getPaths();
    if (!fs.existsSync(dbPath)) {
      const defaultData = activeProfile === 'personal' ? seedPersonalDatabase() : seedDatabase();
      safeWriteJSON(dbPath, defaultData);
      return defaultData;
    }
    const dataRaw = fs.readFileSync(dbPath, 'utf8');
    const parsed = JSON.parse(dataRaw);
    
    let updated = false;
    
    // Auto-migrate database properties with profileType
    if (!parsed.profileType) {
      parsed.profileType = activeProfile;
      updated = true;
    }
    
    // Retrofitting for church profile
    if (parsed.profileType === 'church') {
      if (!parsed.months) {
        const defaultData = seedDatabase();
        parsed.months = defaultData.months;
        parsed.settings.tenantNames = defaultData.settings.tenantNames;
        parsed.settings.tenantRates = defaultData.settings.tenantRates;
        parsed.settings.columns = defaultData.settings.columns;
        Object.keys(parsed.weeks).forEach(k => {
          delete parsed.weeks[k].tenants;
        });
        updated = true;
      }
      
      if (!parsed.landlordLease) {
        const defaultData = seedDatabase();
        parsed.landlordLease = defaultData.landlordLease;
        updated = true;
      } else {
        Object.keys(parsed.landlordLease.months).forEach(mKey => {
          if (typeof parsed.landlordLease.months[mKey] === 'boolean') {
            parsed.landlordLease.months[mKey] = parsed.landlordLease.months[mKey] ? parseFloat(parsed.landlordLease.baseRent) : 0.00;
            updated = true;
          }
        });
      }
      if (!parsed.fixedDeposits) {
        parsed.fixedDeposits = [];
        updated = true;
      }
    } else if (parsed.profileType === 'personal') {
      if (!parsed.fixedDeposits) {
        parsed.fixedDeposits = [];
        updated = true;
      }
      if (!parsed.settings) {
        parsed.settings = {
          columns: [
            { "id": "date", "label": "Date", "type": "date", "editable": false },
            { "id": "offering", "label": "Income", "type": "number", "editable": true }
          ],
          tenantRates: {},
          tenantNames: {}
        };
        updated = true;
      }
    }

    if (updated) {
      safeWriteJSON(dbPath, parsed);
    }
    
    return parsed;
  } catch (err) {
    console.error('Error loading DB:', err);
    const { activeProfile } = getPaths();
    return activeProfile === 'personal' ? seedPersonalDatabase() : seedDatabase(); // Fallback
  }
});

// 2. Save database
ipcMain.handle('db-save', async (event, data) => {
  try {
    const { dbPath } = getPaths();
    safeWriteJSON(dbPath, data);

    // Fire-and-forget sync to Firebase if configured
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const active = config.activeProfile || 'church';
        const activeUrl = active === 'personal' ? config.personalUrl : (config.churchUrl || config.firebaseUrl);
        if (activeUrl) {
          const url = `${activeUrl.trim().replace(/\/$/, '')}/data.json`;
          fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          }).catch(err => console.error('Firebase background sync error:', err));
        }
      } catch (fbErr) {
        console.error('Firebase config read/sync error:', fbErr);
      }
    }

    return true;
  } catch (err) {
    console.error('Error saving DB:', err);
    throw err;
  }
});

// Firebase Config handlers
ipcMain.handle('get-firebase-url', async () => {
  try {
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const active = config.activeProfile || 'church';
      const url = active === 'personal' ? (config.personalUrl || '') : (config.churchUrl || config.firebaseUrl || '');
      return url || DEFAULT_FIREBASE_URL;
    }
  } catch (err) {
    console.error('Error getting firebase URL:', err);
  }
  return DEFAULT_FIREBASE_URL;
});

ipcMain.handle('set-firebase-url', async (event, url) => {
  try {
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    const active = config.activeProfile || 'church';
    if (active === 'personal') {
      config.personalUrl = url;
    } else {
      config.churchUrl = url;
      config.firebaseUrl = url; // fallback compatibility
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error setting firebase URL:', err);
    throw err;
  }
});

// Active Profile Configuration IPC handlers
ipcMain.handle('get-active-profile', async () => {
  try {
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.activeProfile || 'church';
    }
  } catch (err) {
    console.error('Error getting active profile:', err);
  }
  return 'church';
});

ipcMain.handle('set-active-profile', async (event, profile) => {
  try {
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    config.activeProfile = profile;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error setting active profile:', err);
    throw err;
  }
});

// Church PIN handlers
ipcMain.handle('get-church-pin', async () => {
  try {
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.churchPin || '1234';
    }
  } catch (err) { console.error('Error getting church PIN:', err); }
  return '1234';
});

ipcMain.handle('set-church-pin', async (event, pin) => {
  try {
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    let config = {};
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.churchPin = pin;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    // Also sync to Firebase if configured
    const churchUrl = config.churchUrl || config.firebaseUrl;
    if (churchUrl) {
      const url = `${churchUrl.trim().replace(/\/$/, '')}/config.json`;
      fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ churchPin: pin }) })
        .catch(e => console.error('Firebase config sync error:', e));
    }
    return true;
  } catch (err) { console.error('Error setting church PIN:', err); throw err; }
});

// Get all personal profiles (for laptop monitoring)
ipcMain.handle('get-all-personal-profiles', async () => {
  try {
    const { appDataDir } = getPaths();
    const personalDir = path.join(appDataDir, 'personal');
    if (!fs.existsSync(personalDir)) return {};
    const files = fs.readdirSync(personalDir).filter(f => f.endsWith('.json'));
    const profiles = {};
    files.forEach(f => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(personalDir, f), 'utf8'));
        const devId = f.replace('.json', '');
        profiles[devId] = raw;
      } catch(e) {}
    });
    return profiles;
  } catch (err) { console.error('Error getting personal profiles:', err); return {}; }
});

ipcMain.handle('get-pending-admin-requests', async () => {
  return pendingAdminRequests;
});

ipcMain.handle('save-personal-profile', async (event, { deviceId, profileData }) => {
  try {
    const { appDataDir } = getPaths();
    const personalDir = path.join(appDataDir, 'personal');
    if (!fs.existsSync(personalDir)) fs.mkdirSync(personalDir, { recursive: true });
    safeWriteJSON(path.join(personalDir, deviceId + '.json'), profileData);
    return true;
  } catch (err) {
    console.error('Error saving personal profile:', err);
    return false;
  }
});

ipcMain.handle('set-admin-request-status', async (event, { deviceId, status }) => {
  if (pendingAdminRequests[deviceId]) {
    pendingAdminRequests[deviceId].status = status;
  }
  
  try {
    const { appDataDir } = getPaths();
    const configPath = path.join(appDataDir, 'firebase_config.json');
    let config = {};
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    const churchUrl = config.churchUrl || config.firebaseUrl;
    
    if (status === 'approved') {
      config.approvedAdminDeviceId = deviceId;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      
      if (churchUrl) {
        const url = `${churchUrl.trim().replace(/\/$/, '')}/config.json`;
        fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvedAdminDeviceId: deviceId }) })
          .catch(e => console.error('Firebase config sync error:', e));
          
        const reqUrl = `${churchUrl.trim().replace(/\/$/, '')}/admin_requests/${deviceId}.json`;
        fetch(reqUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) })
          .catch(e => console.error('Firebase status sync error:', e));
      }
    } else if (status === 'denied') {
      if (config.approvedAdminDeviceId === deviceId) {
        config.approvedAdminDeviceId = '';
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        
        if (churchUrl) {
          const url = `${churchUrl.trim().replace(/\/$/, '')}/config.json`;
          fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvedAdminDeviceId: '' }) })
            .catch(e => console.error('Firebase config sync error:', e));
        }
      }
      
      if (churchUrl) {
        const reqUrl = `${churchUrl.trim().replace(/\/$/, '')}/admin_requests/${deviceId}.json`;
        fetch(reqUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'denied' }) })
          .catch(e => console.error('Firebase status sync error:', e));
      }
    }
  } catch(e) {
    console.error('Error setting admin status details:', e);
  }

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('admin-requests-updated', pendingAdminRequests);
  }
  
  return true;
});

// 3. Copy receipt file to local Receipts folder
ipcMain.handle('copy-receipt', async (event, filePath) => {
  try {
    const { receiptsDir } = getPaths();
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const safeName = `${base.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}${ext}`;
    const destPath = path.join(receiptsDir, safeName);
    fs.copyFileSync(filePath, destPath);
    // Return relative path under App_Data
    return `Receipts/${safeName}`;
  } catch (err) {
    console.error('Error copying receipt:', err);
    throw err;
  }
});

// 4. Export to Excel
ipcMain.handle('export-excel', async (event, exportData) => {
  try {
    const { mainGrid, tenants, outgoings } = exportData;
    const wb = XLSX.utils.book_new();

    if (mainGrid) {
      const wsMain = XLSX.utils.json_to_sheet(mainGrid);
      XLSX.utils.book_append_sheet(wb, wsMain, "Master Weekly Ledger");
    }
    if (tenants) {
      const wsTenants = XLSX.utils.json_to_sheet(tenants);
      XLSX.utils.book_append_sheet(wb, wsTenants, "Tenant Accounts");
    }
    if (outgoings) {
      const wsOut = XLSX.utils.json_to_sheet(outgoings);
      XLSX.utils.book_append_sheet(wb, wsOut, "Operating Expenses");
    }

    const { filePath } = await dialog.showSaveDialog({
      title: 'Export Master Data to Excel',
      defaultPath: path.join(app.getPath('downloads'), `Church_Ledger_${new Date().toISOString().slice(0, 10)}.xlsx`),
      filters: [{ name: 'Excel Worksheets', extensions: ['xlsx'] }]
    });

    if (filePath) {
      XLSX.writeFile(wb, filePath);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error exporting Excel:', err);
    throw err;
  }
});

// 5. Create Backup
ipcMain.handle('create-backup', async (event, data) => {
  try {
    const { filePath } = await dialog.showSaveDialog({
      title: 'Create Local Vault Backup',
      defaultPath: path.join(app.getPath('downloads'), `Church_Ledger_Backup_${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (filePath) {
      safeWriteJSON(filePath, data);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error creating backup:', err);
    throw err;
  }
});

// 6. Import Backup
ipcMain.handle('import-data', async (event) => {
  try {
    const { filePaths } = await dialog.showOpenDialog({
      title: 'Import Local Vault Backup',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile']
    });

    if (filePaths && filePaths.length > 0) {
      const dataRaw = fs.readFileSync(filePaths[0], 'utf8');
      const parsed = JSON.parse(dataRaw);
      
      if (!parsed.weeks || !parsed.settings) {
        return { success: false, error: "Invalid backup file format." };
      }

      const { dbPath } = getPaths();
      safeWriteJSON(dbPath, parsed);
      
      return { success: true, data: parsed };
    }
    return { success: false, canceled: true };
  } catch (err) {
    console.error('Error importing backup:', err);
    return { success: false, error: err.message };
  }
});

// 7. Open receipt file native OS handler
ipcMain.handle('open-file', async (event, relativePath) => {
  try {
    const { appDataDir } = getPaths();
    const absolutePath = path.join(appDataDir, relativePath);
    await require('electron').shell.openPath(absolutePath);
    return true;
  } catch (err) {
    console.error('Error opening file:', err);
    throw err;
  }
});

// 8. Get mobile server info
ipcMain.handle('get-server-info', async () => {
  return mobileServerInfo;
});

// Window Controls
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});
ipcMain.on('window-close', () => {
  if (mainWindow) {
    mainWindow.close();
  }
  app.quit();
  process.exit(0); // Nuclear option to prevent ghost processes
});
