// --- CHURCH LEDGER RENDERER PROCESS ---

let db = null;
let expandedRows = new Set();
let expandedRowTab = new Map(); // Tracks which tab (collections/expenses) is active per expanded row
let currentView = 'dashboard';
let firebaseUrl = localStorage.getItem('church_ledger_firebase_url') || 'https://church-ledger-e11f1-default-rtdb.asia-southeast1.firebasedatabase.app';
let activeProfile = 'church';
let mobileServerInfo = null;

// Deep Error Catching
window.onerror = function(message, source, lineno, colno, error) {
  console.error("CRITICAL RENDERER ERROR:", message, "at", source, lineno);
};

// DOM Elements
const views = {
  dashboard: document.getElementById('view-dashboard'),
  grid: document.getElementById('view-grid'),
  tenants: document.getElementById('view-tenants'),
  governance: document.getElementById('view-governance')
};

const navItems = document.querySelectorAll('.nav-item');
const metricLiquidAssets = document.getElementById('metric-liquid-assets');
const metricFixedReserves = document.getElementById('metric-fixed-reserves');
const metricSundayCollections = document.getElementById('metric-sunday-collections');
const metricEstateYield = document.getElementById('metric-estate-yield');
const metricOperatingLosses = document.getElementById('metric-operating-losses');

// Header Buttons
const btnBackup = document.getElementById('btn-backup');
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');
const btnAddColumn = document.getElementById('btn-add-column');
const btnAddSunday = document.getElementById('btn-add-sunday');
const btnAddTenantConfig = document.getElementById('btn-add-tenant-config');
const gridSearch = document.getElementById('grid-search');

// Roster Table Body
const tenantSettingsBody = document.getElementById('tenant-settings-body');

// Grid Elements
const gridHeaderRow = document.getElementById('grid-header-row');
const gridBody = document.getElementById('grid-body');

// Tooltip Element (Create dynamically on body)
const tooltip = document.createElement('div');
tooltip.id = 'chart-tooltip';
tooltip.style.position = 'absolute';
tooltip.style.padding = '8px 12px';
tooltip.style.background = '#111111';
tooltip.style.color = '#ffffff';
tooltip.style.borderRadius = '6px';
tooltip.style.fontSize = '11px';
tooltip.style.fontWeight = '600';
tooltip.style.pointerEvents = 'none';
tooltip.style.opacity = '0';
tooltip.style.transition = 'opacity 0.15s ease';
tooltip.style.zIndex = '9999';
tooltip.style.border = '1px solid #2c2c2e';
tooltip.style.boxShadow = '0 4px 10px rgba(0,0,0,0.15)';
document.body.appendChild(tooltip);

// --- 1. CORE FUNCTIONS: STATE & DUAL-INTERVAL CASCADE ---

// Load data on startup
async function init() {
  try {
    // Load active profile from main process
    try {
      activeProfile = await window.electronAPI.getActiveProfile();
      const switcher = document.getElementById('profile-switcher');
      if (switcher) switcher.value = activeProfile;
    } catch (e) {
      console.warn("Could not load active profile from main process:", e);
    }

    // Adapt UI layout based on active profile
    applyProfileCustomizations();

    // Load persisted Firebase URL from main process
    try {
      const savedFbUrl = await window.electronAPI.getFirebaseUrl();
      if (savedFbUrl) {
        localStorage.setItem('church_ledger_firebase_url', savedFbUrl);
        firebaseUrl = savedFbUrl;
      }
    } catch (e) {
      console.warn("Could not load Firebase URL from main process:", e);
    }
    // Show current church PIN status in sidebar
    try {
      const currentPin = await window.electronAPI.getChurchPin();
      const pinStatus = document.getElementById('church-pin-status');
      if (pinStatus && currentPin) {
        pinStatus.textContent = `Current PIN: ${'•'.repeat(currentPin.length)} (${currentPin.length} digits)`;
        pinStatus.style.color = '#f0c040';
      }
    } catch(e) {}
    db = await window.electronAPI.loadData();
    db.loansAndDeposits = db.loansAndDeposits || [];
    
    // Normalization: Ensure payments array and synthesize default payment if paidAmount > 0
    db.loansAndDeposits.forEach(loan => {
      if (!loan.payments) {
        loan.payments = [];
      }
      if (loan.paidAmount > 0 && loan.payments.length === 0) {
        loan.payments.push({
          id: 'pay_default_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
          amount: parseFloat(loan.paidAmount) || 0,
          date: '2025-12-01'
        });
      }
    });

    // Initialize Theme (Default: Dark Theme)
    initTheme();

    recalculateLedger();
    updateTitheAutocompleteDatalists();
    setupEventListeners();
    switchView('dashboard');
    initMobileAccessPanel();
    refreshPersonalProfiles();
    pollAdminRequests();
    setInterval(refreshPersonalProfiles, 15000);
    setInterval(pollAdminRequests, 10000);
  } catch (err) {
    console.error('Failed to load application data:', err);
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('church_ledger_theme') || 'dark';
  applyTheme(savedTheme);

  const themeBtn = document.getElementById('btn-theme-toggle');
  if (themeBtn) {
    themeBtn.onclick = toggleTheme;
  }
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark-theme') || document.body.classList.contains('dark-theme');
  const next = isDark ? 'light' : 'dark';
  applyTheme(next);
  if (typeof renderDashboard === 'function' && currentView === 'dashboard') {
    try { renderDashboard(); } catch (e) {}
  }
}
window.toggleTheme = toggleTheme;

function applyTheme(theme) {
  const icon = document.getElementById('theme-icon');
  const text = document.getElementById('theme-text');
  if (theme === 'dark') {
    document.documentElement.classList.add('dark-theme');
    document.body.classList.add('dark-theme');
    localStorage.setItem('church_ledger_theme', 'dark');
    if (icon) icon.textContent = '🌙';
    if (text) text.textContent = 'Dark';
  } else {
    document.documentElement.classList.remove('dark-theme');
    document.body.classList.remove('dark-theme');
    localStorage.setItem('church_ledger_theme', 'light');
    if (icon) icon.textContent = '☀️';
    if (text) text.textContent = 'Light';
  }
}

// Apply theme immediately on script load
try { initTheme(); } catch (e) {}

function applyProfileCustomizations() {
  const isPersonal = activeProfile === 'personal';
  
  // 1. Update Titlebar Text
  const titleEl = document.querySelector('.app-title');
  if (titleEl) {
    titleEl.textContent = isPersonal ? 'PERSONAL WEALTH & ASSETS VAULT' : 'CHURCH LEDGER & REAL ESTATE VAULT';
  }
  document.title = isPersonal ? 'Personal Wealth & Assets Vault' : 'Church Administration & Real Estate Ledger';
  
  // 2. Hide Room Tenants and Governance tabs in sidebar if personal
  const tenantsTab = document.querySelector('.nav-item[data-view="tenants"]');
  const govTab = document.querySelector('.nav-item[data-view="governance"]');
  if (tenantsTab) tenantsTab.style.display = isPersonal ? 'none' : 'flex';
  if (govTab) govTab.style.display = isPersonal ? 'none' : 'flex';
  
  // Update sidebar section title
  const sidebarSectionTitle = document.querySelector('.nav-section-title');
  if (sidebarSectionTitle) {
    sidebarSectionTitle.textContent = isPersonal ? 'PERSONAL LEDGER' : 'COMMAND CENTER';
  }
  
  // 3. Update dashboard labels
  const globalBalanceMeta = document.querySelector('.telemetry-grid .telemetry-card:nth-child(1) .card-meta');
  if (globalBalanceMeta) {
    globalBalanceMeta.textContent = isPersonal ? 'GLOBAL NET WORTH' : 'GLOBAL VAULT BALANCE';
  }
  const globalBalanceDesc = document.querySelector('.telemetry-grid .telemetry-card:nth-child(1) .card-desc');
  if (globalBalanceDesc) {
    globalBalanceDesc.textContent = isPersonal ? 'Total net worth separated by liquidity.' : 'Total Net Capital separated by liquidity.';
  }
  const liquidSubLabel = document.querySelector('.telemetry-grid .telemetry-card:nth-child(1) .sub-label');
  if (liquidSubLabel) {
    liquidSubLabel.textContent = isPersonal ? 'Liquid Cash / Assets' : 'Spendable Liquid Assets';
  }
  const fixedSubLabel = document.querySelector('.telemetry-grid .telemetry-card:nth-child(1) .fixed-reserves .sub-label');
  if (fixedSubLabel) {
    fixedSubLabel.textContent = isPersonal ? 'Fixed Deposits / Reserves' : 'Permanent Fixed Reserves';
  }
  
  // collections card
  const collCard = document.querySelector('.telemetry-grid .telemetry-card:nth-child(2)');
  if (collCard) {
    const collMeta = collCard.querySelector('.card-meta');
    if (collMeta) collMeta.textContent = isPersonal ? 'CUMULATIVE INCOME / INFLOW' : 'CUMULATIVE SUNDAY COLLECTIONS';
    const collDesc = collCard.querySelector('.card-desc');
    if (collDesc) collDesc.textContent = isPersonal ? 'Total personal earnings and cash inflows.' : 'Tithes and General Offerings';
  }
  
  // estate yield card (hide for personal)
  const estateCard = document.querySelector('.telemetry-grid .telemetry-card:nth-child(3)');
  if (estateCard) {
    estateCard.style.display = isPersonal ? 'none' : 'block';
  }
  
  // expenses card
  const expCard = document.querySelector('.telemetry-grid .telemetry-card:nth-child(4)');
  if (expCard) {
    const expMeta = expCard.querySelector('.card-meta');
    if (expMeta) expMeta.textContent = isPersonal ? 'TOTAL OUTFLOWS / EXPENSES' : 'TOTAL OPERATING EXPENSES';
    const expDesc = expCard.querySelector('.card-desc');
    if (expDesc) expDesc.textContent = isPersonal ? 'Personal spendings and cash outlays.' : 'Facility Costs and Operational Outgoings';
  }

  // Update Master Ledger Grid view tab text in sidebar
  const gridTab = document.querySelector('.nav-item[data-view="grid"]');
  if (gridTab) {
    gridTab.innerHTML = isPersonal ? 
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg> Daily Cash Ledger` : 
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg> Master Ledger Grid`;
  }
}

// ─── Mobile Access Panel (QR Code + URL) ────────────────────────────────
async function initMobileAccessPanel() {
  try {
    // Listen for server info pushed from main process
    window.electronAPI.onServerInfoReady((info) => {
      showMobilePanel(info);
    });

    // Retry polling — server may take a moment to start and generate QR
    let retries = 0;
    const maxRetries = 8;
    const tryGetInfo = async () => {
      try {
        const info = await window.electronAPI.getServerInfo();
        if (info && info.ip && info.qrDataUrl) {
          showMobilePanel(info);
          return;
        }
      } catch (e) { /* ignore */ }
      retries++;
      if (retries < maxRetries) {
        setTimeout(tryGetInfo, 2000);
      }
    };
    tryGetInfo();

    // Listen for data changes from phone — reload everything
    window.electronAPI.onRemoteDataUpdated(async () => {
      try {
        db = await window.electronAPI.loadData();
        recalculateLedger();
        renderGrid();
        renderRoster();
        renderGovernance();
        renderDashboard();
      } catch (err) {
        console.error('Remote data refresh failed:', err);
      }
    });

    // Listen for personal data updates from mobile phones
    window.electronAPI.onPersonalDataUpdated(() => {
      refreshPersonalProfiles();
    });

    // Listen for admin request alerts from mobile phones
    window.electronAPI.onAdminRequest((req) => {
      new Notification('Admin Device Request', {
        body: `${req.name || 'Unknown Device'} is requesting admin access.`,
        icon: 'mobile/icon-192.png'
      });
      pollAdminRequests();
    });

    window.electronAPI.onAdminRequestsUpdated(() => {
      pollAdminRequests();
    });
  } catch (err) {
    console.error('Mobile panel init error:', err);
  }
}

function showMobilePanel(info) {
  mobileServerInfo = info;
  const panel = document.getElementById('mobile-access-panel');
  const qrImg = document.getElementById('qr-code-img');
  const urlField = document.getElementById('server-url-display');
  const copyBtn = document.getElementById('btn-copy-url');
  if (!panel || !info || !info.ip) return;

  const url = info.url || `http://${info.ip}:${info.port}`;
  if (info.qrDataUrl) {
    qrImg.src = info.qrDataUrl;
  }
  urlField.value = url;
  panel.style.display = 'block';

  // Pre-populate Firebase URL field if saved
  const fbInput = document.getElementById('firebase-url-input');
  if (fbInput) fbInput.value = localStorage.getItem('church_ledger_firebase_url') || 'https://church-ledger-e11f1-default-rtdb.asia-southeast1.firebasedatabase.app';

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => {
        copyBtn.title = 'Copied!';
        setTimeout(() => { copyBtn.title = 'Copy URL'; }, 2000);
      });
    });
  }
}

function saveFirebaseUrl() {
  const input = document.getElementById('firebase-url-input');
  const status = document.getElementById('firebase-url-status');
  const url = (input ? input.value : '').trim().replace(/\/$/, '');
  if (!url) {
    localStorage.removeItem('church_ledger_firebase_url');
    try { window.electronAPI.setFirebaseUrl(''); } catch (e) {}
    if (status) { status.textContent = 'Cloud sync disabled.'; status.style.color = '#56566a'; }
    return;
  }
  localStorage.setItem('church_ledger_firebase_url', url);
  try { window.electronAPI.setFirebaseUrl(url); } catch (e) {}
  if (status) { status.textContent = 'Saved! Syncing on next save…'; status.style.color = '#4ecb71'; }
  // Test push
  fetch(`${url}/data.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(db || {})
  }).then(r => {
    if (status) { status.textContent = r.ok ? '✓ Connected & synced!' : '⚠ Saved but push failed'; status.style.color = r.ok ? '#4ecb71' : '#ff9f0a'; }
  }).catch(() => {
    if (status) { status.textContent = '⚠ URL saved, but no internet now'; status.style.color = '#ff9f0a'; }
  });
}

async function saveChurchPin() {
  const input = document.getElementById('church-pin-input');
  const status = document.getElementById('church-pin-status');
  const pin = (input ? input.value : '').trim();
  if (!pin) { if (status) { status.textContent = 'Enter a PIN first.'; status.style.color = '#ff6b6b'; } return; }
  if (!/^\d{4,8}$/.test(pin)) { if (status) { status.textContent = 'PIN must be 4–8 digits.'; status.style.color = '#ff6b6b'; } return; }
  try {
    await window.electronAPI.setChurchPin(pin);
    if (status) { status.textContent = `✓ PIN set to ${pin}. Synced to Firebase.`; status.style.color = '#f0c040'; }
    if (input) input.value = '';
    setTimeout(() => { if (status) { status.textContent = ''; } }, 4000);
  } catch (e) {
    if (status) { status.textContent = 'Error saving PIN.'; status.style.color = '#ff6b6b'; }
  }
}

async function refreshPersonalProfiles() {
  const container = document.getElementById('personal-profiles-list');
  if (!container) return;
  container.innerHTML = '<span style="color:#7c7cff;">Loading…</span>';
  try {
    // Try local server first
    let profiles = null;
    const serverUrl = mobileServerInfo && mobileServerInfo.url ? mobileServerInfo.url : null;
    if (serverUrl) {
      try {
        const resp = await fetch(`${serverUrl}/api/personal`, { signal: AbortSignal.timeout(4000) });
        if (resp.ok) profiles = await resp.json();
      } catch(e) {}
    }
    // Try IPC (local files)
    if (!profiles || Object.keys(profiles).length === 0) {
      profiles = await window.electronAPI.getAllPersonalProfiles();
    }
    // Try Firebase
    const fbUrl = localStorage.getItem('church_ledger_firebase_url');
    if ((!profiles || Object.keys(profiles).length === 0) && fbUrl) {
      try {
        const resp = await fetch(`${fbUrl}/personal.json`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const raw = await resp.json();
          if (raw) {
            profiles = {};
            Object.keys(raw).forEach(devId => { profiles[devId] = raw[devId]; });
          }
        }
      } catch(e) {}
    }
    // Merge from Firebase even if we already have local profiles
    if (profiles && fbUrl) {
      try {
        const resp = await fetch(`${fbUrl}/personal.json`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const raw = await resp.json();
          if (raw) {
            Object.keys(raw).forEach(devId => {
              if (!profiles[devId]) profiles[devId] = raw[devId];
            });
          }
        }
      } catch(e) {}
    }
    if (!profiles || Object.keys(profiles).length === 0) {
      container.innerHTML = '<span style="color:#56566a;">No personal profiles yet.<br>Each phone creates its own on first launch.</span>';
      return;
    }
    // Cache any Firebase-fetched profiles locally
    for (const [devId, record] of Object.entries(profiles)) {
      try {
        if (record && (record.name || record.data)) {
          await window.electronAPI.savePersonalProfile(devId, record);
        }
      } catch(e) {}
    }
    const cards = Object.entries(profiles).map(([devId, record]) => {
      const name = record.name || devId;
      const data = record.data || {};
      const weeks = data.weeks || {};
      let totalIn = 0, totalOut = 0;
      Object.values(weeks).forEach(w => {
        totalIn += parseFloat(w.offering) || 0;
        if (w.outgoings) w.outgoings.forEach(o => totalOut += parseFloat(o.amount) || 0);
      });
      const net = totalIn - totalOut;
      const netColor = net >= 0 ? '#4ecb71' : '#ff453a';
      return `<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;margin-bottom:6px;">
        <div style="font-weight:700;color:#f0f0f5;font-size:10px;">👤 ${escHtml(name)}</div>
        <div style="color:#56566a;font-size:8px;margin-top:2px;">In: Rs ${totalIn.toFixed(2)} · Out: Rs ${totalOut.toFixed(2)}</div>
        <div style="color:${netColor};font-size:9px;font-weight:700;margin-top:2px;">Net: Rs ${Math.abs(net).toFixed(2)} ${net >= 0 ? '▲' : '▼'}</div>
      </div>`;
    }).join('');
    container.innerHTML = cards;
  } catch (err) {
    container.innerHTML = `<span style="color:#ff6b6b;">Error: ${err.message}</span>`;
  }
}

async function pollAdminRequests() {
  const section = document.getElementById('admin-requests-section');
  const container = document.getElementById('admin-requests-list');
  if (!container) return;
  try {
    let requests = await window.electronAPI.getPendingAdminRequests();
    // Also check Firebase for pending requests
    const fbUrl = localStorage.getItem('church_ledger_firebase_url');
    if (fbUrl) {
      try {
        const resp = await fetch(`${fbUrl}/admin_requests.json`, { signal: AbortSignal.timeout(4000) });
        if (resp.ok) {
          const raw = await resp.json();
          if (raw) {
            Object.entries(raw).forEach(([devId, data]) => {
              if (data && data.status === 'pending' && !requests[devId]) {
                requests[devId] = data;
              }
            });
          }
        }
      } catch(e) {}
    }
    const pending = Object.entries(requests || {}).filter(([, v]) => v.status === 'pending');
    if (section) section.style.display = pending.length > 0 ? 'block' : 'none';
    if (pending.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = pending.map(([devId, req]) => {
      const name = escHtml(req.name || devId);
      const time = req.timestamp ? new Date(req.timestamp).toLocaleTimeString() : '';
      return `<div style="background:rgba(255,159,10,0.08);border:1px solid rgba(255,159,10,0.2);border-radius:8px;padding:8px;margin-bottom:6px;">
        <div style="font-weight:700;color:#f0f0f5;font-size:10px;">📱 ${name}</div>
        ${time ? `<div style="color:#56566a;font-size:8px;margin-top:2px;">🕐 ${time}</div>` : ''}
        <div style="display:flex;gap:4px;margin-top:6px;">
          <button onclick="approveAdminRequest('${escHtml(devId)}')" style="flex:1;background:rgba(78,203,113,0.2);border:1px solid rgba(78,203,113,0.3);border-radius:5px;color:#4ecb71;font-size:9px;font-weight:700;padding:4px;cursor:pointer;">✓ Approve</button>
          <button onclick="denyAdminRequest('${escHtml(devId)}')" style="flex:1;background:rgba(255,69,58,0.15);border:1px solid rgba(255,69,58,0.3);border-radius:5px;color:#ff453a;font-size:9px;font-weight:700;padding:4px;cursor:pointer;">✗ Deny</button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Admin requests poll error:', err);
  }
}

async function approveAdminRequest(deviceId) {
  try {
    await window.electronAPI.setAdminRequestStatus(deviceId, 'approved');
    pollAdminRequests();
  } catch(e) { console.error('Approve error:', e); }
}

async function denyAdminRequest(deviceId) {
  try {
    await window.electronAPI.setAdminRequestStatus(deviceId, 'denied');
    pollAdminRequests();
  } catch(e) { console.error('Deny error:', e); }
}

function escHtml(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Convert date YYYY-MM-DD to Monthly Key YYYY-MM
function getMonthKey(dateStr) {
  return dateStr.substring(0, 7);
}

// Recalculate Delta, Rolling Balance and accumulate Metrics
function recalculateLedger() {
  const keys = Object.keys(db.weeks).sort();
  let rollingBalance = 0;
  let totalCollections = 0;
  let totalRentYield = 0;
  let totalExpenses = 0;

  // 1. Reset and calculate overall gross rent yield from months
  Object.keys(db.months).forEach(mKey => {
    const monthData = db.months[mKey];
    if (monthData && monthData.tenants) {
      Object.keys(monthData.tenants).forEach(tId => {
        const t = monthData.tenants[tId];
        if (t && t.paid) {
          totalRentYield += parseFloat(t.amount) || 0;
        }
      });
    }
  });

  // Calculate Fixed Deposits
  let totalFixedDeposits = 0;
  if (db.fixedDeposits && Array.isArray(db.fixedDeposits)) {
    db.fixedDeposits.forEach(fd => {
      totalFixedDeposits += parseFloat(fd.principal) || 0;
    });
  }

  const firstSundays = {};
  keys.forEach(dateKey => {
    const mKey = dateKey.substring(0, 7);
    if (!firstSundays[mKey]) firstSundays[mKey] = dateKey;
  });

  // 2. Iterate weekly Sunday cycles chronologically
  let currentMonth = '';
  let monthlyRunningSum = 0;

  keys.forEach(dateKey => {
    const w = db.weeks[dateKey];
    const mKey = dateKey.substring(0, 7);

    if (mKey !== currentMonth) {
      currentMonth = mKey;
      monthlyRunningSum = 0;
    }
    
    // Recalculate offering if breakdown is enabled
    if (w.collectionsBreakdown && w.collectionsBreakdown.hasBreakdown) {
      let cashTotal = 0;
      if (w.collectionsBreakdown.denominations) {
        Object.keys(w.collectionsBreakdown.denominations).forEach(denom => {
          const count = parseInt(w.collectionsBreakdown.denominations[denom]) || 0;
          cashTotal += parseInt(denom) * count;
        });
      }
      let chequeTotal = 0;
      if (w.collectionsBreakdown.cheques) {
        w.collectionsBreakdown.cheques.forEach(ch => {
          chequeTotal += parseFloat(ch.amount) || 0;
        });
      }
      w.offering = cashTotal + chequeTotal;
    }

    // Inflow 1: General Weekly Offerings
    const offering = parseFloat(w.offering) || 0;
    totalCollections += offering;

    // Inflow 2: Rental Income credited to this specific Sunday Date
    let weekRentInflow = 0;
    Object.keys(db.months).forEach(mk => {
      const monthData = db.months[mk];
      if (monthData && monthData.tenants) {
        Object.keys(monthData.tenants).forEach(tId => {
          const t = monthData.tenants[tId];
          if (t && t.paid && t.paymentDate) {
            // Find the closest upcoming Sunday for this paymentDate
            const dates = Object.keys(db.weeks).sort();
            let assignedSunday = dates[dates.length - 1]; // default to last
            for (let i = 0; i < dates.length; i++) {
              if (dates[i] >= t.paymentDate) {
                assignedSunday = dates[i];
                break;
              }
            }
            if (assignedSunday === dateKey) {
              weekRentInflow += parseFloat(t.amount) || 0;
            }
          }
        });
      }
    });
    w.calculatedRental = weekRentInflow; // Cache the Sunday rental allocation

    // Apply Override if exists
    let activeRentInflow = w.rentalOverride !== undefined ? parseFloat(w.rentalOverride) : weekRentInflow;

    // Inflow 3: Custom Inflow columns
    let weekCustomInflows = 0;
    db.settings.columns.forEach(col => {
      if (col.type === 'inflow' && w.customCells && w.customCells[col.id]) {
        weekCustomInflows += parseFloat(w.customCells[col.id]) || 0;
      }
    });

    const totalInflow = offering + activeRentInflow + weekCustomInflows;

    // Outflow 1: Logged Outgoings/Expenses
    let weekExpenses = 0;
    if (w.outgoings && Array.isArray(w.outgoings)) {
      w.outgoings.forEach(exp => {
        weekExpenses += parseFloat(exp.amount) || 0;
      });
    }

    // Outflow 2: Custom Outflow columns
    let weekCustomOutflows = 0;
    db.settings.columns.forEach(col => {
      if (col.type === 'outflow' && w.customCells && w.customCells[col.id]) {
        weekCustomOutflows += parseFloat(w.customCells[col.id]) || 0;
      }
    });

    // Outflow 3: Landlord Rent
    let landlordRent = 0;
    if (firstSundays[mKey] === dateKey && db.landlordLease && db.landlordLease.months) {
      landlordRent = parseFloat(db.landlordLease.months[mKey]) || 0;
    }
    w.calculatedLandlordRent = landlordRent;

    // Outflow 4: Loan & Deposit Payments (Agreement Payments)
    let weekLoanOutflow = 0;
    if (db.loansAndDeposits && Array.isArray(db.loansAndDeposits)) {
      db.loansAndDeposits.forEach(loan => {
        if (loan.payments && Array.isArray(loan.payments)) {
          loan.payments.forEach(payment => {
            if (payment.date && payment.date >= keys[0]) {
              // Find the closest upcoming Sunday for this payment.date
              let assignedSunday = keys[keys.length - 1]; // default to last
              for (let i = 0; i < keys.length; i++) {
                if (keys[i] >= payment.date) {
                  assignedSunday = keys[i];
                  break;
                }
              }
              if (assignedSunday === dateKey) {
                weekLoanOutflow += parseFloat(payment.amount) || 0;
              }
            }
          });
        }
      });
    }
    w.calculatedLoanOutflow = weekLoanOutflow;

    const totalOutflow = weekExpenses + weekCustomOutflows + landlordRent + weekLoanOutflow;
    totalExpenses += totalOutflow;

    // Delta & Rolling Balance & Monthly Running Sum
    const delta = totalInflow - totalOutflow;
    rollingBalance += delta;
    monthlyRunningSum += delta;

    // Cache values in week structure
    w.calculatedDelta = delta;
    w.calculatedBalance = rollingBalance;
    w.calculatedMonthlyBalance = monthlyRunningSum;
  });

  // Save to db metrics property
  const liquidAssets = rollingBalance - totalFixedDeposits;
  db.metrics = {
    vaultBalance: rollingBalance,
    liquidAssets: liquidAssets,
    fixedReserves: totalFixedDeposits,
    sundayCollections: totalCollections,
    estateYield: totalRentYield,
    operatingLosses: totalExpenses
  };

  // Sync with main process database file
  window.electronAPI.saveData(db);

  // Firebase cloud sync (fire-and-forget) — push to cloud if URL is configured
  const fbUrl = localStorage.getItem('church_ledger_firebase_url');
  if (fbUrl) {
    fetch(`${fbUrl.replace(/\/$/, '')}/data.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(db)
    }).catch(() => { /* silent — offline or misconfigured */ });
  }

  // Update UI Elements
  updateTelemetryUI();
}


// Update the 4 core KPI cards
function updateTelemetryUI(metricsObj = db.metrics) {
  metricLiquidAssets.textContent = formatCurrency(metricsObj.liquidAssets);
  metricFixedReserves.textContent = formatCurrency(metricsObj.fixedReserves);
  metricSundayCollections.textContent = formatCurrency(metricsObj.sundayCollections);
  metricEstateYield.textContent = formatCurrency(metricsObj.estateYield);
  metricOperatingLosses.textContent = formatCurrency(metricsObj.operatingLosses);
  
  if (metricsObj.liquidAssets < 0) {
    metricLiquidAssets.style.color = 'var(--apple-red-solid)';
  } else {
    metricLiquidAssets.style.color = 'var(--velvet-black)';
  }
}

// Format number to local Currency representation
function formatCurrency(val) {
  return new Intl.NumberFormat('en-LK', {
    style: 'currency',
    currency: 'LKR'
  }).format(val);
}

// Crawl database for unique names and categories in designated funds to build datalist auto-completes
function updateTitheAutocompleteDatalists() {
  const names = new Set();
  const categories = new Set(["Tithe", "Special Offering", "Building Fund", "Missions", "Welfare", "Sunday School"]); // default suggestions
  
  if (db && db.weeks) {
    Object.keys(db.weeks).forEach(dateKey => {
      const w = db.weeks[dateKey];
      if (w.collectionsBreakdown && w.collectionsBreakdown.designatedFunds) {
        w.collectionsBreakdown.designatedFunds.forEach(fund => {
          if (fund.description) names.add(fund.description.trim());
          if (fund.category) categories.add(fund.category.trim());
        });
      }
    });
  }

  // Generate names datalist
  let nameDatalist = document.getElementById('datalist-tithe-names');
  if (!nameDatalist) {
    nameDatalist = document.createElement('datalist');
    nameDatalist.id = 'datalist-tithe-names';
    document.body.appendChild(nameDatalist);
  }
  nameDatalist.innerHTML = '';
  Array.from(names).sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    nameDatalist.appendChild(opt);
  });

  // Generate categories datalist
  let catDatalist = document.getElementById('datalist-tithe-categories');
  if (!catDatalist) {
    catDatalist = document.createElement('datalist');
    catDatalist.id = 'datalist-tithe-categories';
    document.body.appendChild(catDatalist);
  }
  catDatalist.innerHTML = '';
  Array.from(categories).sort().forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    catDatalist.appendChild(opt);
  });
}

// --- 2. NAVIGATION & VIEWS ---

function switchView(viewName) {
  currentView = viewName;
  
  // Update sidebar active states
  const allNavItems = document.querySelectorAll('.nav-item');
  allNavItems.forEach(item => {
    if (item.getAttribute('data-view') === viewName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Toggle View Panes
  const allViews = {
    dashboard: document.getElementById('view-dashboard'),
    grid: document.getElementById('view-grid'),
    tenants: document.getElementById('view-tenants'),
    governance: document.getElementById('view-governance')
  };
  Object.keys(allViews).forEach(key => {
    if (allViews[key]) {
      if (key === viewName) {
        allViews[key].classList.add('active');
      } else {
        allViews[key].classList.remove('active');
      }
    }
  });

  // Render content
  if (viewName === 'dashboard') {
    renderDashboard();
  } else if (viewName === 'governance') {
    renderGovernance();
  } else if (viewName === 'grid') {
    renderGrid();
  } else if (viewName === 'tenants') {
    renderTenants();
  }
}

// --- 3. VIEW 1: DASHBOARD ANALYTICS ---

function renderDashboard() {
  filterMetrics();
}

function drawChart(weeksData = db.weeks) {
  const container = document.getElementById('dashboard-chart-container');
  const svg = document.getElementById('dashboard-svg-chart');
  svg.innerHTML = ''; // Clear previous

  const sortedDates = Object.keys(weeksData).sort();
  if (sortedDates.length === 0) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--apple-secondary)">No ledger data available to plot charts.</text>`;
    return;
  }

  // Get dimensions dynamically
  const rects = container.getBoundingClientRect();
  const width = rects.width || 800;
  const height = 320;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const padding = { top: 30, right: 30, bottom: 45, left: 65 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  // Process data points: map each Sunday to inflow/outflow
  const dataPoints = sortedDates.map(dateKey => {
    const w = weeksData[dateKey];
    
    // Inflow
    const offering = parseFloat(w.offering) || 0;
    const rent = parseFloat(w.calculatedRental) || 0;
    let customInflow = 0;
    db.settings.columns.forEach(col => {
      if (col.type === 'inflow' && w.customCells && w.customCells[col.id]) {
        customInflow += parseFloat(w.customCells[col.id]) || 0;
      }
    });
    const inflow = offering + rent + customInflow;

    // Outflow
    let expenses = 0;
    if (w.outgoings) w.outgoings.forEach(e => expenses += parseFloat(e.amount) || 0);
    let customOutflow = 0;
    db.settings.columns.forEach(col => {
      if (col.type === 'outflow' && w.customCells && w.customCells[col.id]) {
        customOutflow += parseFloat(w.customCells[col.id]) || 0;
      }
    });
    const outflow = expenses + customOutflow;

    return {
      date: dateKey,
      inflow: inflow,
      outflow: outflow
    };
  });

  const maxVal = Math.max(...dataPoints.map(d => Math.max(d.inflow, d.outflow)), 1000) * 1.1; // 10% headroom

  // 1. Draw horizontal gridlines (Y-axis)
  const numGridLines = 4;
  for (let i = 0; i <= numGridLines; i++) {
    const yVal = (maxVal / numGridLines) * i;
    const yCoor = height - padding.bottom - (yVal / maxVal) * plotHeight;
    
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padding.left);
    line.setAttribute('y1', yCoor);
    line.setAttribute('x2', width - padding.right);
    line.setAttribute('y2', yCoor);
    line.setAttribute('class', 'chart-grid-line');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', padding.left - 12);
    text.setAttribute('y', yCoor + 4);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('class', 'chart-label');
    text.textContent = formatCompactCurrency(yVal);
    svg.appendChild(text);
  }

  // 2. Plot X-axis ticks (months)
  let lastMonth = '';
  dataPoints.forEach((d, idx) => {
    const xCoor = padding.left + (idx / (dataPoints.length - 1 || 1)) * plotWidth;
    const dateObj = new Date(d.date + 'T00:00:00');
    const monthName = dateObj.toLocaleString('default', { month: 'short' });
    
    if (monthName !== lastMonth || idx === 0) {
      lastMonth = monthName;
      
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', xCoor);
      tick.setAttribute('y1', height - padding.bottom);
      tick.setAttribute('x2', xCoor);
      tick.setAttribute('y2', height - padding.bottom + 5);
      tick.setAttribute('class', 'chart-axis-line');
      svg.appendChild(tick);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', xCoor);
      text.setAttribute('y', height - padding.bottom + 20);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('class', 'chart-label');
      text.textContent = `${monthName} '${String(dateObj.getFullYear()).substring(2)}`;
      svg.appendChild(text);
    }
  });

  const xAxis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xAxis.setAttribute('x1', padding.left);
  xAxis.setAttribute('y1', height - padding.bottom);
  xAxis.setAttribute('x2', width - padding.right);
  xAxis.setAttribute('y2', height - padding.bottom);
  xAxis.setAttribute('class', 'chart-axis-line');
  svg.appendChild(xAxis);

  // 3. Draw Expense Bars (Outflows)
  const barWidth = Math.max(3, (plotWidth / dataPoints.length) * 0.4);
  dataPoints.forEach((d, idx) => {
    const xCoor = padding.left + (idx / (dataPoints.length - 1 || 1)) * plotWidth;
    const barHeight = (d.outflow / maxVal) * plotHeight;
    const yCoor = height - padding.bottom - barHeight;

    if (d.outflow > 0) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', xCoor - barWidth / 2);
      rect.setAttribute('y', yCoor);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', barHeight);
      rect.setAttribute('class', 'chart-bar-expense');
      
      rect.addEventListener('mouseover', (e) => showChartTooltip(e, d));
      rect.addEventListener('mousemove', moveChartTooltip);
      rect.addEventListener('mouseout', hideChartTooltip);
      svg.appendChild(rect);
    }
  });

  // 4. Draw Revenue Curve (Inflows)
  let pathD = '';
  dataPoints.forEach((d, idx) => {
    const xCoor = padding.left + (idx / (dataPoints.length - 1 || 1)) * plotWidth;
    const yCoor = height - padding.bottom - (d.inflow / maxVal) * plotHeight;
    
    if (idx === 0) {
      pathD += `M ${xCoor} ${yCoor}`;
    } else {
      pathD += ` L ${xCoor} ${yCoor}`;
    }
  });

  const revenuePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  revenuePath.setAttribute('d', pathD);
  revenuePath.setAttribute('class', 'chart-path-revenue');
  svg.appendChild(revenuePath);

  // 5. Draw Dots over Revenue line
  dataPoints.forEach((d, idx) => {
    const xCoor = padding.left + (idx / (dataPoints.length - 1 || 1)) * plotWidth;
    const yCoor = height - padding.bottom - (d.inflow / maxVal) * plotHeight;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', xCoor);
    circle.setAttribute('cy', yCoor);
    circle.setAttribute('r', '4');
    circle.setAttribute('class', 'chart-dot-revenue');

    circle.addEventListener('mouseover', (e) => showChartTooltip(e, d));
    circle.addEventListener('mousemove', moveChartTooltip);
    circle.addEventListener('mouseout', hideChartTooltip);
    svg.appendChild(circle);
  });
}

function formatCompactCurrency(val) {
  if (val >= 1000) {
    return 'Rs ' + (val / 1000).toFixed(1) + 'k';
  }
  return 'Rs ' + val.toFixed(0);
}

function showChartTooltip(e, data) {
  tooltip.style.opacity = '1';
  tooltip.innerHTML = `
    <div style="font-size:10px;color:var(--apple-secondary);margin-bottom:4px;">${data.date}</div>
    <div style="display:flex;justify-content:space-between;gap:12px;">
      <span style="color:#ffffff;">Inflow:</span>
      <span style="color:#ffffff;font-weight:700;">${formatCurrency(data.inflow)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;gap:12px;margin-top:2px;">
      <span style="color:var(--apple-secondary);">Outflow:</span>
      <span style="color:var(--apple-secondary);font-weight:700;">${formatCurrency(data.outflow)}</span>
    </div>
  `;
  moveChartTooltip(e);
}

function moveChartTooltip(e) {
  tooltip.style.left = (e.pageX + 15) + 'px';
  tooltip.style.top = (e.pageY - 20) + 'px';
}

function hideChartTooltip() {
  tooltip.style.opacity = '0';
}

// --- 4. VIEW 2: MASTER SPREADSHEET GRID WITH MONTHLY BRACKETS ---

function renderGrid() {
  // A. Build Dynamic headers from settings.columns
  gridHeaderRow.innerHTML = '';
  
  // Expand column
  const expandTh = document.createElement('th');
  expandTh.style.width = '40px';
  gridHeaderRow.appendChild(expandTh);

  db.settings.columns.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.setAttribute('data-col-id', col.id);
    if (col.editable) {
      th.classList.add('editable-header');
      th.addEventListener('dblclick', () => makeHeaderEditable(th, col.id));
      th.title = "Double-click to rename header";
    }
    gridHeaderRow.appendChild(th);
  });

  // Expenses header
  const isPersonal = activeProfile === 'personal';
  const expensesTh = document.createElement('th');
  expensesTh.textContent = isPersonal ? 'Expenses' : 'Weekly Expenses';
  gridHeaderRow.appendChild(expensesTh);

  // Delta & Balance columns
  const deltaTh = document.createElement('th');
  deltaTh.textContent = isPersonal ? 'Delta' : 'Weekly Delta';
  gridHeaderRow.appendChild(deltaTh);

  const monthlyBalanceTh = document.createElement('th');
  monthlyBalanceTh.textContent = isPersonal ? 'Monthly Savings' : 'Monthly Balance';
  gridHeaderRow.appendChild(monthlyBalanceTh);

  const balanceTh = document.createElement('th');
  balanceTh.textContent = 'Rolling Balance';
  gridHeaderRow.appendChild(balanceTh);

  // Action column
  const actionTh = document.createElement('th');
  actionTh.style.width = '60px';
  gridHeaderRow.appendChild(actionTh);

  // B. Render Rows Grouped under Monthly brackets
  gridBody.innerHTML = '';
  const fragment = document.createDocumentFragment();
  const sortedDates = Object.keys(db.weeks).sort();
  const query = gridSearch.value.trim().toLowerCase();
  
  let currentMonthName = '';

  sortedDates.forEach(dateKey => {
    const w = db.weeks[dateKey];
    
    // Filter / Search logic
    if (query) {
      const matchDate = dateKey.toLowerCase().includes(query);
      const matchOffering = String(w.offering).includes(query);
      let matchOutgoingDesc = false;
      if (w.outgoings) {
        w.outgoings.forEach(o => {
          if (o.description.toLowerCase().includes(query)) matchOutgoingDesc = true;
        });
      }
      if (!matchDate && !matchOffering && !matchOutgoingDesc) return;
    }

    // Determine Month title bracket
    const dateObj = new Date(dateKey + 'T00:00:00');
    const monthName = dateObj.toLocaleString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
    const mKey = getMonthKey(dateKey);

    // If Month shifts, render the Monthly Bracket Header Row!
    if (monthName !== currentMonthName) {
      currentMonthName = monthName;
      
      const bracketTr = document.createElement('tr');
      bracketTr.className = 'month-bracket-row';
      
      const totalColCount = db.settings.columns.length + 6; // expand + columns + expenses + delta + monthly + balance + action
      const bracketTd = document.createElement('td');
      bracketTd.colSpan = totalColCount;

      // Construct Bracket Container
      const bracketContainer = document.createElement('div');
      bracketContainer.className = 'month-bracket-container';

      // Title header
      const topDiv = document.createElement('div');
      topDiv.className = 'month-header-top';
      
      const titleSpan = document.createElement('span');
      titleSpan.className = 'month-title';
      titleSpan.textContent = monthName;
      topDiv.appendChild(titleSpan);
      bracketContainer.appendChild(topDiv);

      // Tenant Roster Panel
      const rosterDiv = document.createElement('div');
      rosterDiv.className = 'month-tenant-roster';

      // Query monthly data
      if (!db.months[mKey]) {
        db.months[mKey] = { tenants: {} };
      }

      // Populate default rooms in months if they are missing
      Object.keys(db.settings.tenantRates).forEach(tId => {
        if (!db.months[mKey].tenants[tId]) {
          db.months[mKey].tenants[tId] = {
            paid: false,
            paymentDate: dateKey, // defaults to the first Sunday of the month
            amount: 0.00,
            updatedAt: 0
          };
        }
      });

      // Loop through tenants
      Object.keys(db.settings.tenantRates).forEach(tId => {
        const tName = db.settings.tenantNames[tId] || tId;
        const baseRate = db.settings.tenantRates[tId] || 0.00;
        const tenantData = db.months[mKey].tenants[tId];

        const card = document.createElement('div');
        card.className = 'month-tenant-card';

        // Top row: Name + Base rate
        const info = document.createElement('div');
        info.className = 'month-tenant-info';
        
        const nameText = document.createElement('span');
        nameText.className = 'month-tenant-name';
        nameText.textContent = tName;
        info.appendChild(nameText);

        const rateText = document.createElement('span');
        rateText.className = 'month-tenant-rate';
        rateText.textContent = formatCurrency(baseRate);
        info.appendChild(rateText);
        card.appendChild(info);

        // Date picker dropdown
        const dateSelect = document.createElement('select');
        dateSelect.className = 'month-tenant-date-select';
        
        const yr = parseInt(mKey.split('-')[0]);
        const mo = parseInt(mKey.split('-')[1]);
        const daysInMonth = new Date(yr, mo, 0).getDate();
        
        const allDays = [];
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          allDays.push(dateStr);
          const opt = document.createElement('option');
          opt.value = dateStr;
          const dateObj = new Date(dateStr + 'T00:00:00');
          opt.textContent = dateObj.toLocaleString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
          dateSelect.appendChild(opt);
        }

        if (tenantData.paymentDate && allDays.includes(tenantData.paymentDate)) {
          dateSelect.value = tenantData.paymentDate;
        } else {
          dateSelect.value = allDays[0] || dateKey;
          tenantData.paymentDate = dateSelect.value;
        }

        dateSelect.disabled = !tenantData.paid;

        dateSelect.addEventListener('change', () => {
          tenantData.paymentDate = dateSelect.value;
          tenantData.updatedAt = Date.now();
          recalculateLedger();
          renderGrid();
        });

        // Controls container
        const controls = document.createElement('div');
        controls.className = 'month-tenant-controls';

        // Row 1: Amount + Toggle
        const row1 = document.createElement('div');
        row1.className = 'month-tenant-controls-row';

        const amountGroup = document.createElement('div');
        amountGroup.className = 'month-tenant-amount-group';
        const amountLabel = document.createElement('span');
        amountLabel.className = 'amt-label';
        amountLabel.textContent = 'Paid';

        const amountInput = document.createElement('input');
        amountInput.type = 'number';
        amountInput.placeholder = baseRate.toFixed(0);
        amountInput.value = tenantData.customAmount !== undefined ? tenantData.customAmount : (tenantData.paid ? tenantData.amount : '');
        amountInput.disabled = !tenantData.paid;
        
        amountInput.addEventListener('change', () => {
          const newAmt = parseFloat(amountInput.value);
          if (!isNaN(newAmt) && newAmt >= 0) {
            tenantData.customAmount = newAmt;
            tenantData.amount = newAmt;
            tenantData.updatedAt = Date.now();
            recalculateLedger();
          }
        });
        amountGroup.appendChild(amountLabel);
        amountGroup.appendChild(amountInput);

        // iOS Toggle
        const switchLabel = document.createElement('label');
        switchLabel.className = 'ios-switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = tenantData.paid;
        const slider = document.createElement('span');
        slider.className = 'ios-slider';

        input.addEventListener('change', () => {
          tenantData.updatedAt = Date.now();
          if (input.checked) {
            tenantData.paid = true;
            const effectiveAmount = tenantData.customAmount !== undefined ? tenantData.customAmount : baseRate;
            tenantData.amount = effectiveAmount;
            amountInput.value = effectiveAmount.toFixed(0);
            amountInput.disabled = false;
            tenantData.paymentDate = dateSelect.value;
            dateSelect.disabled = false;
          } else {
            tenantData.paid = false;
            tenantData.amount = 0.00;
            amountInput.disabled = true;
            dateSelect.disabled = true;
          }
          recalculateLedger();
          renderGrid();
        });

        switchLabel.appendChild(input);
        switchLabel.appendChild(slider);

        row1.appendChild(amountGroup);
        row1.appendChild(switchLabel);
        controls.appendChild(row1);

        // Row 2: Date picker (full width)
        controls.appendChild(dateSelect);

        card.appendChild(controls);
        rosterDiv.appendChild(card);
      });

      if (Object.keys(db.settings.tenantRates).length === 0) {
        rosterDiv.innerHTML = `<p style="font-size:11px;color:var(--apple-secondary);padding:6px 0;">No active commercial leases. Register rooms in 'Room Setup'.</p>`;
      }

      bracketContainer.appendChild(rosterDiv);
      bracketTd.appendChild(bracketContainer);
      bracketTr.appendChild(bracketTd);
      fragment.appendChild(bracketTr);
    }

    // C. Render Standard Sunday Rows
    const tr = document.createElement('tr');
    tr.setAttribute('data-date-key', dateKey);
    if (expandedRows.has(dateKey)) {
      tr.classList.add('expanded');
    }

    // Expand arrow cell
    const expandTd = document.createElement('td');
    const expandBtn = document.createElement('span');
    expandBtn.className = 'row-expander';
    expandBtn.innerHTML = '&#9654;';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleRowExpanded(dateKey);
    });
    expandTd.appendChild(expandBtn);
    tr.appendChild(expandTd);

    // Columns
    db.settings.columns.forEach(col => {
      const td = document.createElement('td');
      td.setAttribute('data-col-id', col.id);
      
      if (col.type === 'date') {
        td.textContent = w.label || dateKey;
        td.style.fontWeight = '600';
      } else if (col.type === 'number') {
        const val = parseFloat(w.offering) || 0;
        td.textContent = formatCurrency(val);
        td.classList.add('cell-editable');
        td.addEventListener('dblclick', () => makeCellEditable(td, dateKey, col.id, 'offering'));
      } else if (col.id === 'rentalRevenue') {
        // Rental revenue display (calculated read-only sum)
        const isOverridden = w.rentalOverride !== undefined;
        const val = isOverridden ? parseFloat(w.rentalOverride) : (parseFloat(w.calculatedRental) || 0);
        td.textContent = formatCurrency(val);
        td.style.color = val > 0 ? 'var(--apple-green-text)' : 'var(--apple-secondary)';
        td.style.fontWeight = val > 0 ? '700' : 'normal';

        if (isOverridden) {
          td.title = "Manually Overridden. Double-click and clear to revert to automatic calculation.";
          td.style.borderLeft = "2px solid var(--apple-blue)";
        } else {
          // Hover tooltip explaining which room payments hit today
          let hoverExplanation = [];
          Object.keys(db.months).forEach(mk => {
            if (mk === mKey) {
              Object.keys(db.months[mk].tenants).forEach(tId => {
                const t = db.months[mk].tenants[tId];
                if (t.paid && t.paymentDate === dateKey) {
                  hoverExplanation.push(`${db.settings.tenantNames[tId] || tId}: ${formatCurrency(t.amount)}`);
                }
              });
            }
          });
          td.title = hoverExplanation.length > 0 ? hoverExplanation.join('\n') : 'No room rents received on this date.';
        }
        
        td.classList.add('cell-editable');
        td.addEventListener('dblclick', () => makeCellEditable(td, dateKey, col.id, 'rentalOverride'));
      } else {
        // Custom Columns (inflow, outflow, text)
        let cellVal = '';
        if (w.customCells && w.customCells[col.id] !== undefined) {
          cellVal = w.customCells[col.id];
        }
        if (col.type === 'inflow' || col.type === 'outflow') {
          td.textContent = formatCurrency(parseFloat(cellVal) || 0);
        } else {
          td.textContent = cellVal;
        }
        td.classList.add('cell-editable');
        td.addEventListener('dblclick', () => makeCellEditable(td, dateKey, col.id, col.type));
      }
      tr.appendChild(td);
    });

    // Expenses cell (calculated total of itemized outgoings)
    const expTd = document.createElement('td');
    let weekExpSum = 0;
    if (w.outgoings) w.outgoings.forEach(e => weekExpSum += parseFloat(e.amount) || 0);
    expTd.textContent = formatCurrency(weekExpSum);
    expTd.style.color = weekExpSum > 0 ? 'var(--apple-red-solid)' : 'var(--apple-secondary)';
    tr.appendChild(expTd);

    // Delta cell
    const deltaTd = document.createElement('td');
    deltaTd.className = 'col-delta';
    const delta = w.calculatedDelta;
    deltaTd.textContent = formatCurrency(delta);
    if (delta > 0) {
      deltaTd.classList.add('delta-positive');
    } else if (delta < 0) {
      deltaTd.classList.add('delta-negative');
    }
    tr.appendChild(deltaTd);

    // Monthly Balance cell
    const monthlyBalanceTd = document.createElement('td');
    monthlyBalanceTd.className = 'col-monthly-balance';
    const mb = w.calculatedMonthlyBalance;
    monthlyBalanceTd.textContent = formatCurrency(mb);
    if (mb > 0) {
      monthlyBalanceTd.classList.add('delta-positive');
    } else if (mb < 0) {
      monthlyBalanceTd.classList.add('delta-negative');
    }
    tr.appendChild(monthlyBalanceTd);

    // Rolling Balance cell
    const balanceTd = document.createElement('td');
    balanceTd.className = 'col-balance';
    balanceTd.textContent = formatCurrency(w.calculatedBalance);
    tr.appendChild(balanceTd);

    // Row deletion actions (Delete row)
    const deleteTd = document.createElement('td');
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.style.padding = '3px 6px';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = "Delete Sunday row";
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete Sunday ${dateKey}? This row's offering and outgoings will be permanently removed.`)) {
        delete db.weeks[dateKey];
        recalculateLedger();
        renderGrid();
      }
    });
    deleteTd.appendChild(deleteBtn);
    tr.appendChild(deleteTd);

    fragment.appendChild(tr);

    // Render expanded sub-ledger if active
    if (expandedRows.has(dateKey)) {
      const subTr = document.createElement('tr');
      subTr.className = 'sub-ledger-row';
      const colSpanCount = db.settings.columns.length + 6;
      
      const subTd = document.createElement('td');
      subTd.colSpan = colSpanCount;
      subTd.appendChild(buildSubLedgerContainer(dateKey));
      
      subTr.appendChild(subTd);
      fragment.appendChild(subTr);
    }
  });

  // Attach all DOM nodes simultaneously for extreme performance
  gridBody.appendChild(fragment);

  // Restore active tab for all expanded sub-ledger rows
  expandedRows.forEach(dateKey => {
    const activeTab = expandedRowTab.get(dateKey) || 'collections';
    if (activeTab === 'expenses') {
      // Find the sub-ledger for this row and switch to expenses tab
      const subRows = gridBody.querySelectorAll('.sub-ledger-row');
      subRows.forEach(subRow => {
        const prevTr = subRow.previousElementSibling;
        if (prevTr && prevTr.getAttribute('data-date-key') === dateKey) {
          const expBtn = subRow.querySelector('.sub-tab-btn:nth-child(2)');
          const collBtn = subRow.querySelector('.sub-tab-btn:nth-child(1)');
          const collPane = subRow.querySelector('.collections-pane');
          const expPane = subRow.querySelector('.expenses-pane');
          if (expBtn && collBtn && collPane && expPane) {
            expBtn.classList.add('active');
            collBtn.classList.remove('active');
            collPane.style.display = 'none';
            expPane.style.display = 'flex';
          }
        }
      });
    }
  });
}

// Toggle Expanded Set
function toggleRowExpanded(dateKey) {
  if (expandedRows.has(dateKey)) {
    expandedRows.delete(dateKey);
  } else {
    expandedRows.add(dateKey);
  }
  renderGrid();
}

// Double click to rename column headers
function makeHeaderEditable(th, colId) {
  const currentLabel = th.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cell-editor';
  input.value = currentLabel;
  
  th.textContent = '';
  th.appendChild(input);
  input.focus();
  input.select();

  const saveHeader = () => {
    const val = input.value.trim();
    if (val && val !== currentLabel) {
      const colIndex = db.settings.columns.findIndex(c => c.id === colId);
      if (colIndex !== -1) {
        db.settings.columns[colIndex].label = val;
        recalculateLedger();
      }
    }
    renderGrid();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveHeader();
    if (e.key === 'Escape') renderGrid();
  });
  input.addEventListener('blur', saveHeader);
}

// Double click to edit cell inline
function makeCellEditable(td, dateKey, colId, type) {
  const w = db.weeks[dateKey];
  let initialValue = '';
  
  if (type === 'offering') {
    initialValue = w.offering;
  } else if (type === 'rentalOverride') {
    initialValue = w.rentalOverride !== undefined ? w.rentalOverride : w.calculatedRental;
  } else if (type === 'inflow' || type === 'outflow') {
    initialValue = (w.customCells && w.customCells[colId]) || 0.00;
  } else {
    initialValue = (w.customCells && w.customCells[colId]) || '';
  }

  const input = document.createElement('input');
  input.className = 'cell-editor';
  
  if (type === 'offering' || type === 'rentalOverride' || type === 'inflow' || type === 'outflow') {
    input.type = 'number';
    input.step = '0.01';
    input.value = type === 'rentalOverride' && w.rentalOverride === undefined ? '' : (parseFloat(initialValue) || 0);
  } else {
    input.type = 'text';
    input.value = initialValue;
  }

  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  const saveCell = () => {
    const inputVal = input.value.trim();
    
    if (type === 'offering') {
      w.offering = Math.max(0, parseFloat(inputVal) || 0);
    } else if (type === 'rentalOverride') {
      if (inputVal === '') {
        delete w.rentalOverride;
      } else {
        w.rentalOverride = Math.max(0, parseFloat(inputVal) || 0);
      }
    } else if (type === 'inflow' || type === 'outflow') {
      if (!w.customCells) w.customCells = {};
      w.customCells[colId] = Math.max(0, parseFloat(inputVal) || 0);
    } else {
      if (!w.customCells) w.customCells = {};
      w.customCells[colId] = inputVal;
    }

    recalculateLedger();
    renderGrid();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveCell();
    if (e.key === 'Escape') renderGrid();
  });
  input.addEventListener('blur', saveCell);
}

// --- 5. SUB-LEDGER DRAWER FACTORY ---

function buildSubLedgerContainer(dateKey) {
  const w = db.weeks[dateKey];

  // Initialize breakdown structure if missing
  if (!w.collectionsBreakdown) {
    w.collectionsBreakdown = {
      hasBreakdown: false,
      denominations: {
        "5000": 0, "2000": 0, "1000": 0, "500": 0, "100": 0, "50": 0, "20": 0
      },
      cheques: [],
      designatedFunds: []
    };
  } else {
    if (!w.collectionsBreakdown.denominations) {
      w.collectionsBreakdown.denominations = {
        "5000": 0, "2000": 0, "1000": 0, "500": 0, "100": 0, "50": 0, "20": 0
      };
    }
    if (!w.collectionsBreakdown.cheques) w.collectionsBreakdown.cheques = [];
    if (!w.collectionsBreakdown.designatedFunds) w.collectionsBreakdown.designatedFunds = [];
  }

  const container = document.createElement('div');
  container.className = 'sub-ledger-container';

  // 1. TABS HEADER
  const tabHeader = document.createElement('div');
  tabHeader.className = 'sub-ledger-tabs';

  const isPersonal = activeProfile === 'personal';
  const tabCollectionsBtn = document.createElement('button');
  tabCollectionsBtn.className = 'sub-tab-btn active';
  tabCollectionsBtn.textContent = isPersonal ? 'Income / Inflow Register' : 'Collections & Tithes Register';

  const tabExpensesBtn = document.createElement('button');
  tabExpensesBtn.className = 'sub-tab-btn';
  tabExpensesBtn.textContent = isPersonal ? 'Expenses Register' : 'Weekly Operational Expenses';

  tabHeader.appendChild(tabCollectionsBtn);
  tabHeader.appendChild(tabExpensesBtn);
  container.appendChild(tabHeader);

  // 2. TAB PANES CONTAINER
  const tabPanes = document.createElement('div');
  tabPanes.className = 'sub-ledger-panes';
  container.appendChild(tabPanes);

  // --- TAB A: COLLECTIONS BREAKDOWN PANE ---
  const paneCollections = document.createElement('div');
  paneCollections.className = 'sub-tab-pane collections-pane';
  paneCollections.style.display = 'flex'; // active by default
  tabPanes.appendChild(paneCollections);

  if (!w.collectionsBreakdown.hasBreakdown) {
    // Show prompt to convert manual entry
    const manualPrompt = document.createElement('div');
    manualPrompt.className = 'collections-manual-prompt';
    manualPrompt.innerHTML = `
      <p style="margin-bottom:10px;font-weight:600;color:var(--apple-secondary);">This Sunday is currently using manual offering entry.</p>
      <div style="font-size:16px;font-weight:700;margin-bottom:16px;">Current Offering: ${formatCurrency(parseFloat(w.offering) || 0)}</div>
      <button class="btn btn-primary btn-enable-breakdown">Break Down into Denominations & Tithes</button>
    `;
    manualPrompt.querySelector('.btn-enable-breakdown').addEventListener('click', () => {
      w.collectionsBreakdown.hasBreakdown = true;
      recalculateLedger();
      const newContainer = buildSubLedgerContainer(dateKey);
      container.replaceWith(newContainer);
    });
    paneCollections.appendChild(manualPrompt);
  } else {
    // Show side-by-side split panels
    const colLeft = document.createElement('div');
    colLeft.className = 'collections-col-left';
    
    const colRight = document.createElement('div');
    colRight.className = 'collections-col-right';
    
    paneCollections.appendChild(colLeft);
    paneCollections.appendChild(colRight);

    // LEFT: Currency Denominations & Cheques
    // Denominations Sub-panel
    const panelDenoms = document.createElement('div');
    panelDenoms.className = 'sub-panel';
    panelDenoms.innerHTML = `
      <h3 class="sub-panel-title" style="border-bottom:1px solid #3e5b38;padding-bottom:6px;color:#3e5b38;font-weight:700;">Currency Denomination (LKR)</h3>
      <table class="collections-table denom-table">
        <thead>
          <tr style="background-color:#3e5b38;">
            <th style="color:white;padding:6px 10px;">Notes</th>
            <th style="color:white;padding:6px 10px;width:100px;">Count</th>
            <th style="color:white;padding:6px 10px;text-align:right;">Rupees</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <div style="display:flex;justify-content:space-between;font-weight:700;margin-top:12px;font-size:12px;padding:4px 8px;background-color:#e8f4e5;border-radius:4px;color:#248a3d;">
        <span>CASH SUB TOTAL:</span>
        <span class="cash-subtotal-val">Rs 0.00</span>
      </div>
    `;
    const denomTbody = panelDenoms.querySelector('tbody');
    const denoms = ["5000", "2000", "1000", "500", "100", "50", "20"];
    
    denoms.forEach(denom => {
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.textContent = denom;
      tdLabel.style.fontWeight = '700';
      
      const tdInput = document.createElement('td');
      const inputCount = document.createElement('input');
      inputCount.type = 'number';
      inputCount.min = '0';
      inputCount.className = 'denom-input';
      inputCount.style.padding = '3px 6px';
      inputCount.value = w.collectionsBreakdown.denominations[denom] || 0;
      
      // Prevent focus issues and allow live calculation updates
      inputCount.addEventListener('input', () => {
        w.collectionsBreakdown.denominations[denom] = parseInt(inputCount.value) || 0;
        updateCollectionsCalculations();
      });
      inputCount.addEventListener('change', () => {
        recalculateLedger();
      });
      tdInput.appendChild(inputCount);

      const tdRupees = document.createElement('td');
      tdRupees.className = `denom-rupees-${denom}`;
      tdRupees.style.textAlign = 'right';
      tdRupees.style.fontWeight = '600';
      
      tr.appendChild(tdLabel);
      tr.appendChild(tdInput);
      tr.appendChild(tdRupees);
      denomTbody.appendChild(tr);
    });
    colLeft.appendChild(panelDenoms);

    // Cheques Sub-panel
    const panelCheques = document.createElement('div');
    panelCheques.className = 'sub-panel';
    panelCheques.style.marginTop = '16px';
    panelCheques.innerHTML = `
      <h3 class="sub-panel-title" style="border-bottom:1px solid #3e5b38;padding-bottom:6px;color:#3e5b38;font-weight:700;">Cheques Register</h3>
      <table class="collections-table cheques-table">
        <thead>
          <tr style="background-color:#3e5b38;">
            <th style="color:white;padding:6px 10px;">Cheque #</th>
            <th style="color:white;padding:6px 10px;">Bank</th>
            <th style="color:white;padding:6px 10px;width:120px;text-align:right;">Amount (Rs)</th>
            <th style="color:white;padding:6px 10px;width:40px;"></th>
          </tr>
        </thead>
        <tbody class="cheques-tbody"></tbody>
      </table>
      <button class="btn btn-secondary btn-sm btn-add-cheque" style="margin-top:10px;">+ Add Cheque Row</button>
      <div style="display:flex;justify-content:space-between;font-weight:700;margin-top:12px;font-size:12px;padding:4px 8px;background-color:#e8f4e5;border-radius:4px;color:#248a3d;">
        <span>CHEQUE SUB TOTAL:</span>
        <span class="cheque-subtotal-val">Rs 0.00</span>
      </div>
    `;
    
    const chequesTbody = panelCheques.querySelector('.cheques-tbody');
    const renderCheques = () => {
      chequesTbody.innerHTML = '';
      if (w.collectionsBreakdown.cheques.length === 0) {
        chequesTbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--apple-secondary);padding:8px;">No cheques received.</td></tr>`;
      } else {
        w.collectionsBreakdown.cheques.forEach((ch, idx) => {
          const tr = document.createElement('tr');
          
          const tdNo = document.createElement('td');
          const inputNo = document.createElement('input');
          inputNo.type = 'text';
          inputNo.value = ch.chequeNo || '';
          inputNo.placeholder = 'e.g. 849204';
          inputNo.addEventListener('input', () => {
            ch.chequeNo = inputNo.value.trim();
          });
          inputNo.addEventListener('change', () => {
            recalculateLedger();
          });
          tdNo.appendChild(inputNo);
          
          const tdBank = document.createElement('td');
          const inputBank = document.createElement('input');
          inputBank.type = 'text';
          inputBank.value = ch.bank || '';
          inputBank.placeholder = 'e.g. HNB';
          inputBank.addEventListener('input', () => {
            ch.bank = inputBank.value.trim();
          });
          inputBank.addEventListener('change', () => {
            recalculateLedger();
          });
          tdBank.appendChild(inputBank);
          
          const tdAmt = document.createElement('td');
          const inputAmt = document.createElement('input');
          inputAmt.type = 'number';
          inputAmt.step = '0.01';
          inputAmt.value = ch.amount || '';
          inputAmt.style.textAlign = 'right';
          inputAmt.addEventListener('input', () => {
            ch.amount = parseFloat(inputAmt.value) || 0;
            updateCollectionsCalculations();
          });
          inputAmt.addEventListener('change', () => {
            recalculateLedger();
          });
          tdAmt.appendChild(inputAmt);
          
          const tdDel = document.createElement('td');
          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-danger btn-sm';
          delBtn.style.padding = '3px 6px';
          delBtn.innerHTML = '&times;';
          delBtn.addEventListener('click', () => {
            w.collectionsBreakdown.cheques.splice(idx, 1);
            recalculateLedger();
            // Remove row in-place instead of renderGrid()
            tr.remove();
            if (w.collectionsBreakdown.cheques.length === 0) {
              chequesTbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--apple-secondary);padding:8px;">No cheques received.</td></tr>`;
            }
            updateCollectionsCalculations();
          });
          tdDel.appendChild(delBtn);
          
          tr.appendChild(tdNo);
          tr.appendChild(tdBank);
          tr.appendChild(tdAmt);
          tr.appendChild(tdDel);
          chequesTbody.appendChild(tr);
        });
      }
    };
    
    panelCheques.querySelector('.btn-add-cheque').addEventListener('click', () => {
      const newCheque = { chequeNo: '', bank: '', amount: 0 };
      w.collectionsBreakdown.cheques.push(newCheque);
      recalculateLedger();
      // In-place: add row to tbody without full re-render
      const emptyRow = chequesTbody.querySelector('td[colspan]');
      if (emptyRow) chequesTbody.innerHTML = '';
      const idx = w.collectionsBreakdown.cheques.length - 1;
      const ch = newCheque;
      const newTr = document.createElement('tr');
      const tdNo = document.createElement('td'); const inputNo = document.createElement('input'); inputNo.type='text'; inputNo.value=''; inputNo.placeholder='e.g. 849204'; inputNo.addEventListener('input',()=>{ch.chequeNo=inputNo.value.trim();}); inputNo.addEventListener('change',()=>{recalculateLedger();}); tdNo.appendChild(inputNo);
      const tdBank = document.createElement('td'); const inputBank = document.createElement('input'); inputBank.type='text'; inputBank.value=''; inputBank.placeholder='e.g. HNB'; inputBank.addEventListener('input',()=>{ch.bank=inputBank.value.trim();}); inputBank.addEventListener('change',()=>{recalculateLedger();}); tdBank.appendChild(inputBank);
      const tdAmt = document.createElement('td'); const inputAmt = document.createElement('input'); inputAmt.type='number'; inputAmt.step='0.01'; inputAmt.value=''; inputAmt.style.textAlign='right'; inputAmt.addEventListener('input',()=>{ch.amount=parseFloat(inputAmt.value)||0; updateCollectionsCalculations();}); inputAmt.addEventListener('change',()=>{recalculateLedger();}); tdAmt.appendChild(inputAmt);
      const tdDel = document.createElement('td'); const delBtn = document.createElement('button'); delBtn.className='btn btn-danger btn-sm'; delBtn.style.padding='3px 6px'; delBtn.innerHTML='&times;'; delBtn.addEventListener('click',()=>{ w.collectionsBreakdown.cheques.splice(w.collectionsBreakdown.cheques.indexOf(ch),1); recalculateLedger(); newTr.remove(); if(w.collectionsBreakdown.cheques.length===0){chequesTbody.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--apple-secondary);padding:8px;">No cheques received.</td></tr>';} updateCollectionsCalculations(); }); tdDel.appendChild(delBtn);
      newTr.appendChild(tdNo); newTr.appendChild(tdBank); newTr.appendChild(tdAmt); newTr.appendChild(tdDel);
      chequesTbody.appendChild(newTr);
      inputNo.focus();
    });
    
    renderCheques();
    colLeft.appendChild(panelCheques);

    // RIGHT: Designated Funds / Tithes Register
    const panelFunds = document.createElement('div');
    panelFunds.className = 'sub-panel';
    
    const panelTitle = isPersonal ? 'Income Source & Category Breakdown' : 'Designated Funds & Special Offerings Register';
    const addRowBtnText = isPersonal ? '+ Add Income Source' : '+ Add Fund / Tithe Row';
    const labelTotalA = isPersonal ? 'TOTAL DAY INFLOW (A):' : 'TOTAL SUNDAY COLLECTIONS (A):';
    const labelTotalB = isPersonal ? 'TOTAL CATEGORIZED INFLOW (B):' : 'TOTAL TITHES & DESIGNATED FUNDS (B):';
    const labelDelta = isPersonal ? 'UNCATEGORIZED INFLOW (A - B):' : 'LOOSE OFFERINGS (A - B):';

    panelFunds.innerHTML = `
      <h3 class="sub-panel-title" style="border-bottom:1px solid #3e5b38;padding-bottom:6px;color:#3e5b38;font-weight:700;">${panelTitle}</h3>
      <table class="collections-table designated-table">
        <thead>
          <tr style="background-color:#3e5b38;">
            <th style="color:white;padding:6px 10px;">Description / Name</th>
            <th style="color:white;padding:6px 10px;">Category</th>
            <th style="color:white;padding:6px 10px;width:120px;text-align:right;">Amount (Rs)</th>
            <th style="color:white;padding:6px 10px;width:40px;"></th>
          </tr>
        </thead>
        <tbody class="designated-tbody"></tbody>
      </table>
      <button class="btn btn-secondary btn-sm btn-add-fund" style="margin-top:10px;">${addRowBtnText}</button>
      
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:20px;padding-top:14px;border-top:1px solid var(--subtle-slate);font-size:12px;">
        <div style="display:flex;justify-content:space-between;font-weight:600;">
          <span>${labelTotalA}</span>
          <span class="total-collections-val" style="font-weight:700;">Rs 0.00</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-weight:600;color:#c72c22;">
          <span>${labelTotalB}</span>
          <span class="tithe-total-val" style="font-weight:700;">Rs 0.00</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-weight:800;font-size:13px;padding:8px 10px;background-color:#e8f4e5;border-radius:6px;border:1px solid #248a3d;margin-top:8px;">
          <span style="color:#248a3d;">${labelDelta}</span>
          <span class="loose-offering-val" style="color:#248a3d;">Rs 0.00</span>
        </div>
      </div>
      
      <div style="margin-top:20px;display:flex;justify-content:flex-end;">
        <button class="btn btn-secondary btn-sm btn-revert-manual" style="font-size:10px;padding:3px 6px;">Revert to Manual Entry</button>
      </div>
    `;
    
    const fundsTbody = panelFunds.querySelector('.designated-tbody');
    const renderFunds = () => {
      fundsTbody.innerHTML = '';
      if (w.collectionsBreakdown.designatedFunds.length === 0) {
        fundsTbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--apple-secondary);padding:8px;">${isPersonal ? 'No categorized income sources registered.' : 'No designated funds / tithes registered.'}</td></tr>`;
      } else {
        w.collectionsBreakdown.designatedFunds.forEach((fund, idx) => {
          const tr = document.createElement('tr');
          
          const tdDesc = document.createElement('td');
          const inputDesc = document.createElement('input');
          inputDesc.type = 'text';
          inputDesc.value = fund.description || '';
          inputDesc.placeholder = isPersonal ? 'e.g. Salary' : 'e.g. Jude Tithe';
          inputDesc.setAttribute('list', 'datalist-tithe-names'); // autocomplete hook
          inputDesc.addEventListener('input', () => {
            fund.description = inputDesc.value.trim();
          });
          inputDesc.addEventListener('change', () => {
            updateTitheAutocompleteDatalists();
            recalculateLedger();
          });
          tdDesc.appendChild(inputDesc);
          
          const tdCat = document.createElement('td');
          const inputCat = document.createElement('input');
          inputCat.type = 'text';
          inputCat.value = fund.category || '';
          inputCat.placeholder = isPersonal ? 'e.g. Active Income' : 'e.g. Tithe';
          inputCat.setAttribute('list', 'datalist-tithe-categories'); // autocomplete hook
          inputCat.addEventListener('input', () => {
            fund.category = inputCat.value.trim();
          });
          inputCat.addEventListener('change', () => {
            updateTitheAutocompleteDatalists();
            recalculateLedger();
          });
          tdCat.appendChild(inputCat);
          
          const tdAmt = document.createElement('td');
          const inputAmt = document.createElement('input');
          inputAmt.type = 'number';
          inputAmt.step = '0.01';
          inputAmt.value = fund.amount || '';
          inputAmt.style.textAlign = 'right';
          inputAmt.addEventListener('input', () => {
            fund.amount = parseFloat(inputAmt.value) || 0;
            updateCollectionsCalculations();
          });
          inputAmt.addEventListener('change', () => {
            recalculateLedger();
          });
          tdAmt.appendChild(inputAmt);
          
          const tdDel = document.createElement('td');
          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-danger btn-sm';
          delBtn.style.padding = '3px 6px';
          delBtn.innerHTML = '&times;';
          delBtn.addEventListener('click', () => {
            w.collectionsBreakdown.designatedFunds.splice(idx, 1);
            recalculateLedger();
            renderFunds();
            updateCollectionsCalculations();
          });
          tdDel.appendChild(delBtn);
          
          tr.appendChild(tdDesc);
          tr.appendChild(tdCat);
          tr.appendChild(tdAmt);
          tr.appendChild(tdDel);
          fundsTbody.appendChild(tr);
        });
      }
    };
    
    panelFunds.querySelector('.btn-add-fund').addEventListener('click', () => {
      w.collectionsBreakdown.designatedFunds.push({ description: '', category: 'Tithe', amount: 0 });
      recalculateLedger();
      renderFunds();
      updateCollectionsCalculations();
      const inputs = fundsTbody.querySelectorAll('input[type=text]');
      if (inputs.length > 1) {
        inputs[inputs.length - 2].focus();
      }
    });
    
    panelFunds.querySelector('.btn-revert-manual').addEventListener('click', () => {
      if (confirm("Are you sure you want to revert to manual entry? This will lock the manual collections amount, and the notes and cheques inputs will be ignored until breakdown is re-enabled.")) {
        w.collectionsBreakdown.hasBreakdown = false;
        recalculateLedger();
        const newContainer = buildSubLedgerContainer(dateKey);
        container.replaceWith(newContainer);
      }
    });
    
    renderFunds();
    colRight.appendChild(panelFunds);

    // Live update function for calculations (no screen flickering)
    const updateCollectionsCalculations = () => {
      let cashTotal = 0;
      denoms.forEach(denom => {
        const count = parseInt(w.collectionsBreakdown.denominations[denom]) || 0;
        cashTotal += parseInt(denom) * count;
        const rowRupees = panelDenoms.querySelector(`.denom-rupees-${denom}`);
        if (rowRupees) rowRupees.textContent = formatCurrency(parseInt(denom) * count);
      });

      let chequeTotal = 0;
      w.collectionsBreakdown.cheques.forEach(ch => {
        chequeTotal += parseFloat(ch.amount) || 0;
      });

      const totalCollections = cashTotal + chequeTotal;
      
      let titheTotal = 0;
      w.collectionsBreakdown.designatedFunds.forEach(fund => {
        titheTotal += parseFloat(fund.amount) || 0;
      });

      const looseOffering = totalCollections - titheTotal;

      const cashSubEl = panelDenoms.querySelector('.cash-subtotal-val');
      if (cashSubEl) cashSubEl.textContent = formatCurrency(cashTotal);

      const chequeSubEl = panelCheques.querySelector('.cheque-subtotal-val');
      if (chequeSubEl) chequeSubEl.textContent = formatCurrency(chequeTotal);

      const totalCollEl = panelFunds.querySelector('.total-collections-val');
      if (totalCollEl) totalCollEl.textContent = formatCurrency(totalCollections);

      const titheTotalEl = panelFunds.querySelector('.tithe-total-val');
      if (titheTotalEl) titheTotalEl.textContent = formatCurrency(titheTotal);

      const looseOffEl = panelFunds.querySelector('.loose-offering-val');
      if (looseOffEl) {
        looseOffEl.textContent = formatCurrency(looseOffering);
        if (looseOffering >= 0) {
          looseOffEl.style.color = '#248a3d';
        } else {
          looseOffEl.style.color = 'var(--apple-red-solid)';
        }
      }

      // Sync back to w.offering
      w.offering = totalCollections;
      
      // Update sub-ledger footer offerings count locally if it exists
      const footerOffering = container.querySelector('.footer-offering-val');
      if (footerOffering) footerOffering.textContent = formatCurrency(totalCollections);
    };

    // Initialize calculations display
    updateCollectionsCalculations();
  }

  // --- TAB B: WEEKLY EXPENSES PANE ---
  const paneExpenses = document.createElement('div');
  paneExpenses.className = 'sub-tab-pane expenses-pane';
  paneExpenses.style.display = 'none'; // hidden by default
  paneExpenses.style.flexDirection = 'column';
  paneExpenses.style.width = '100%';
  tabPanes.appendChild(paneExpenses);

  // Render Operational Expenses directly inside Pane Expenses
  const expTable = document.createElement('table');
  expTable.className = 'sub-outgoings-table';
  expTable.innerHTML = `
    <thead>
      <tr>
        <th>Description</th>
        <th style="width:140px;">Amount (Rs)</th>
        <th>Receipt Link</th>
        <th style="width:40px;"></th>
      </tr>
    </thead>
    <tbody class="outgoings-tbody"></tbody>
  `;
  const tbody = expTable.querySelector('.outgoings-tbody');

  // Helper: build a single expense row in-place
  function buildExpenseRow(exp, appendToTbody) {
    const expTr = document.createElement('tr');

    // Description
    const tdDesc = document.createElement('td');
    const inputDesc = document.createElement('input');
    inputDesc.type = 'text';
    inputDesc.value = exp.description;
    inputDesc.placeholder = 'e.g. Utility electricity';
    inputDesc.addEventListener('input', () => { exp.description = inputDesc.value; });
    inputDesc.addEventListener('change', () => { recalculateLedger(); });
    tdDesc.appendChild(inputDesc);
    expTr.appendChild(tdDesc);

    // Amount
    const tdAmt = document.createElement('td');
    const inputAmt = document.createElement('input');
    inputAmt.type = 'number';
    inputAmt.step = '0.01';
    inputAmt.value = exp.amount;
    inputAmt.addEventListener('input', () => { exp.amount = Math.max(0, parseFloat(inputAmt.value) || 0); });
    inputAmt.addEventListener('change', () => { recalculateLedger(); });
    tdAmt.appendChild(inputAmt);
    expTr.appendChild(tdAmt);

    // Receipt Drag/Drop area - in-place rebuild helper
    function buildReceiptCell(exp, expTr) {
      const tdReceipt = document.createElement('td');
      if (exp.receipt) {
        const fileLink = document.createElement('a');
        fileLink.className = 'receipt-link';
        fileLink.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> ${exp.receipt.split('/').pop()}`;
        fileLink.addEventListener('click', (e) => { e.preventDefault(); window.electronAPI.openFile(exp.receipt); });
        const detachBtn = document.createElement('button');
        detachBtn.className = 'btn-clear-file'; detachBtn.innerHTML = '&times;'; detachBtn.title = 'Detach receipt'; detachBtn.style.marginLeft = '8px';
        detachBtn.addEventListener('click', () => {
          if (confirm('Remove receipt link from this expense?')) {
            exp.receipt = '';
            recalculateLedger();
            // In-place: replace the td contents only
            const oldTd = expTr.querySelector('.receipt-link').closest('td');
            const newTd = buildReceiptCell(exp, expTr);
            oldTd.replaceWith(newTd);
          }
        });
        tdReceipt.appendChild(fileLink);
        tdReceipt.appendChild(detachBtn);
      } else {
        const dropMicro = document.createElement('div');
        dropMicro.className = 'receipt-drop-micro';
        dropMicro.textContent = 'Drop receipt file here';
        dropMicro.addEventListener('dragover', (e) => { e.preventDefault(); dropMicro.style.borderColor = 'var(--velvet-black)'; dropMicro.style.backgroundColor = '#e9e9eb'; });
        dropMicro.addEventListener('dragleave', () => { dropMicro.style.borderColor = '#c2c2c7'; dropMicro.style.backgroundColor = 'transparent'; });
        dropMicro.addEventListener('drop', async (e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) { try { const lp = await window.electronAPI.copyReceipt(file.path); exp.receipt = lp; recalculateLedger(); const oldTd = dropMicro.closest('td'); const newTd = buildReceiptCell(exp, expTr); oldTd.replaceWith(newTd); } catch (err) { alert('Failed to copy receipt: ' + err.message); } }
        });
        dropMicro.addEventListener('click', () => {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png, image/jpeg, application/pdf';
          inp.onchange = async () => { const file = inp.files[0]; if (file) { try { const lp = await window.electronAPI.copyReceipt(file.path); exp.receipt = lp; recalculateLedger(); const oldTd = dropMicro.closest('td'); const newTd = buildReceiptCell(exp, expTr); oldTd.replaceWith(newTd); } catch (err) { alert('Failed to copy receipt: ' + err.message); } } };
          inp.click();
        });
        tdReceipt.appendChild(dropMicro);
      }
      return tdReceipt;
    }

    // Actions (Delete row) — in-place remove
    const tdAct = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm'; delBtn.style.padding = '3px 6px'; delBtn.innerHTML = '&times;';
    delBtn.addEventListener('click', () => {
      w.outgoings = w.outgoings.filter(o => o.id !== exp.id);
      recalculateLedger();
      expTr.remove();
      if (!w.outgoings || w.outgoings.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--apple-secondary);padding:14px;">No operational expenses logged for this Sunday.</td></tr>`;
      }
    });
    tdAct.appendChild(delBtn);

    expTr.appendChild(buildReceiptCell(exp, expTr));
    expTr.appendChild(tdAct);
    if (appendToTbody) appendToTbody.appendChild(expTr);
    return expTr;
  }

  if (w.outgoings && w.outgoings.length > 0) {
    w.outgoings.forEach(exp => buildExpenseRow(exp, tbody));
  } else {
    const emptyTr = document.createElement('tr');
    emptyTr.innerHTML = `<td colspan="4" style="text-align:center;color:var(--apple-secondary);padding:14px;">No operational expenses logged for this Sunday.</td>`;
    tbody.appendChild(emptyTr);
  }

  paneExpenses.appendChild(expTable);

  const addExpBtn = document.createElement('button');
  addExpBtn.className = 'btn btn-secondary btn-sm';
  addExpBtn.style.marginTop = '12px';
  addExpBtn.style.alignSelf = 'flex-start';
  addExpBtn.innerHTML = `+ Add Expense Row`;
  addExpBtn.addEventListener('click', () => {
    if (!w.outgoings) w.outgoings = [];
    const newExp = { id: 'out_' + Date.now(), description: '', amount: 0.00, receipt: '' };
    w.outgoings.push(newExp);
    recalculateLedger();
    // In-place: remove empty state row if present, then append new row
    const emptyRow = tbody.querySelector('td[colspan]');
    if (emptyRow) tbody.innerHTML = '';
    const newRow = buildExpenseRow(newExp, tbody);
    // Focus the description input of the new row
    const descInput = newRow.querySelector('input[type=text]');
    if (descInput) descInput.focus();
  });
  paneExpenses.appendChild(addExpBtn);

  // Tab buttons click actions — remember active tab so renderGrid() can restore it
  tabCollectionsBtn.addEventListener('click', () => {
    tabCollectionsBtn.classList.add('active');
    tabExpensesBtn.classList.remove('active');
    paneCollections.style.display = 'flex';
    paneExpenses.style.display = 'none';
    expandedRowTab.set(dateKey, 'collections');
  });

  tabExpensesBtn.addEventListener('click', () => {
    tabExpensesBtn.classList.add('active');
    tabCollectionsBtn.classList.remove('active');
    paneCollections.style.display = 'none';
    paneExpenses.style.display = 'flex';
    expandedRowTab.set(dateKey, 'expenses');
  });

  // Restore tab if already set
  if (expandedRowTab.get(dateKey) === 'expenses') {
    tabExpensesBtn.classList.add('active');
    tabCollectionsBtn.classList.remove('active');
    paneCollections.style.display = 'none';
    paneExpenses.style.display = 'flex';
  }

  // --- FOOTER METRICS SUMMARY ---
  const footer = document.createElement('div');
  footer.className = 'sub-ledger-footer';

  const offeringVal = parseFloat(w.offering) || 0;
  const rentVal = parseFloat(w.calculatedRental) || 0;
  
  let customInflow = 0;
  let customOutflow = 0;
  db.settings.columns.forEach(col => {
    if (w.customCells && w.customCells[col.id]) {
      const val = parseFloat(w.customCells[col.id]) || 0;
      if (col.type === 'inflow') customInflow += val;
      if (col.type === 'outflow') customOutflow += val;
    }
  });

  let outflowVal = 0;
  if (w.outgoings) w.outgoings.forEach(o => outflowVal += parseFloat(o.amount) || 0);

  const totalOut = outflowVal + customOutflow;
  const landlordRentVal = parseFloat(w.calculatedLandlordRent) || 0;
  const loanOutflowVal = parseFloat(w.calculatedLoanOutflow) || 0;

  footer.innerHTML = `
    <div class="footer-stat">
      <span class="lbl">Sunday Collections:</span>
      <span class="val footer-offering-val" style="color:var(--apple-text);">${formatCurrency(offeringVal)}</span>
    </div>
    <div class="footer-stat">
      <span class="lbl">Rent Received:</span>
      <span class="val" style="color:var(--apple-green-text);">${formatCurrency(rentVal)}</span>
    </div>
    <div class="footer-stat">
      <span class="lbl">Custom Inflows:</span>
      <span class="val" style="color:var(--apple-green-text);">${formatCurrency(customInflow)}</span>
    </div>
    <div class="footer-stat">
      <span class="lbl">Expenses:</span>
      <span class="val" style="color:var(--apple-red-solid);">${formatCurrency(totalOut)}</span>
    </div>
    ${landlordRentVal > 0 ? `
    <div class="footer-stat">
      <span class="lbl">Landlord Rent Paid:</span>
      <span class="val" style="color:var(--apple-red-solid);">${formatCurrency(landlordRentVal)}</span>
    </div>
    ` : ''}
    ${loanOutflowVal > 0 ? `
    <div class="footer-stat">
      <span class="lbl">Agreement Payments:</span>
      <span class="val" style="color:var(--apple-red-solid);">${formatCurrency(loanOutflowVal)}</span>
    </div>
    ` : ''}
    <div class="footer-stat">
      <span class="lbl">Weekly Delta:</span>
      <span class="val ${w.calculatedDelta >= 0 ? 'delta-positive' : 'delta-negative'}">${formatCurrency(w.calculatedDelta)}</span>
    </div>
    <div class="footer-stat">
      <span class="lbl" style="font-weight:700;">Rolling Vault:</span>
      <span class="val" style="font-weight:800;text-decoration:underline;">${formatCurrency(w.calculatedBalance)}</span>
    </div>
  `;

  container.appendChild(footer);

  return container;
}

// --- 6. VIEW 3: ROOM & TENANT CONFIGURATION ---

function renderTenants() {
  tenantSettingsBody.innerHTML = '';
  
  // Find all columns of type 'tenant'
  const tenantIds = Object.keys(db.settings.tenantRates);
  
  tenantIds.forEach(tId => {
    const tName = db.settings.tenantNames[tId] || tId;
    const baseRate = db.settings.tenantRates[tId] || 0.00;
    
    const tr = document.createElement('tr');
    
    // Name
    const tdName = document.createElement('td');
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.value = tName;
    inputName.addEventListener('change', () => {
      const val = inputName.value.trim();
      if (val) {
        db.settings.tenantNames[tId] = val;
        recalculateLedger();
        renderTenants();
      }
    });
    tdName.appendChild(inputName);
    tr.appendChild(tdName);

    // Monthly Fee
    const tdRate = document.createElement('td');
    const inputRate = document.createElement('input');
    inputRate.type = 'number';
    inputRate.step = '0.01';
    inputRate.value = baseRate;
    inputRate.addEventListener('change', () => {
      const val = Math.max(0, parseFloat(inputRate.value) || 0);
      db.settings.tenantRates[tId] = val;
      
      // Update amounts for months where it is paid (re-aligns active rates)
      Object.keys(db.months).forEach(m => {
        if (db.months[m].tenants[tId] && db.months[m].tenants[tId].paid) {
          db.months[m].tenants[tId].amount = val;
        }
      });
      recalculateLedger();
    });
    tdRate.appendChild(inputRate);
    tr.appendChild(tdRate);

    // Internal ID
    const tdId = document.createElement('td');
    tdId.innerHTML = `<code style="font-size:11px;color:var(--apple-secondary);">${tId}</code>`;
    tr.appendChild(tdId);

    // Actions (Delete Room)
    const tdAction = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.innerHTML = 'Remove Lease';
    delBtn.addEventListener('click', () => {
      if (confirm(`Are you sure you want to delete Room/Tenant '${tName}'? All past rent payment records in the ledger for this room will be destroyed.`)) {
        delete db.settings.tenantRates[tId];
        delete db.settings.tenantNames[tId];
        
        // Remove from months
        Object.keys(db.months).forEach(mKey => {
          if (db.months[mKey].tenants[tId]) {
            delete db.months[mKey].tenants[tId];
          }
        });

        recalculateLedger();
        renderTenants();
      }
    });
    tdAction.appendChild(delBtn);
    tr.appendChild(tdAction);

    tenantSettingsBody.appendChild(tr);
  });

  if (tenantIds.length === 0) {
    tenantSettingsBody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--apple-secondary);">No rooms registered in the roster database. Click '+ Add New Room/Tenant'.</td></tr>`;
  }
}

// --- 7. EVENT LISTENERS SETUP ---

// --- ANALYTICS FILTERING ---
function filterMetrics() {
  const filter = document.getElementById('analytics-filter').value;
  const periodEl = document.getElementById('metric-period-assets');
  
  if (filter === 'all') {
    updateTelemetryUI(db.metrics);
    drawChart(db.weeks);
    periodEl.style.display = 'none';
    return;
  }
  
  let periodInflows = 0;
  let periodOutflows = 0;
  let periodRentYield = 0;
  let periodCollections = 0;
  
  const filteredWeeks = {};
  
  Object.keys(db.weeks).sort().forEach(dateKey => {
    const mo = dateKey.substring(5, 7);
    
    let match = false;
    if (filter === 'q1' && ['01','02','03'].includes(mo)) match = true;
    else if (filter === 'q2' && ['04','05','06'].includes(mo)) match = true;
    else if (filter === 'q3' && ['07','08','09'].includes(mo)) match = true;
    else if (filter === 'q4' && ['10','11','12'].includes(mo)) match = true;
    else if (filter === mo) match = true;
    
    if (match) {
      filteredWeeks[dateKey] = db.weeks[dateKey];
      const w = db.weeks[dateKey];
      
      const offering = parseFloat(w.sundayOffering) || 0; // Fix: property is sundayOffering
      periodCollections += offering;
      
      const rent = parseFloat(w.calculatedRental) || 0;
      periodRentYield += rent;
      
      let customInflow = 0;
      db.settings.columns.forEach(col => {
        if (col.type === 'inflow' && w.customCells && w.customCells[col.id]) {
          customInflow += parseFloat(w.customCells[col.id]) || 0;
        }
      });
      
      periodInflows += (offering + rent + customInflow);
      
      let expenses = 0;
      if (w.outgoings) w.outgoings.forEach(e => expenses += parseFloat(e.amount) || 0);
      
      let customOutflow = 0;
      db.settings.columns.forEach(col => {
        if (col.type === 'outflow' && w.customCells && w.customCells[col.id]) {
          customOutflow += parseFloat(w.customCells[col.id]) || 0;
        }
      });
      
      periodOutflows += (expenses + customOutflow);
    }
  });

  // Calculate Landlord Rent for the period
  let periodLandlordRent = 0;
  if (db.landlordLease && db.landlordLease.months) {
    Object.keys(db.landlordLease.months).forEach(mKey => {
      const mo = mKey.substring(5, 7);
      let match = false;
      if (filter === 'q1' && ['01','02','03'].includes(mo)) match = true;
      else if (filter === 'q2' && ['04','05','06'].includes(mo)) match = true;
      else if (filter === 'q3' && ['07','08','09'].includes(mo)) match = true;
      else if (filter === 'q4' && ['10','11','12'].includes(mo)) match = true;
      else if (filter === mo) match = true;
      
      if (match) {
        periodLandlordRent += parseFloat(db.landlordLease.months[mKey]) || 0;
      }
    });
  }
  
  periodOutflows += periodLandlordRent;
  const periodDelta = periodInflows - periodOutflows;
  
  const scopedMetrics = {
    vaultBalance: db.metrics.vaultBalance,
    liquidAssets: db.metrics.liquidAssets,
    fixedReserves: db.metrics.fixedReserves,
    sundayCollections: periodCollections,
    estateYield: periodRentYield,
    operatingLosses: periodOutflows
  };
  
  updateTelemetryUI(scopedMetrics);
  
  periodEl.style.display = 'block';
  periodEl.textContent = `Period Net Delta: ${formatCurrency(periodDelta)}`;
  periodEl.style.color = periodDelta >= 0 ? 'var(--apple-green)' : 'var(--apple-red-solid)';
  
  drawChart(filteredWeeks);
}

function setupEventListeners() {
  // Profile Switcher listener
  const profileSwitcher = document.getElementById('profile-switcher');
  if (profileSwitcher) {
    profileSwitcher.addEventListener('change', async (e) => {
      const selectedProfile = e.target.value;
      if (confirm(`Are you sure you want to switch to the ${selectedProfile === 'personal' ? 'Personal' : 'Church'} Profile? The application will reload.`)) {
        await window.electronAPI.switchProfile(selectedProfile);
        window.location.reload();
      } else {
        profileSwitcher.value = activeProfile;
      }
    });
  }

  // Navigation tabs (dynamically queried to ensure all items are found)
  const allNavItems = document.querySelectorAll('.nav-item');
  allNavItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetView = item.getAttribute('data-view');
      if (targetView) {
        switchView(targetView);
      }
    });
  });

  // Apple Frameless control calls (null-safe for browser mode)
  const winClose = document.getElementById('win-close');
  if (winClose) winClose.addEventListener('click', () => window.electronAPI.windowClose());
  const winMin = document.getElementById('win-minimize');
  if (winMin) winMin.addEventListener('click', () => window.electronAPI.windowMinimize());
  const winMax = document.getElementById('win-maximize');
  if (winMax) winMax.addEventListener('click', () => window.electronAPI.windowMaximize());

  // Analytics Filter Event
  const analyticsFilter = document.getElementById('analytics-filter');
  if (analyticsFilter) {
    analyticsFilter.addEventListener('change', () => {
      filterMetrics();
    });
  }

  // Search input filter
  const searchInput = document.getElementById('grid-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderGrid();
    });
  }

  // Backup Vault Button
  btnBackup.addEventListener('click', async () => {
    try {
      const res = await window.electronAPI.createBackup(db);
      if (res) alert("Backup file successfully written to disk.");
    } catch (err) {
      alert("Error generating backup: " + err.message);
    }
  });

  btnImport.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.importData();
      if (result.success) {
        alert('Vault imported successfully! The dashboard will now reload.');
        db = result.data;
        recalculateLedger();
        renderGrid();
        renderTenants();
        switchView('dashboard');
      } else if (!result.canceled) {
        alert('Failed to import vault: ' + result.error);
      }
    } catch (err) {
      console.error(err);
      alert('Failed to import vault.');
    }
  });

  // Export handling Button
  btnExport.addEventListener('click', async () => {
    try {
      const mainGridData = [];
      const keys = Object.keys(db.weeks).sort();
      
      keys.forEach(dateKey => {
        const w = db.weeks[dateKey];
        const rowObj = {
          "Sunday Date": w.label || dateKey,
          "Sunday Collections": parseFloat(w.offering) || 0,
          "Rental Revenue Allocation": w.rentalOverride !== undefined ? parseFloat(w.rentalOverride) : (parseFloat(w.calculatedRental) || 0)
        };

        // Custom columns
        db.settings.columns.forEach(col => {
          if (col.editable) {
            rowObj[col.label] = (w.customCells && w.customCells[col.id]) || '';
          }
        });

        // Sum outgoings
        let weekExp = 0;
        if (w.outgoings) w.outgoings.forEach(e => weekExp += parseFloat(e.amount) || 0);
        rowObj["Weekly Expenses"] = weekExp;
        rowObj["Weekly Delta"] = w.calculatedDelta;
        rowObj["Monthly Balance"] = w.calculatedMonthlyBalance;
        rowObj["Rolling Reserve Balance"] = w.calculatedBalance;

        mainGridData.push(rowObj);
      });

      // Tenant monthly history sheet
      const tenantsData = [];
      Object.keys(db.months).forEach(mKey => {
        const monthData = db.months[mKey];
        Object.keys(monthData.tenants).forEach(tId => {
          const t = monthData.tenants[tId];
          tenantsData.push({
            "Month": mKey,
            "Room Name": db.settings.tenantNames[tId] || tId,
            "Monthly Rent Base ($)": db.settings.tenantRates[tId] || 0.00,
            "Settled": t.paid ? "PAID" : "UNPAID",
            "Payment Sunday Allocation": t.paid ? t.paymentDate : "N/A",
            "Amount Received ($)": t.paid ? t.amount : 0.00
          });
        });
      });

      // Expenses sheet
      const expensesData = [];
      keys.forEach(dateKey => {
        const w = db.weeks[dateKey];
        if (w.outgoings) {
          w.outgoings.forEach(exp => {
            expensesData.push({
              "Date (Sunday Cycle)": dateKey,
              "Expense Description": exp.description,
              "Amount ($)": parseFloat(exp.amount) || 0,
              "Receipt Path": exp.receipt || "No Receipt Linked"
            });
          });
        }
      });

      const res = await window.electronAPI.exportExcel({
        mainGrid: mainGridData,
        tenants: tenantsData,
        outgoings: expensesData
      });

      if (res) alert("Excel ledger sheets successfully generated and exported.");
    } catch (err) {
      alert("Error exporting Excel: " + err.message);
    }
  });

  // Dynamic Column Injection Dialog Action
  const modalColumn = document.getElementById('modal-column');
  const columnForm = document.getElementById('column-form');
  const columnName = document.getElementById('column-name');
  const columnType = document.getElementById('column-type');

  btnAddColumn.addEventListener('click', () => {
    columnName.value = '';
    columnType.value = 'inflow';
    modalColumn.classList.add('active');
  });

  const closeColumnModal = () => modalColumn.classList.remove('active');
  document.getElementById('modal-column-close-x').addEventListener('click', closeColumnModal);
  document.getElementById('modal-column-cancel-btn').addEventListener('click', closeColumnModal);

  columnForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const colName = columnName.value.trim();
    if (!colName) return;

    const cleanType = columnType.value;
    
    if (cleanType !== 'inflow' && cleanType !== 'outflow' && cleanType !== 'text') {
      alert("Invalid column type. Must be: inflow, outflow, or text.");
      return;
    }

    const colId = 'col_' + Date.now();
    db.settings.columns.push({
      id: colId,
      label: colName,
      type: cleanType,
      editable: true
    });

    Object.keys(db.weeks).forEach(dateKey => {
      if (!db.weeks[dateKey].customCells) db.weeks[dateKey].customCells = {};
      db.weeks[dateKey].customCells[colId] = cleanType === 'text' ? '' : 0.00;
    });

    closeColumnModal();
    recalculateLedger();
    renderGrid();
  });

  // Dynamic Row Injection (Add Sunday Date) Action
  const modalRow = document.getElementById('modal-row');
  const rowForm = document.getElementById('row-form');
  const rowDate = document.getElementById('row-date');

  btnAddSunday.addEventListener('click', () => {
    const sorted = Object.keys(db.weeks).sort();
    let nextDateStr = '';
    
    if (sorted.length > 0) {
      const lastDate = new Date(sorted[sorted.length - 1] + 'T00:00:00');
      lastDate.setDate(lastDate.getDate() + 7);
      
      const yyyy = lastDate.getFullYear();
      const mm = String(lastDate.getMonth() + 1).padStart(2, '0');
      const dd = String(lastDate.getDate()).padStart(2, '0');
      nextDateStr = `${yyyy}-${mm}-${dd}`;
    } else {
      nextDateStr = '2026-01-04';
    }

    rowDate.value = nextDateStr;
    modalRow.classList.add('active');
  });

  const closeRowModal = () => modalRow.classList.remove('active');
  document.getElementById('modal-row-close-x').addEventListener('click', closeRowModal);
  document.getElementById('modal-row-cancel-btn').addEventListener('click', closeRowModal);

  rowForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const inputVal = rowDate.value.trim();
    if (!inputVal) return;

    const match = inputVal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      alert("Invalid Date format. Must be YYYY-MM-DD.");
      return;
    }

    const dateObj = new Date(inputVal + 'T00:00:00');
    if (isNaN(dateObj.getTime())) {
      alert("Invalid Date.");
      return;
    }

    if (dateObj.getDay() !== 0) {
      if (!confirm(`Warning: The date ${inputVal} is not a Sunday. Are you sure you want to add this non-Sunday row?`)) {
        return;
      }
    }

    if (db.weeks[inputVal]) {
      alert("Error: A row with this date key already exists.");
      return;
    }

    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const displayLabel = dateObj.toLocaleDateString('en-US', options).replace(', ', ' - ');

    const newWeek = {
      sundayDate: inputVal,
      label: displayLabel,
      offering: 0.00,
      outgoings: [],
      customCells: {}
    };

    db.settings.columns.forEach(col => {
      if (col.editable) {
        newWeek.customCells[col.id] = col.type === 'text' ? '' : 0.00;
      }
    });

    db.weeks[inputVal] = newWeek;

    closeRowModal();
    recalculateLedger();
    renderGrid();
  });

  // Sidebar add tenant setup action
  const modalTenant = document.getElementById('modal-tenant');
  const tenantForm = document.getElementById('tenant-form');
  const tenantRoomName = document.getElementById('tenant-room-name');
  const tenantBaseRate = document.getElementById('tenant-base-rate');

  btnAddTenantConfig.addEventListener('click', () => {
    tenantRoomName.value = '';
    tenantBaseRate.value = '500.00';
    modalTenant.classList.add('active');
  });

  const closeTenantModal = () => {
    modalTenant.classList.remove('active');
  };

  document.getElementById('modal-tenant-close-x').addEventListener('click', closeTenantModal);
  document.getElementById('modal-tenant-cancel-btn').addEventListener('click', closeTenantModal);

  tenantForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const roomName = tenantRoomName.value.trim();
    if (!roomName) return;
    const monthlyRate = parseFloat(tenantBaseRate.value) || 0.00;

    const tId = 'room_' + Date.now();
    
    // Add base rate & names
    db.settings.tenantRates[tId] = monthlyRate;
    db.settings.tenantNames[tId] = roomName;

    // Initialize in months
    Object.keys(db.months).forEach(mKey => {
      // Find the first Sunday of this month to allocate
      const yr = parseInt(mKey.substring(0, 4));
      const mo = parseInt(mKey.substring(5, 7)) - 1;
      let firstSunday = new Date(yr, mo, 1);
      while (firstSunday.getDay() !== 0) {
        firstSunday.setDate(firstSunday.getDate() + 1);
      }
      const yyyy = firstSunday.getFullYear();
      const mm = String(firstSunday.getMonth() + 1).padStart(2, '0');
      const dd = String(firstSunday.getDate()).padStart(2, '0');
      const firstSundayStr = `${yyyy}-${mm}-${dd}`;

      db.months[mKey].tenants[tId] = { paid: false, paymentDate: firstSundayStr, amount: 0.00 };
    });

    closeTenantModal();
    recalculateLedger();
    renderTenants();
    renderGrid();
  });
}

// --- FINANCIAL GOVERNANCE MODULE ---
const landlordBaseRent = document.getElementById('landlord-base-rent');
const landlordLedgerBody = document.getElementById('landlord-ledger-body');
const fdVaultBody = document.getElementById('fd-vault-body');

const modalFd = document.getElementById('modal-fd');
const fdForm = document.getElementById('fd-form');
const btnAddFd = document.getElementById('btn-add-fd');

function renderGovernance() {
  if (!db) return;
  db.loansAndDeposits = db.loansAndDeposits || [];
  db.fixedDeposits = db.fixedDeposits || [];
  
  // Normalize fixed deposit IDs and updatedAt for LWW sync
  db.fixedDeposits.forEach((fd, idx) => {
    if (!fd.id) {
      fd.id = 'fd_' + idx + '_' + Date.now();
      fd.updatedAt = fd.updatedAt || Date.now();
    }
  });

  if (!db.landlordLease) return;
  
  // Render Landlord Lease
  landlordBaseRent.value = db.landlordLease.baseRent;
  landlordLedgerBody.innerHTML = '';
  
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  
  Object.keys(db.landlordLease.months).sort().forEach(mKey => {
    const amountPaid = parseFloat(db.landlordLease.months[mKey]) || 0;
    const baseRent = parseFloat(db.landlordLease.baseRent) || 0;
    const remaining = baseRent - amountPaid;
    
    const yr = mKey.substring(0, 4);
    const moIdx = parseInt(mKey.substring(5, 7)) - 1;
    const moName = monthNames[moIdx] + " " + yr;
    
    const tr = document.createElement('tr');
    
    const tdMonth = document.createElement('td');
    tdMonth.textContent = moName;
    
    const tdDue = document.createElement('td');
    tdDue.textContent = formatCurrency(baseRent);
    
    const tdPaid = document.createElement('td');
    const inputPaid = document.createElement('input');
    inputPaid.type = 'number';
    inputPaid.className = 'cell-editor';
    inputPaid.style.width = '120px';
    inputPaid.style.padding = '4px 8px';
    inputPaid.value = amountPaid > 0 ? amountPaid.toFixed(2) : '';
    inputPaid.placeholder = '0.00';
    
    inputPaid.addEventListener('blur', (e) => {
      let newPaid = parseFloat(e.target.value);
      if (isNaN(newPaid) || newPaid < 0) newPaid = 0;
      if (db.landlordLease.months[mKey] !== newPaid) {
        db.landlordLease.months[mKey] = newPaid;
        e.target.value = newPaid > 0 ? newPaid.toFixed(2) : '';
        recalculateLedger();
        renderGovernance();
      }
    });
    
    tdPaid.appendChild(inputPaid);
    
    const tdRemaining = document.createElement('td');
    tdRemaining.textContent = formatCurrency(Math.max(0, remaining));
    if (remaining > 0) tdRemaining.style.color = 'var(--apple-red-solid)';
    
    const tdStatus = document.createElement('td');
    tdStatus.style.textAlign = 'right';
    const badge = document.createElement('span');
    badge.classList.add('status-badge');
    
    if (amountPaid >= baseRent && baseRent > 0) {
      badge.textContent = "Settled";
      badge.classList.add('badge-settled');
    } else if (amountPaid > 0) {
      badge.textContent = "Partial";
      badge.classList.add('badge-partial');
    } else {
      badge.textContent = "Unpaid";
      badge.classList.add('badge-unpaid');
    }
    
    tdStatus.appendChild(badge);
    
    tr.appendChild(tdMonth);
    tr.appendChild(tdDue);
    tr.appendChild(tdPaid);
    tr.appendChild(tdRemaining);
    tr.appendChild(tdStatus);
    landlordLedgerBody.appendChild(tr);
  });
  
  // Render Fixed Deposits
  fdVaultBody.innerHTML = '';
  if (db.fixedDeposits) {
    db.fixedDeposits.forEach((fd, idx) => {
      const tr = document.createElement('tr');
      
      const tdBank = document.createElement('td');
      tdBank.textContent = fd.bank;
      const subAccount = document.createElement('div');
      subAccount.style.fontSize = '11px';
      subAccount.style.color = 'var(--apple-secondary)';
      subAccount.textContent = `A/C: ${fd.account}`;
      tdBank.appendChild(subAccount);
      
      const tdPrincipal = document.createElement('td');
      tdPrincipal.textContent = formatCurrency(fd.principal);
      tdPrincipal.style.fontWeight = '700';
      
      const tdMaturity = document.createElement('td');
      tdMaturity.textContent = fd.maturity;
      
      const tdRate = document.createElement('td');
      tdRate.textContent = `${fd.rate}%`;
      
      const tdNotes = document.createElement('td');
      tdNotes.textContent = fd.notes || '';
      
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'right';
      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn btn-secondary';
      btnDelete.style.padding = '4px 8px';
      btnDelete.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      btnDelete.addEventListener('click', () => {
        if (confirm(`Remove Fixed Deposit for ${fd.bank}?`)) {
          db.fixedDeposits.splice(idx, 1);
          recalculateLedger();
          renderGovernance();
        }
      });
      tdActions.appendChild(btnDelete);
      
      tr.appendChild(tdBank);
      tr.appendChild(tdPrincipal);
      tr.appendChild(tdMaturity);
      tr.appendChild(tdRate);
      tr.appendChild(tdNotes);
      tr.appendChild(tdActions);
      fdVaultBody.appendChild(tr);
    });
  }

  // Render Capital Loans & Deposits
  const loanVaultBody = document.getElementById('loan-vault-body');
  if (loanVaultBody) {
    loanVaultBody.innerHTML = '';
    db.loansAndDeposits.forEach((loan, idx) => {
      if (!loan.payments) loan.payments = [];
      const calculatedPaid = loan.payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      loan.paidAmount = calculatedPaid;

      const tr = document.createElement('tr');
      
      const tdTitle = document.createElement('td');
      tdTitle.textContent = loan.title;
      tdTitle.style.fontWeight = '600';
      
      const tdType = document.createElement('td');
      let typeLabel = "Deposit";
      let badgeClass = "badge-settled";
      if (loan.type === "loan_taken") {
        typeLabel = "Loan (We Owe)";
        badgeClass = "badge-unpaid";
      } else if (loan.type === "loan_given") {
        typeLabel = "Loan (We Lent)";
        badgeClass = "badge-partial";
      }
      
      const typeSpan = document.createElement('span');
      typeSpan.className = `status-badge ${badgeClass}`;
      typeSpan.textContent = typeLabel;
      tdType.appendChild(typeSpan);
      
      const tdTarget = document.createElement('td');
      tdTarget.textContent = formatCurrency(loan.targetAmount);
      
      const tdPaid = document.createElement('td');
      tdPaid.textContent = formatCurrency(loan.paidAmount);
      
      const tdBalance = document.createElement('td');
      const balance = Math.max(0, loan.targetAmount - loan.paidAmount);
      tdBalance.textContent = formatCurrency(balance);
      if (balance > 0) {
        tdBalance.style.color = 'var(--apple-red-solid)';
        tdBalance.style.fontWeight = '600';
      }
      
      const tdNotes = document.createElement('td');
      tdNotes.textContent = loan.notes || '';
      
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'right';
      
      // Edit button
      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn btn-secondary';
      btnEdit.style.padding = '4px 8px';
      btnEdit.style.marginRight = '6px';
      btnEdit.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
      btnEdit.addEventListener('click', () => {
        openEditLoanModal(loan);
      });
      tdActions.appendChild(btnEdit);
      
      // Delete button
      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn btn-danger';
      btnDelete.style.padding = '4px 8px';
      btnDelete.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      btnDelete.addEventListener('click', () => {
        if (confirm(`Remove Agreement "${loan.title}"?`)) {
          db.loansAndDeposits.splice(idx, 1);
          recalculateLedger();
          renderGrid();
          renderGovernance();
        }
      });
      tdActions.appendChild(btnDelete);
      
      tr.appendChild(tdTitle);
      tr.appendChild(tdType);
      tr.appendChild(tdTarget);
      tr.appendChild(tdPaid);
      tr.appendChild(tdBalance);
      tr.appendChild(tdNotes);
      tr.appendChild(tdActions);
      loanVaultBody.appendChild(tr);
    });
  }
}

landlordBaseRent.addEventListener('change', (e) => {
  db.landlordLease.baseRent = Math.max(0, parseFloat(e.target.value) || 0);
  recalculateLedger();
  renderGrid();
  renderGovernance();
});

// Fixed Deposit Modal Logic
if(btnAddFd) {
  btnAddFd.addEventListener('click', () => {
    document.getElementById('fd-bank').value = '';
    document.getElementById('fd-account').value = '';
    document.getElementById('fd-principal').value = '';
    document.getElementById('fd-maturity').value = '';
    document.getElementById('fd-rate').value = '';
    document.getElementById('fd-notes').value = '';
    modalFd.classList.add('active');
  });

  const closeFdModal = () => modalFd.classList.remove('active');
  document.getElementById('modal-fd-close-x').addEventListener('click', closeFdModal);
  document.getElementById('modal-fd-cancel-btn').addEventListener('click', closeFdModal);

  fdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const bank = document.getElementById('fd-bank').value.trim();
    const account = document.getElementById('fd-account').value.trim();
    const principal = parseFloat(document.getElementById('fd-principal').value) || 0;
    const maturity = document.getElementById('fd-maturity').value;
    const rate = parseFloat(document.getElementById('fd-rate').value) || 0;
    const notes = document.getElementById('fd-notes').value.trim();
    
    if (!bank || principal <= 0 || !maturity) {
      alert("Please fill out all required fields.");
      return;
    }
    
    db.fixedDeposits.push({
      id: 'fd_' + Date.now(),
      bank,
      account,
      principal,
      maturity,
      rate,
      notes,
      updatedAt: Date.now()
    });
    
    closeFdModal();
    recalculateLedger();
    renderGrid();
    renderGovernance();
  });
}

// Loans & Deposits Modal UI & Event Listeners
const modalLoan = document.getElementById('modal-loan');
const btnAddLoan = document.getElementById('btn-add-loan');
const loanForm = document.getElementById('loan-form');
const loanIdHidden = document.getElementById('loan-id-hidden');
const loanTitle = document.getElementById('loan-title');
const loanType = document.getElementById('loan-type');
const loanTarget = document.getElementById('loan-target');
const loanNotes = document.getElementById('loan-notes');
const btnSaveLoan = document.getElementById('btn-save-loan');
const modalLoanTitle = document.getElementById('modal-loan-title');

let tempLoanPayments = [];

function renderTempPayments() {
  const tbody = document.getElementById('loan-payments-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  let totalPaid = 0;
  
  // Sort payments by date chronologically
  tempLoanPayments.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  tempLoanPayments.forEach(p => {
    totalPaid += p.amount;
    
    const tr = document.createElement('tr');
    
    const tdDate = document.createElement('td');
    tdDate.textContent = p.date;
    
    const tdAmount = document.createElement('td');
    tdAmount.textContent = formatCurrency(p.amount);
    
    const tdAction = document.createElement('td');
    tdAction.style.textAlign = 'center';
    
    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-delete-payment';
    btnDel.innerHTML = '&times;';
    btnDel.title = 'Delete payment';
    btnDel.addEventListener('click', () => {
      tempLoanPayments = tempLoanPayments.filter(item => item.id !== p.id);
      renderTempPayments();
    });
    
    tdAction.appendChild(btnDel);
    tr.appendChild(tdDate);
    tr.appendChild(tdAmount);
    tr.appendChild(tdAction);
    tbody.appendChild(tr);
  });
  
  if (tempLoanPayments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--apple-secondary);padding:12px;">No payments recorded.</td></tr>`;
  }
  
  // Update Live Totals
  const targetVal = parseFloat(loanTarget.value) || 0;
  const remainingVal = Math.max(0, targetVal - totalPaid);
  
  document.getElementById('summary-loan-target').textContent = formatCurrency(targetVal);
  document.getElementById('summary-loan-paid').textContent = formatCurrency(totalPaid);
  const remainingEl = document.getElementById('summary-loan-remaining');
  remainingEl.textContent = formatCurrency(remainingVal);
  if (remainingVal > 0) {
    remainingEl.className = 'val remaining';
  } else {
    remainingEl.className = 'val settled';
  }
}

if (loanTarget) {
  loanTarget.addEventListener('input', renderTempPayments);
}

// Add payment button listener
const btnAddLoanPayment = document.getElementById('btn-add-loan-payment');
if (btnAddLoanPayment) {
  btnAddLoanPayment.addEventListener('click', () => {
    const dateInput = document.getElementById('new-payment-date');
    const amountInput = document.getElementById('new-payment-amount');
    
    const dateVal = dateInput.value;
    const amountVal = parseFloat(amountInput.value) || 0;
    
    if (!dateVal) {
      alert("Please select a payment date.");
      return;
    }
    if (amountVal <= 0) {
      alert("Please enter a valid payment amount.");
      return;
    }
    
    tempLoanPayments.push({
      id: 'pay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      amount: amountVal,
      date: dateVal
    });
    
    amountInput.value = '';
    renderTempPayments();
  });
}

if (btnAddLoan) {
  btnAddLoan.addEventListener('click', () => {
    modalLoanTitle.textContent = "Log Capital Loan / Deposit";
    btnSaveLoan.textContent = "Save Agreement";
    loanIdHidden.value = "";
    loanTitle.value = "";
    loanType.value = "deposit";
    loanTarget.value = "";
    loanNotes.value = "";
    document.getElementById('new-payment-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('new-payment-amount').value = '';
    tempLoanPayments = [];
    renderTempPayments();
    modalLoan.classList.add('active');
  });

  const closeLoanModal = () => modalLoan.classList.remove('active');
  document.getElementById('modal-loan-close-x').addEventListener('click', closeLoanModal);
  document.getElementById('modal-loan-cancel-btn').addEventListener('click', closeLoanModal);

  loanForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const id = loanIdHidden.value;
    const title = loanTitle.value.trim();
    const type = loanType.value;
    const targetVal = parseFloat(loanTarget.value) || 0;
    const notesVal = loanNotes.value.trim();
    
    if (!title || targetVal <= 0) {
      alert("Please fill out all required fields.");
      return;
    }
    
    db.loansAndDeposits = db.loansAndDeposits || [];
    
    // Calculate dynamically from the temp array
    const paidVal = tempLoanPayments.reduce((sum, p) => sum + p.amount, 0);
    
    if (id) {
      const loan = db.loansAndDeposits.find(l => l.id === id);
      if (loan) {
        loan.title = title;
        loan.type = type;
        loan.targetAmount = targetVal;
        loan.paidAmount = paidVal;
        loan.payments = tempLoanPayments;
        loan.notes = notesVal;
        loan.updatedAt = Date.now();
      }
    } else {
      db.loansAndDeposits.push({
        id: 'loan_' + Date.now(),
        title,
        type,
        targetAmount: targetVal,
        paidAmount: paidVal,
        payments: tempLoanPayments,
        notes: notesVal,
        updatedAt: Date.now()
      });
    }
    
    closeLoanModal();
    recalculateLedger();
    renderGrid();
    renderGovernance();
  });
}

function openEditLoanModal(loan) {
  modalLoanTitle.textContent = "Edit Capital Loan / Deposit";
  btnSaveLoan.textContent = "Save Changes";
  loanIdHidden.value = loan.id;
  loanTitle.value = loan.title;
  loanType.value = loan.type;
  loanTarget.value = loan.targetAmount.toFixed(2);
  loanNotes.value = loan.notes || "";
  document.getElementById('new-payment-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('new-payment-amount').value = '';
  
  // Clone existing payments
  tempLoanPayments = JSON.parse(JSON.stringify(loan.payments || []));
  renderTempPayments();
  modalLoan.classList.add('active');
}

// Start application
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
