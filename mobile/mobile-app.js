/* =============================================
   CHURCH LEDGER — MOBILE APP v3.0
   Per-Device Personal Profiles + PIN-Protected Church Access

   Architecture:
   • Each phone has its own personal ledger (device ID based)
   • Church ledger is shared & PIN-protected
   • Personal data stored at: Firebase /personal/{deviceId}.json
     OR local server /api/personal/{deviceId}
   • Church data stored at: Firebase /data.json OR /api/data
   • Church PIN fetched from: Firebase /config.json OR /api/config
   ============================================= */

'use strict';

// ─── DEFAULT CONFIG ────────────────────────────────────────────
const DEFAULT_FIREBASE_URL = 'https://church-ledger-e11f1-default-rtdb.asia-southeast1.firebasedatabase.app';

// ─── STATE ─────────────────────────────────────────────────────
let personalDb = null;   // this phone's personal ledger
let churchDb   = null;   // shared church ledger
let db         = null;   // pointer to whichever is currently active
let currentMode  = 'personal'; // 'personal' | 'church'
let currentTab   = 'dashboard';
let churchUnlocked = false;    // PIN entered this session
let pinFailures    = 0;
let pinLockUntil   = 0;
let pollIntervalPersonal = null;
let pollIntervalChurch   = null;
let adminEventSource     = null; // Firebase SSE for admin monitoring
let adminLastSeen        = Date.now();
let approvedAdminDeviceId = localStorage.getItem('ledger_approved_admin_device_id') || '';
let adminRequestInterval = null;
const POLL_MS = 15000;

// ─── DEVICE IDENTITY ───────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('ledger_device_id');
  if (!id) {
    id = 'dev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('ledger_device_id', id);
  }
  return id;
}
function getPersonalName() { return localStorage.getItem('ledger_personal_name') || ''; }
function setPersonalName(n) { localStorage.setItem('ledger_personal_name', n.trim()); }
function isFirstLaunch() { return !localStorage.getItem('ledger_personal_name'); }

// ─── CONNECTION ─────────────────────────────────────────────────
// Single church URL used for both church data and personal sub-paths
function getChurchUrl()  {
  const stored = (localStorage.getItem('church_firebase_url') || '').trim().replace(/\/$/, '');
  return stored || DEFAULT_FIREBASE_URL; // Auto-use default if not set
}
function setChurchUrl(u) { localStorage.setItem('church_firebase_url', u.trim().replace(/\/$/, '')); }
function getServerUrl()  {
  const stored = localStorage.getItem('ledger_server_url');
  if (stored) return stored.trim().replace(/\/$/, '');
  if (window.location.protocol.startsWith('http') && 
      !window.location.hostname.includes('firebase') && 
      !window.location.hostname.includes('web.app')) {
    return window.location.origin;
  }
  return '';
}
function setServerUrl(u) { localStorage.setItem('ledger_server_url', u.trim().replace(/\/$/, '')); }
function useCloud() { return !getServerUrl(); } // Cloud if no local server set
function hasConnection() { return true; } // Always has default Firebase
// Admin device
function isAdminDevice() {
  return localStorage.getItem('ledger_is_admin') === 'true' && getDeviceId() === approvedAdminDeviceId;
}
function setAdminDevice(v) {
  localStorage.setItem('ledger_is_admin', v ? 'true' : 'false');
  if (!v) {
    localStorage.removeItem('ledger_approved_admin_device_id');
    approvedAdminDeviceId = '';
  }
}

function personalDataUrl() {
  const devId = getDeviceId();
  if (useCloud()) return `${getChurchUrl()}/personal/${devId}.json`;
  if (getServerUrl()) return `${getServerUrl()}/api/personal/${devId}`;
  return null;
}
function churchDataUrl() {
  if (useCloud()) return `${getChurchUrl()}/data.json`;
  if (getServerUrl()) return `${getServerUrl()}/api/data`;
  return null;
}
function configUrl() {
  if (useCloud()) return `${getChurchUrl()}/config.json`;
  if (getServerUrl()) return `${getServerUrl()}/api/config`;
  return null;
}

async function loadConfig() {
  const cfgUrl = configUrl();
  if (cfgUrl) {
    try {
      const resp = await fetch(cfgUrl, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
        const cfg = await resp.json();
        if (cfg) {
          if (cfg.approvedAdminDeviceId) {
            approvedAdminDeviceId = cfg.approvedAdminDeviceId;
            localStorage.setItem('ledger_approved_admin_device_id', approvedAdminDeviceId);
          } else {
            approvedAdminDeviceId = '';
            localStorage.removeItem('ledger_approved_admin_device_id');
          }
          updateAdminStatus();
        }
      }
    } catch(e) {}
  }
}

function startPollingAdminRequest() {
  if (adminRequestInterval) clearInterval(adminRequestInterval);
  adminRequestInterval = setInterval(async () => {
    if (localStorage.getItem('ledger_admin_request_status') !== 'pending') {
      clearInterval(adminRequestInterval);
      adminRequestInterval = null;
      return;
    }
    try {
      let status = null;
      if (useCloud()) {
        const resp = await fetch(`${getChurchUrl()}/admin_requests/${getDeviceId()}.json`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.json();
          status = data ? data.status : null;
        }
      } else if (getServerUrl()) {
        const resp = await fetch(`${getServerUrl()}/api/admin/request/${getDeviceId()}`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const data = await resp.json();
          status = data ? data.status : null;
        }
      }
      
      if (status === 'approved') {
        clearInterval(adminRequestInterval);
        adminRequestInterval = null;
        localStorage.removeItem('ledger_admin_request_status');
        localStorage.setItem('ledger_is_admin', 'true');
        approvedAdminDeviceId = getDeviceId();
        localStorage.setItem('ledger_approved_admin_device_id', approvedAdminDeviceId);
        startAdminMonitoring();
        updateAdminStatus();
        showToast('🛡️ Admin status approved! Real-time alerts activated.');
      } else if (status === 'denied') {
        clearInterval(adminRequestInterval);
        adminRequestInterval = null;
        localStorage.removeItem('ledger_admin_request_status');
        setAdminDevice(false);
        updateAdminStatus();
        showToast('❌ Admin request denied by laptop.');
      }
    } catch(e) {}
  }, 3000);
}

// ─── INIT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Auto-set default Firebase URL if not already set
  if (!localStorage.getItem('church_firebase_url')) {
    setChurchUrl(DEFAULT_FIREBASE_URL);
  }

  updateHeroDate();
  injectSettingsUI();
  injectModals();
  updateProfileHeader();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (isFirstLaunch()) {
    showFirstLaunchSetup();
  } else {
    loadPersonalData(true);
  }

  // Fetch initial config and check admin request status
  loadConfig().then(() => {
    if (localStorage.getItem('ledger_admin_request_status') === 'pending') {
      startPollingAdminRequest();
    } else if (isAdminDevice()) {
      startAdminMonitoring();
    }
  });

  startPolling();
});

function updateHeroDate() {
  const el = document.getElementById('hero-date');
  if (el) el.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── FIRST LAUNCH SETUP ─────────────────────────────────────────
function showFirstLaunchSetup() {
  const backdrop = document.getElementById('modal-backdrop') || createModalBackdrop();
  backdrop.style.display = 'flex';
  document.getElementById('modal-content').innerHTML = `
    <div style="text-align:center;margin-bottom:22px;">
      <div style="font-size:40px;margin-bottom:10px;">📒</div>
      <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:6px;">WELCOME</div>
      <div style="font-size:20px;font-weight:800;color:#f0f0f5;">Set Up Your Profile</div>
      <div style="font-size:13px;color:#56566a;margin-top:8px;">Your personal ledger is private to this device.<br>Only you can see your data.</div>
    </div>
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">YOUR NAME</label>
    <input id="first-launch-name" type="text" placeholder="e.g. John" maxlength="30"
      style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:18px;font-weight:700;padding:13px 14px;outline:none;margin-bottom:16px;text-align:center;">
    <button onclick="completeFirstLaunch()"
      style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:16px;padding:14px;border:none;border-radius:12px;cursor:pointer;">
      Create My Profile →
    </button>
    <div id="first-launch-err" style="text-align:center;font-size:12px;color:#ff6b6b;margin-top:8px;min-height:16px;"></div>`;
  setTimeout(() => { const i = document.getElementById('first-launch-name'); if (i) i.focus(); }, 100);
}

function createModalBackdrop() {
  const m = document.createElement('div');
  m.id = 'modal-backdrop';
  m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);backdrop-filter:blur(12px);z-index:8888;align-items:center;justify-content:center;';
  m.innerHTML = `<div id="modal-box" style="background:#1c1c28;border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:28px 22px;width:92%;max-width:420px;box-shadow:0 24px 60px rgba(0,0,0,0.6);max-height:90vh;overflow-y:auto;"><div id="modal-content"></div></div>`;
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target === m) closeModal(); });
  return m;
}

function completeFirstLaunch() {
  const nameEl = document.getElementById('first-launch-name');
  const errEl  = document.getElementById('first-launch-err');
  const name   = nameEl ? nameEl.value.trim() : '';
  if (!name) { if (errEl) { errEl.textContent = 'Please enter your name.'; } return; }
  setPersonalName(name);
  getDeviceId(); // ensure deviceId is created
  closeModal();
  updateProfileHeader();
  if (hasConnection()) {
    loadPersonalData(true);
  } else {
    showSettings(true);
    setSyncStatus('setup');
  }
}

// ─── PROFILE HEADER UI ──────────────────────────────────────────
function updateProfileHeader() {
  const titleEl = document.getElementById('page-title');
  if (!titleEl) return;
  const name = getPersonalName() || 'My Profile';
  if (currentMode === 'church') {
    titleEl.textContent = '⛪ Church';
  } else {
    titleEl.textContent = `👤 ${name}`;
  }
}

function injectProfileSwitcherBtn() {
  const bar = document.querySelector('.top-bar-inner');
  if (!bar || document.getElementById('church-access-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'church-access-btn';
  btn.onclick = () => currentMode === 'church' ? switchToPersonal() : accessChurch();
  btn.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.12);border-radius:8px;cursor:pointer;color:#f0f0f5;padding:4px 10px;display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;';
  updateChurchBtn(btn);
  bar.insertBefore(btn, bar.firstChild);
}

function updateChurchBtn(btn) {
  if (!btn) btn = document.getElementById('church-access-btn');
  if (!btn) return;
  if (currentMode === 'church') {
    btn.innerHTML = '← 👤 My Profile';
    btn.style.color = '#7c7cff';
    btn.style.borderColor = 'rgba(108,108,255,0.3)';
  } else {
    btn.innerHTML = '⛪ Church';
    btn.style.color = '#f0c040';
    btn.style.borderColor = 'rgba(240,192,64,0.3)';
  }
}

// ─── CHURCH PIN ACCESS ──────────────────────────────────────────
function accessChurch() {
  if (churchUnlocked) {
    enterChurchMode();
    return;
  }
  const now = Date.now();
  if (now < pinLockUntil) {
    const secsLeft = Math.ceil((pinLockUntil - now) / 1000);
    showPinModal(`Too many attempts. Try again in ${secsLeft}s.`, true);
    return;
  }
  showPinModal('', false);
}

function showPinModal(errorMsg, locked) {
  openModal(`
    <div style="text-align:center;margin-bottom:20px;">
      <div style="font-size:36px;margin-bottom:8px;">⛪</div>
      <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#f0c040;margin-bottom:4px;">CHURCH ACCESS</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">Redemption House of Prayer</div>
      <div style="font-size:13px;color:#56566a;margin-top:6px;">Enter PIN to access shared church ledger</div>
    </div>
    ${locked ? '' : `
    <div style="display:flex;justify-content:center;margin-bottom:16px;">
      <input id="church-pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8"
        placeholder="• • • •"
        style="background:rgba(255,255,255,0.07);border:2px solid rgba(240,192,64,0.4);border-radius:12px;color:#f0f0f5;font-size:28px;font-weight:700;padding:14px 20px;outline:none;text-align:center;width:180px;letter-spacing:8px;"
        onkeydown="if(event.key==='Enter')verifyChurchPin()">
    </div>
    <button onclick="verifyChurchPin()"
      style="width:100%;background:linear-gradient(135deg,#f0c040,#e08020);color:#111;font-weight:800;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">
      Unlock Church ⛪
    </button>`}
    <div id="pin-error" style="text-align:center;font-size:13px;color:#ff6b6b;min-height:20px;margin-bottom:8px;">${errorMsg}</div>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:12px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
  if (!locked) setTimeout(() => { const i = document.getElementById('church-pin-input'); if (i) i.focus(); }, 100);
}

async function verifyChurchPin() {
  const now = Date.now();
  if (now < pinLockUntil) {
    const secsLeft = Math.ceil((pinLockUntil - now) / 1000);
    document.getElementById('pin-error').textContent = `Locked. Try again in ${secsLeft}s.`;
    return;
  }

  const input = document.getElementById('church-pin-input');
  const pin = input ? input.value.trim() : '';
  if (!pin) { document.getElementById('pin-error').textContent = 'Please enter the PIN.'; return; }

  // Show loading
  const errEl = document.getElementById('pin-error');
  if (errEl) { errEl.textContent = 'Verifying…'; errEl.style.color = '#7c7cff'; }

  try {
    let storedPin = localStorage.getItem('ledger_church_pin');
    let connectionFailed = false;
    
    const cfgUrl = configUrl();
    if (cfgUrl) {
      try {
        const resp = await fetch(cfgUrl, { signal: AbortSignal.timeout(4000) });
        if (resp.ok) {
          const cfg = await resp.json();
          if (cfg && cfg.churchPin) {
            storedPin = cfg.churchPin;
            localStorage.setItem('ledger_church_pin', storedPin);
          }
        } else {
          connectionFailed = true;
        }
      } catch(e) {
        connectionFailed = true;
      }
    } else {
      connectionFailed = true;
    }
    
    if (!storedPin) storedPin = '1234'; // Default PIN fallback

    const success = (String(pin).trim() === String(storedPin).trim());
    
    // Log this attempt to Firebase for admin notification
    logChurchAccessAttempt(success).catch(() => {});

    if (success) {
      pinFailures = 0;
      churchUnlocked = true;
      closeModal();
      await loadChurchData(true);
    } else {
      pinFailures++;
      if (pinFailures >= 3) {
        pinLockUntil = Date.now() + 30000; // 30 second lockout
        pinFailures = 0;
        closeModal();
        showPinModal('Too many wrong attempts. Locked for 30 seconds.', true);
      } else {
        if (errEl) {
          let errorText = `Wrong PIN. ${3 - pinFailures} attempt(s) left.`;
          if (connectionFailed) {
            errorText += `<br><span style="font-size:10px;color:#ff9f0a;font-weight:600;">⚠️ Connection to server failed. Using offline cache.</span>`;
          }
          errEl.innerHTML = errorText;
          errEl.style.color = '#ff6b6b';
        }
        if (input) { input.value = ''; input.focus(); }
      }
    }
  } catch (err) {
    if (errEl) { errEl.textContent = 'Cannot verify PIN. Try again.'; errEl.style.color = '#ff6b6b'; }
  }
}

// ─── MODE SWITCHING ─────────────────────────────────────────────
function normalizeLoans() {
  if (db && db.loansAndDeposits) {
    db.loansAndDeposits.forEach(loan => {
      if (!loan.payments) loan.payments = [];
      if (loan.paidAmount > 0 && loan.payments.length === 0) {
        loan.payments.push({
          id: 'pay_default_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
          amount: parseFloat(loan.paidAmount) || 0,
          date: '2025-12-01'
        });
      }
    });
  }
}

function enterChurchMode() {
  currentMode = 'church';
  db = churchDb;
  normalizeLoans();
  updateProfileHeader();
  updateChurchBtn();
  // Show all tabs in church mode
  const tabTenants = document.getElementById('tab-tenants');
  const tabGov     = document.getElementById('tab-governance');
  if (tabTenants) tabTenants.style.display = 'flex';
  if (tabGov)     tabGov.style.display = 'flex';
  // Switch to dashboard
  switchTab('dashboard');
  setSyncStatus('live');
}

function switchToPersonal() {
  currentMode = 'personal';
  db = personalDb;
  normalizeLoans();
  updateProfileHeader();
  updateChurchBtn();
  applyMobileProfileCustomizations();
  switchTab('dashboard');
  setSyncStatus(personalDb ? 'live' : 'offline');
}

function switchToChurch() {
  if (!churchUnlocked) { accessChurch(); return; }
  enterChurchMode();
}

// ─── SETTINGS OVERLAY ───────────────────────────────────────────
function injectSettingsUI() {
  const overlay = document.createElement('div');
  overlay.id = 'settings-overlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.88);backdrop-filter:blur(12px);z-index:9999;align-items:center;justify-content:center;overflow-y:auto;padding:20px 0;box-sizing:border-box;';
  overlay.innerHTML = `
    <div style="background:#1c1c28;border:1px solid rgba(124,124,255,0.25);border-radius:20px;padding:28px 22px;width:90%;max-width:400px;box-shadow:0 24px 60px rgba(0,0,0,0.6);">
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:6px;">SETTINGS</div>
        <div style="font-size:19px;font-weight:800;color:#f0f0f5;">Church Ledger</div>
      </div>

      <!-- Personal profile name -->
      <div style="background:rgba(108,108,255,0.08);border:1px solid rgba(108,108,255,0.2);border-radius:12px;padding:14px;margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:#7c7cff;margin-bottom:8px;">👤 YOUR PROFILE NAME</div>
        <input id="settings-personal-name" type="text" placeholder="Your name" maxlength="30"
          style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:#f0f0f5;font-size:15px;padding:10px 12px;outline:none;margin-bottom:8px;">
        <button onclick="savePersonalName()" style="width:100%;background:rgba(108,108,255,0.3);color:#fff;font-weight:700;font-size:13px;padding:9px;border:none;border-radius:8px;cursor:pointer;">Save Name</button>
      </div>

      <!-- Church connection -->
      <div style="background:rgba(240,192,64,0.06);border:1px solid rgba(240,192,64,0.2);border-radius:12px;padding:14px;margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:#f0c040;margin-bottom:8px;">⛪ CHURCH FIREBASE URL</div>
        <div style="font-size:12px;color:#8888aa;margin-bottom:8px;">Used for church data AND your personal ledger sub-path.</div>
        <input id="settings-cloud-url" type="url" inputmode="url" placeholder="https://your-project-default-rtdb.firebaseio.com"
          style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:#f0f0f5;font-size:12px;padding:10px 12px;outline:none;font-family:monospace;margin-bottom:6px;">
        <button onclick="saveSettingsCloud()" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:14px;padding:12px;border:none;border-radius:10px;cursor:pointer;">Connect via Cloud ☁️</button>
      </div>

      <div style="text-align:center;color:#444;font-size:11px;margin:10px 0;">— OR —</div>

      <!-- Local server -->
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;margin-bottom:14px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:#56566a;margin-bottom:8px;">📡 LOCAL NETWORK (Same WiFi as laptop)</div>
        <input id="settings-server-url" type="url" inputmode="url" placeholder="http://192.168.x.x:3000"
          style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:#f0f0f5;font-size:13px;padding:10px 12px;outline:none;font-family:monospace;margin-bottom:6px;">
        <button onclick="saveSettingsLocal()" style="width:100%;background:rgba(255,255,255,0.08);color:#aaa;font-weight:700;font-size:13px;padding:11px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;cursor:pointer;">Connect via Local IP 📡</button>
      </div>

      <!-- Admin Device Section -->
      <div style="background:rgba(255,159,10,0.05);border:1px solid rgba(255,159,10,0.15);border-radius:12px;padding:14px;margin-bottom:14px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:#ff9f0a;margin-bottom:8px;">🛡️ ADMIN DEVICE OPTIONS</div>
        <div id="admin-status-text" style="font-size:11px;color:#56566a;margin-bottom:8px;line-height:1.4;">Not admin. Tap below to receive church access alerts on this phone.</div>
        <button id="admin-toggle-btn" onclick="toggleAdminDevice()" style="width:100%;background:rgba(255,159,10,0.1);border:1px solid rgba(255,159,10,0.3);color:#ff9f0a;font-weight:700;font-size:13px;padding:11px;border-radius:10px;cursor:pointer;transition:all 0.2s;">🛡️ Set as Admin Device</button>
      </div>

      <button id="settings-cancel-btn" onclick="showSettings(false)" style="width:100%;background:transparent;color:#56566a;font-size:12px;padding:8px;border:none;cursor:pointer;">Close</button>
      <div id="settings-status" style="text-align:center;font-size:12px;margin-top:8px;color:#56566a;min-height:18px;"></div>
    </div>`;
  document.body.appendChild(overlay);

  // Gear button in top bar
  const bar = document.querySelector('.top-bar-inner');
  if (bar) {
    const gearBtn = document.createElement('button');
    gearBtn.id = 'settings-gear-btn';
    gearBtn.onclick = () => showSettings(true);
    gearBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:#56566a;padding:4px 8px;display:flex;align-items:center;';
    gearBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
    bar.appendChild(gearBtn);

    // Church access button
    const churchBtn = document.createElement('button');
    churchBtn.id = 'church-access-btn';
    churchBtn.onclick = () => currentMode === 'church' ? switchToPersonal() : accessChurch();
    churchBtn.style.cssText = 'background:none;border:1px solid rgba(240,192,64,0.3);border-radius:8px;cursor:pointer;color:#f0c040;padding:4px 10px;display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;margin-right:4px;';
    churchBtn.innerHTML = '⛪ Church';
    bar.insertBefore(churchBtn, bar.firstChild);
  }
}

function showSettings(show) {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;
  overlay.style.display = show ? 'flex' : 'none';
  if (show) {
    const ci = document.getElementById('settings-cloud-url');
    const si = document.getElementById('settings-server-url');
    const ni = document.getElementById('settings-personal-name');
    if (ci) ci.value = getChurchUrl();
    if (si) si.value = getServerUrl();
    if (ni) ni.value = getPersonalName();
    const st = document.getElementById('settings-status');
    if (st) st.textContent = '';
    updateAdminStatus();
  }
}

function savePersonalName() {
  const ni = document.getElementById('settings-personal-name');
  const name = ni ? ni.value.trim() : '';
  if (!name) { showToast('Please enter a name.'); return; }
  setPersonalName(name);
  // Also update the personal database name field
  if (personalDb) personalDb.name = name;
  updateProfileHeader();
  showToast(`Name saved: ${name} ✓`);
  // Push update to server with new name
  if (personalDb) syncPersonalToServer(personalDb).catch(() => {});
}

async function saveSettingsCloud() {
  const input = document.getElementById('settings-cloud-url');
  const statusEl = document.getElementById('settings-status');
  const url = (input ? input.value : '').trim().replace(/\/$/, '');
  if (!url) { if (statusEl) { statusEl.textContent = 'Please enter a Firebase URL.'; statusEl.style.color = '#ff6b6b'; } return; }
  if (statusEl) { statusEl.textContent = 'Testing connection…'; statusEl.style.color = '#7c7cff'; }
  try {
    const resp = await fetch(`${url}/data.json?shallow=true`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error('Bad response');
    setChurchUrl(url);
    localStorage.removeItem('ledger_server_url');
    if (statusEl) { statusEl.textContent = '✓ Connected!'; statusEl.style.color = '#4ecb71'; }
    setTimeout(() => { showSettings(false); loadPersonalData(true); }, 800);
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Cannot reach Firebase. Check URL.'; statusEl.style.color = '#ff6b6b'; }
  }
}

async function saveSettingsLocal() {
  const input = document.getElementById('settings-server-url');
  const statusEl = document.getElementById('settings-status');
  const url = (input ? input.value : '').trim().replace(/\/$/, '');
  if (!url) { if (statusEl) { statusEl.textContent = 'Please enter a server URL.'; statusEl.style.color = '#ff6b6b'; } return; }
  if (statusEl) { statusEl.textContent = 'Connecting…'; statusEl.style.color = '#7c7cff'; }
  try {
    const resp = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) throw new Error('Bad response');
    setServerUrl(url);
    localStorage.removeItem('church_firebase_url');
    if (statusEl) { statusEl.textContent = '✓ Connected!'; statusEl.style.color = '#4ecb71'; }
    setTimeout(() => { showSettings(false); loadPersonalData(true); }, 800);
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Cannot reach server. Check IP and WiFi.'; statusEl.style.color = '#ff6b6b'; }
  }
}

// ─── MODALS ─────────────────────────────────────────────────────
function injectModals() {
  if (!document.getElementById('modal-backdrop')) createModalBackdrop();
}

function openModal(html) {
  const bd = document.getElementById('modal-backdrop');
  if (!bd) { createModalBackdrop(); }
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-backdrop').style.display = 'flex';
}
function closeModal() {
  const bd = document.getElementById('modal-backdrop');
  if (bd) bd.style.display = 'none';
}

// ─── DATA FETCHING — PERSONAL ────────────────────────────────────
async function loadPersonalData(initial = false) {
  try {
    const pUrl = personalDataUrl();
    let serverRecord = null;

    if (pUrl) {
      if (useCloud()) {
        const resp = await fetch(pUrl, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        if (resp.ok) serverRecord = await resp.json();
      } else {
        const resp = await fetch(pUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (resp.ok) serverRecord = await resp.json();
      }
    }

    const name = getPersonalName();
    const devId = getDeviceId();

    if (!serverRecord || !serverRecord.data) {
      // No remote personal data yet — create it
      const newData = seedPersonalDatabase();
      personalDb = { name, deviceId: devId, data: newData };
      await syncPersonalToServer(personalDb);
    } else {
      personalDb = serverRecord;
      // Keep name in sync
      if (personalDb.name !== name) {
        personalDb.name = name;
      }
      // Ensure data property has profileType
      if (!personalDb.data) personalDb.data = seedPersonalDatabase();
      if (!personalDb.data.profileType) personalDb.data.profileType = 'personal';
    }

    localStorage.setItem('ledger_personal_cache', JSON.stringify(personalDb));
    if (currentMode === 'personal') {
      db = personalDb.data;
      if (initial) { renderAll(); injectProfileSwitcherBtn(); }
      else renderCurrentTab();
      setSyncStatus('live');
    }
  } catch (err) {
    console.warn('[Personal Sync] Offline — using local cache', err);
    const cached = localStorage.getItem('ledger_personal_cache');
    if (cached) {
      personalDb = JSON.parse(cached);
      if (currentMode === 'personal') {
        db = personalDb.data;
        if (initial) { renderAll(); injectProfileSwitcherBtn(); }
        else renderCurrentTab();
        setSyncStatus('offline');
      }
    } else {
      setSyncStatus('setup');
    }
  }
}

// ─── DATA FETCHING — CHURCH ──────────────────────────────────────
async function loadChurchData(initial = false) {
  try {
    const cUrl = churchDataUrl();
    if (!cUrl) throw new Error('No church URL');

    let serverData;
    if (useCloud()) {
      const resp = await fetch(cUrl, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      serverData = await resp.json();
      if (!serverData || !serverData.weeks) throw new Error('Empty church data');
    } else {
      const resp = await fetch(cUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      serverData = await resp.json();
    }

    churchDb = serverData;
    if (!churchDb.profileType) churchDb.profileType = 'church';
    localStorage.setItem('ledger_church_cache', JSON.stringify(churchDb));

    if (initial || currentMode === 'church') {
      enterChurchMode();
    }
  } catch (err) {
    console.warn('[Church Sync] Offline — using local cache', err);
    const cached = localStorage.getItem('ledger_church_cache');
    if (cached) {
      churchDb = JSON.parse(cached);
      if (initial || currentMode === 'church') enterChurchMode();
      setSyncStatus('offline');
    } else {
      showToast('Cannot load church data. Check connection.');
      setSyncStatus('offline');
    }
  }
}

// ─── DATA SYNC ───────────────────────────────────────────────────
async function syncPersonalToServer(record) {
  const pUrl = personalDataUrl();
  if (!pUrl) return;
  localStorage.setItem('ledger_personal_cache', JSON.stringify(record));

  if (useCloud()) {
    await fetch(pUrl, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record), signal: AbortSignal.timeout(6000)
    });
  } else {
    await fetch(pUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record), signal: AbortSignal.timeout(5000)
    });
  }
}

async function syncChurchToServer(data) {
  const cUrl = churchDataUrl();
  if (!cUrl) return data;
  localStorage.setItem('ledger_church_cache', JSON.stringify(data));

  if (useCloud()) {
    const resp = await fetch(cUrl, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(6000)
    });
    if (resp.ok) { churchDb = await resp.json() || data; }
  } else {
    const resp = await fetch(cUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) { churchDb = await resp.json() || data; }
  }
  return churchDb || data;
}

async function saveData() {
  try {
    if (currentMode === 'personal' && personalDb) {
      personalDb.data = db;
      await syncPersonalToServer(personalDb);
      showToast('Saved & Synced ✓');
      setSyncStatus('live');
    } else if (currentMode === 'church') {
      await syncChurchToServer(db);
      showToast('Church data saved ✓');
      setSyncStatus('live');
    }
  } catch (err) {
    showToast('Saved offline — will sync when connected');
    if (currentMode === 'personal') {
      localStorage.setItem('ledger_personal_cache', JSON.stringify(personalDb));
    } else {
      localStorage.setItem('ledger_church_cache', JSON.stringify(db));
    }
    setSyncStatus('offline');
  }
}

function startPolling() {
  if (pollIntervalPersonal) clearInterval(pollIntervalPersonal);
  pollIntervalPersonal = setInterval(() => {
    if (currentMode === 'personal') loadPersonalData(false);
  }, POLL_MS);

  if (pollIntervalChurch) clearInterval(pollIntervalChurch);
  pollIntervalChurch = setInterval(() => {
    if (currentMode === 'church') loadChurchData(false);
  }, POLL_MS);
}

// ─── SEED DATABASES ──────────────────────────────────────────────
function seedPersonalDatabase() {
  const days = getDaysOf2026();
  const weeks = {};
  days.forEach(d => {
    weeks[d.dateKey] = { sundayDate: d.dateKey, label: d.label, offering: 0, outgoings: [], customCells: {} };
  });
  return {
    profileType: 'personal',
    settings: {
      columns: [
        { id: 'date', label: 'Date', type: 'date', editable: false },
        { id: 'offering', label: 'Income', type: 'number', editable: true }
      ],
      tenantRates: {}, tenantNames: {}
    },
    landlordLease: { baseRent: 0, months: {} },
    fixedDeposits: [], months: {}, weeks, customSundays: []
  };
}

function getDaysOf2026() {
  const days = [];
  let d = new Date(2026, 0, 1);
  while (d.getFullYear() === 2026) {
    const yyyy = d.getFullYear(), mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    days.push({ dateKey: `${yyyy}-${mm}-${dd}`, label });
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// ─── SYNC STATUS ─────────────────────────────────────────────────
function setSyncStatus(status) {
  const badge = document.getElementById('sync-badge');
  const label = badge ? badge.querySelector('.sync-label') : null;
  if (!badge) return;
  badge.classList.remove('stale', 'error');
  if (status === 'live')    { if (label) label.textContent = useCloud() ? '☁ Live' : 'Live'; }
  else if (status === 'offline') { badge.classList.add('stale'); if (label) label.textContent = 'Offline'; }
  else if (status === 'setup')   { badge.classList.add('stale'); if (label) label.textContent = 'Setup'; }
  else { badge.classList.add('error'); if (label) label.textContent = 'No Data'; }
}

// ─── MERGE ───────────────────────────────────────────────────────
function mergeDatabases(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const merged = JSON.parse(JSON.stringify(remote));
  if (!merged.months) merged.months = {};
  const localMonths = local.months || {};
  Object.keys(localMonths).forEach(mKey => {
    if (!merged.months[mKey]) { merged.months[mKey] = JSON.parse(JSON.stringify(localMonths[mKey])); return; }
    const localTenants = localMonths[mKey].tenants || {};
    const serverTenants = merged.months[mKey].tenants || {};
    Object.keys(localTenants).forEach(tid => {
      const st = serverTenants[tid] || { updatedAt: 0 };
      const lt = localTenants[tid] || { updatedAt: 0 };
      if ((lt.updatedAt || 0) > (st.updatedAt || 0)) serverTenants[tid] = JSON.parse(JSON.stringify(lt));
    });
  });
  const localWeeks = local.weeks || {};
  Object.keys(localWeeks).forEach(wKey => {
    if (!merged.weeks) merged.weeks = {};
    if (!merged.weeks[wKey]) merged.weeks[wKey] = JSON.parse(JSON.stringify(localWeeks[wKey]));
  });

  // Helper to merge arrays by ID with LWW
  function mergeArrayById(localArray, remoteArray) {
    const res = [...(remoteArray || [])];
    const map = {};
    res.forEach(item => { if (item.id) map[item.id] = item; });
    (localArray || []).forEach(item => {
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

  merged.fixedDeposits = mergeArrayById(local.fixedDeposits, merged.fixedDeposits);
  merged.loansAndDeposits = mergeArrayById(local.loansAndDeposits, merged.loansAndDeposits);

  return merged;
}

// ─── CALCULATIONS ────────────────────────────────────────────────
function calcStats() {
  if (!db) return {};
  const weeks = db.weeks || {}, months = db.months || {}, settings = db.settings || {};
  const tenantRates = settings.tenantRates || {}, tenantNames = settings.tenantNames || {};
  const landlord = db.landlordLease || {}, fds = db.fixedDeposits || [];
  let totalCollections = 0, totalRentalRevenue = 0, totalExpenses = 0, totalLeasePayments = 0, totalCustomOutflows = 0;
  Object.keys(months).forEach(mKey => {
    const mData = months[mKey];
    if (!mData || !mData.tenants) return;
    Object.keys(mData.tenants).forEach(tid => {
      const t = mData.tenants[tid];
      if (t.paid) { const amt = parseFloat(t.amount) > 0 ? parseFloat(t.amount) : (parseFloat(tenantRates[tid]) || 0); totalRentalRevenue += amt; }
    });
  });
  Object.keys(weeks).forEach(dKey => {
    const w = weeks[dKey];
    totalCollections += parseFloat(w.offering) || 0;
    if (w.outgoings) w.outgoings.forEach(o => totalExpenses += parseFloat(o.amount) || 0);
    const customCols = (settings.columns || []).filter(c => c.type === 'outflow');
    customCols.forEach(col => { totalCustomOutflows += parseFloat((w.customCells || {})[col.id]) || 0; });
  });
  Object.values(landlord.months || {}).forEach(v => { totalLeasePayments += parseFloat(v) || 0; });
  let totalLoanOutflows = 0;
  if (db.loansAndDeposits && Array.isArray(db.loansAndDeposits)) {
    db.loansAndDeposits.forEach(loan => {
      if (loan.payments && Array.isArray(loan.payments)) {
        loan.payments.forEach(p => {
          if (p.date && p.date >= '2026-01-04') {
            totalLoanOutflows += parseFloat(p.amount) || 0;
          }
        });
      }
    });
  }
  totalExpenses += totalLeasePayments + totalCustomOutflows + totalLoanOutflows;
  const fixedReserves = fds.reduce((s, fd) => s + (parseFloat(fd.principal) || 0), 0);
  const liquidAssets = totalCollections + totalRentalRevenue - totalExpenses;
  return { liquidAssets, fixedReserves, totalCollections, totalRentalRevenue, totalExpenses, tenantNames, tenantRates };
}

function fmtRs(n) {
  const v = parseFloat(n) || 0;
  const sign = v < 0 ? '-' : '';
  return sign + 'Rs ' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtMonthName(mKey) { const [yr, mo] = mKey.split('-'); return new Date(parseInt(yr), parseInt(mo) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }

// ─── RENDER ALL ───────────────────────────────────────────────────
function renderAll() {
  if (db) {
    db.loansAndDeposits = db.loansAndDeposits || [];
    db.fixedDeposits = db.fixedDeposits || [];
  }
  applyMobileProfileCustomizations();
  renderDashboard();
  renderLedger();
  if (db && db.profileType !== 'personal') {
    populateTenantMonthPicker();
    renderTenants();
    renderGovernance();
  }
  // Update hero label
  const heroLabel = document.querySelector('.hero-label');
  if (heroLabel) {
    if (currentMode === 'church') {
      heroLabel.textContent = 'REDEMPTION HOUSE OF PRAYER';
    } else {
      const name = getPersonalName();
      heroLabel.textContent = name ? `${name.toUpperCase()}'S LEDGER` : 'MY PERSONAL LEDGER';
    }
  }
}

function renderCurrentTab() {
  if (db) {
    db.loansAndDeposits = db.loansAndDeposits || [];
    db.fixedDeposits = db.fixedDeposits || [];
  }
  applyMobileProfileCustomizations();
  switch (currentTab) {
    case 'dashboard':  renderDashboard(); break;
    case 'ledger':     renderLedger(); break;
    case 'tenants':
      if (db && db.profileType !== 'personal') {
        populateTenantMonthPicker();
        renderTenants();
      }
      break;
    case 'governance': if (db && db.profileType !== 'personal') renderGovernance(); break;
  }
}

function applyMobileProfileCustomizations() {
  if (!db) return;
  const isPersonal = db.profileType === 'personal';

  // Tabs
  const tabTenants = document.getElementById('tab-tenants');
  const tabGov     = document.getElementById('tab-governance');
  if (tabTenants) tabTenants.style.display = isPersonal ? 'none' : 'flex';
  if (tabGov)     tabGov.style.display     = isPersonal ? 'none' : 'flex';

  // KPI cards
  const kpiEstate = document.getElementById('m-estate')?.closest('.kpi-card');
  if (kpiEstate) kpiEstate.style.display = isPersonal ? 'none' : 'block';

  // KPI labels
  const collCard = document.getElementById('m-collections')?.closest('.kpi-card');
  if (collCard) {
    const label = collCard.querySelector('.kpi-label');
    const sub   = collCard.querySelector('.kpi-sub');
    if (label) label.textContent = isPersonal ? 'TOTAL INFLOWS' : 'SUNDAY COLLECTIONS';
    if (sub)   sub.textContent   = isPersonal ? 'Income & Earnings' : 'Tithes & Offerings';
  }
  const expCard = document.getElementById('m-expenses')?.closest('.kpi-card');
  if (expCard) {
    const label = expCard.querySelector('.kpi-label');
    const sub   = expCard.querySelector('.kpi-sub');
    if (label) label.textContent = isPersonal ? 'TOTAL OUTFLOWS' : 'TOTAL EXPENSES';
    if (sub)   sub.textContent   = isPersonal ? 'Expenses & Outlays' : 'Operating Outgoings';
  }
}

// ─── DASHBOARD ───────────────────────────────────────────────────
function renderDashboard() {
  if (!db) return;
  const stats = calcStats();
  
  const liquidEl = document.getElementById('m-liquid');
  if (liquidEl) {
    liquidEl.textContent = fmtRs(stats.liquidAssets);
    liquidEl.style.color = stats.liquidAssets < 0 ? '#ff453a' : '';
  }
  
  setEl('m-fixed',       fmtRs(stats.fixedReserves));
  setEl('m-collections', fmtRs(stats.totalCollections));
  setEl('m-estate',      fmtRs(stats.totalRentalRevenue));
  setEl('m-expenses',    fmtRs(stats.totalExpenses));

  const list = document.getElementById('month-list');
  if (!list) return;
  const weeks = db.weeks || {}, monthMap = {};
  Object.keys(weeks).sort().forEach(dKey => {
    const mKey = dKey.substring(0, 7);
    if (!monthMap[mKey]) monthMap[mKey] = { inflow: 0, outflow: 0 };
    const w = weeks[dKey];
    monthMap[mKey].inflow += parseFloat(w.offering) || 0;
    if (w.outgoings) w.outgoings.forEach(o => monthMap[mKey].outflow += parseFloat(o.amount) || 0);
  });
  const months = db.months || {}, tenantRates = (db.settings || {}).tenantRates || {};
  Object.keys(months).forEach(mKey => {
    if (!monthMap[mKey]) monthMap[mKey] = { inflow: 0, outflow: 0 };
    const mData = months[mKey];
    if (mData.tenants) Object.keys(mData.tenants).forEach(tid => {
      const t = mData.tenants[tid];
      if (t.paid) { const amt = parseFloat(t.amount) > 0 ? parseFloat(t.amount) : (parseFloat(tenantRates[tid]) || 0); monthMap[mKey].inflow += amt; }
    });
  });
  list.innerHTML = Object.keys(monthMap).sort().map(mKey => {
    const { inflow, outflow } = monthMap[mKey];
    const delta = inflow - outflow, isPos = delta >= 0;
    return `<div class="month-row"><div><div class="month-name">${fmtMonthName(mKey)}</div><div class="month-meta">In: ${fmtRs(inflow)} · Out: ${fmtRs(outflow)}</div></div><div><div class="month-amount">${fmtRs(Math.abs(delta))}</div><div class="month-delta ${isPos ? 'pos' : 'neg'}">${isPos ? '▲' : '▼'} ${isPos ? 'Surplus' : 'Deficit'}</div></div></div>`;
  }).join('');
}

// ─── LEDGER ───────────────────────────────────────────────────────
function renderLedger() {
  if (!db) return;
  const weeks = db.weeks || {}, container = document.getElementById('ledger-list');
  if (!container) return;
  const sorted = Object.keys(weeks).sort();
  const isPersonal = db.profileType === 'personal';
  if (sorted.length === 0) { container.innerHTML = `<div class="empty-state"><p>${isPersonal ? 'No cash ledger entries yet.' : 'No weekly data yet.'}</p></div>`; return; }
  const groups = {};
  sorted.forEach(dKey => { const mKey = dKey.substring(0, 7); if (!groups[mKey]) groups[mKey] = []; groups[mKey].push(dKey); });
  // Months in ascending order (Jan → Dec)
  container.innerHTML = Object.keys(groups).sort().map(mKey => {
    groups[mKey].sort();
    const rows = groups[mKey].map(dKey => {
      const w = weeks[dKey];
      const offering = parseFloat(w.offering) || 0;
      let expenses = 0;
      if (w.outgoings) w.outgoings.forEach(o => expenses += parseFloat(o.amount) || 0);
      const delta = offering - expenses, isPos = delta >= 0;
      const dateObj = new Date(dKey + 'T00:00:00');
      const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const dayName  = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
      const rowTitle = isPersonal ? `${dayName}, ${dateLabel}` : `Sunday, ${dateLabel}`;
      const collectionsLabel = isPersonal ? 'Income' : 'Collections';

      let detailRows = `<div class="ledger-detail-row"><span class="ledger-detail-label">${collectionsLabel}</span><span class="ledger-detail-value green" onclick="editOffering('${dKey}')" style="cursor:pointer;" title="Tap to edit">${fmtRs(offering)} ✏️</span></div>`;
      if (w.outgoings && w.outgoings.length > 0) {
        w.outgoings.forEach(o => {
          detailRows += `<div class="ledger-detail-row"><span class="ledger-detail-label">${escHtml(o.description || 'Expense')}</span><span class="ledger-detail-value red" style="display:flex;align-items:center;gap:6px;">${fmtRs(o.amount)}<button onclick="deleteExpense('${dKey}','${o.id}')" style="background:rgba(255,69,58,0.2);border:none;color:#ff453a;font-size:10px;border-radius:4px;padding:2px 5px;cursor:pointer;">✕</button></span></div>`;
        });
      }
      detailRows += `<div class="ledger-detail-row" style="border-top:1px solid rgba(255,255,255,0.06);margin-top:6px;padding-top:6px;"><button onclick="showAddExpense('${dKey}')" style="background:rgba(108,108,255,0.15);border:1px solid rgba(108,108,255,0.3);color:#9c9cff;font-size:11px;font-weight:600;padding:5px 10px;border-radius:7px;cursor:pointer;width:100%;">+ Add Expense</button></div>`;
      return `<div class="ledger-row" id="lr-${dKey}"><div class="ledger-row-header" onclick="toggleLedgerRow('${dKey}')"><div><div class="ledger-date">${rowTitle}</div><div class="ledger-date-sub">${dKey}</div></div><div style="display:flex;align-items:center"><span class="ledger-delta ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : '-'}${fmtRs(Math.abs(delta))}</span><svg class="ledger-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></div></div><div class="ledger-row-detail">${detailRows}</div></div>`;
    }).join('');
    return `<div class="ledger-month-group"><div class="ledger-month-header">${fmtMonthName(mKey)}</div>${rows}</div>`;
  }).join('');
}

function toggleLedgerRow(dKey) { const row = document.getElementById('lr-' + dKey); if (row) row.classList.toggle('expanded'); }

function editOffering(dKey) {
  const w = db.weeks[dKey];
  const isPersonal = db && db.profileType === 'personal';
  openModal(`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:4px;">${isPersonal ? 'EDIT INCOME' : 'EDIT COLLECTION'}</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">${isPersonal ? '' : 'Sunday '}${dKey}</div>
    </div>
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">${isPersonal ? 'INCOME AMOUNT (Rs)' : 'OFFERING AMOUNT (Rs)'}</label>
    <input id="m-offering-input" type="number" step="0.01" value="${parseFloat(w.offering) || 0}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:20px;font-weight:700;padding:12px 14px;outline:none;margin-bottom:16px;">
    <button onclick="saveOfferingEdit('${dKey}')" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">Save</button>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:13px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
  setTimeout(() => { const inp = document.getElementById('m-offering-input'); if (inp) { inp.focus(); inp.select(); } }, 100);
}

async function saveOfferingEdit(dKey) {
  const inp = document.getElementById('m-offering-input');
  const val = parseFloat(inp ? inp.value : 0) || 0;
  if (!db.weeks[dKey]) return;
  db.weeks[dKey].offering = val;
  closeModal();
  renderLedger();
  await saveData();
}

function showAddExpense(dKey) {
  const isPersonal = db && db.profileType === 'personal';
  openModal(`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:4px;">ADD EXPENSE</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">${isPersonal ? dKey : 'Sunday ' + dKey}</div>
    </div>
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">DESCRIPTION</label>
    <input id="m-exp-desc" type="text" placeholder="e.g. Electricity bill" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:15px;padding:12px 14px;outline:none;margin-bottom:12px;">
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">AMOUNT (Rs)</label>
    <input id="m-exp-amt" type="number" step="0.01" placeholder="0.00" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:20px;font-weight:700;padding:12px 14px;outline:none;margin-bottom:16px;">
    <button onclick="saveAddExpense('${dKey}')" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">Add Expense</button>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:13px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
  setTimeout(() => { const inp = document.getElementById('m-exp-desc'); if (inp) inp.focus(); }, 100);
}

async function saveAddExpense(dKey) {
  const desc = document.getElementById('m-exp-desc').value.trim() || 'Expense';
  const amt  = parseFloat(document.getElementById('m-exp-amt').value) || 0;
  if (!db.weeks[dKey]) return;
  if (!db.weeks[dKey].outgoings) db.weeks[dKey].outgoings = [];
  db.weeks[dKey].outgoings.push({ id: 'out_' + Date.now(), description: desc, amount: amt, receipt: '' });
  closeModal();
  renderLedger();
  await saveData();
}

async function deleteExpense(dKey, expId) {
  if (!db.weeks[dKey] || !db.weeks[dKey].outgoings) return;
  db.weeks[dKey].outgoings = db.weeks[dKey].outgoings.filter(o => o.id !== expId);
  renderLedger();
  await saveData();
}

function showAddSunday() {
  const isPersonal = db && db.profileType === 'personal';
  const today = new Date().toISOString().substring(0, 10);
  const titleMeta  = isPersonal ? 'NEW DAILY ENTRY' : 'NEW SUNDAY ENTRY';
  const titleSub   = isPersonal ? 'Record Income / Inflow' : 'Record Collections';
  const amtLabel   = isPersonal ? 'INCOME AMOUNT (Rs)' : 'OFFERING AMOUNT (Rs)';
  const lblPh      = isPersonal ? 'e.g. Salary or Freelance' : 'e.g. First Sunday of June';
  const btnText    = isPersonal ? 'Add Daily Entry' : 'Add Sunday Entry';
  openModal(`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:4px;">${titleMeta}</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">${titleSub}</div>
    </div>
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">DATE</label>
    <input id="m-sun-date" type="date" value="${today}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:15px;padding:12px 14px;outline:none;margin-bottom:12px;">
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">${amtLabel}</label>
    <input id="m-sun-offering" type="number" step="0.01" placeholder="0.00" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:20px;font-weight:700;padding:12px 14px;outline:none;margin-bottom:16px;">
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">LABEL (optional)</label>
    <input id="m-sun-label" type="text" placeholder="${lblPh}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:14px;padding:12px 14px;outline:none;margin-bottom:16px;">
    <button onclick="saveAddSunday()" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">${btnText}</button>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:13px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
}

async function saveAddSunday() {
  const isPersonal = db && db.profileType === 'personal';
  const date = document.getElementById('m-sun-date').value.trim();
  const offering = parseFloat(document.getElementById('m-sun-offering').value) || 0;
  const label = document.getElementById('m-sun-label').value.trim();
  if (!date) { showToast('Please enter a date'); return; }
  if (!db.weeks) db.weeks = {};
  let formattedLabel = label;
  if (!formattedLabel) {
    const dObj = new Date(date + 'T00:00:00');
    const dayName  = dObj.toLocaleDateString('en-US', { weekday: 'short' });
    const monthDay = dObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    formattedLabel = `${dayName} - ${monthDay}, 2026`;
  }
  db.weeks[date] = { offering, label: formattedLabel, outgoings: [], customCells: {}, collectionsBreakdown: { hasBreakdown: false } };
  closeModal();
  renderLedger();
  await saveData();
  showToast(isPersonal ? 'Daily entry added ✓' : 'Sunday entry added ✓');
}

// ─── TENANTS ─────────────────────────────────────────────────────
function populateTenantMonthPicker() {
  if (!db) return;
  const picker = document.getElementById('tenant-month-picker');
  if (!picker) return;
  const months = db.months || {};
  picker.innerHTML = Object.keys(months).sort().reverse().map(mKey => `<option value="${mKey}">${fmtMonthName(mKey)}</option>`).join('');
  const nowKey = new Date().toISOString().substring(0, 7);
  if (months[nowKey]) picker.value = nowKey;
  picker.onchange = renderTenants;
}

function renderTenants() {
  if (!db) return;
  const picker = document.getElementById('tenant-month-picker');
  let mKey = picker ? picker.value : '';
  if (!mKey || !db.months[mKey]) {
    mKey = Object.keys(db.months || {}).sort().reverse()[0] || '';
  }
  const container = document.getElementById('tenant-cards');
  if (!container) return;
  const settings = db.settings || {}, tenantNames = settings.tenantNames || {}, tenantRates = settings.tenantRates || {};
  const mData = (db.months || {})[mKey] || { tenants: {} }, tenants = mData.tenants || {};
  if (Object.keys(tenantNames).length === 0) { container.innerHTML = '<div class="empty-state"><p>No tenants configured yet.</p></div>'; return; }
  container.innerHTML = Object.keys(tenantNames).map(tid => {
    const name = tenantNames[tid] || tid, baseRate = parseFloat(tenantRates[tid]) || 0;
    const tData = tenants[tid] || { paid: false, amount: 0 };
    const isPaid = tData.paid, paidAmt = parseFloat(tData.amount) > 0 ? parseFloat(tData.amount) : baseRate;
    return `<div class="tenant-card ${isPaid ? 'paid' : 'unpaid'}">
      <div>
        <div class="tenant-name">${escHtml(name)}</div>
        <div class="tenant-rate">Base: ${fmtRs(baseRate)} / month</div>
        ${isPaid ? `<div class="tenant-rate" style="color:var(--green);margin-top:4px;cursor:pointer;" onclick="editTenantAmount('${mKey}','${tid}')">Paid: ${fmtRs(paidAmt)} ✏️</div>` : ''}
      </div>
      <div class="tenant-status">
        <span class="paid-badge ${isPaid ? 'paid' : 'unpaid'}">${isPaid ? 'PAID' : 'UNPAID'}</span>
        <button class="toggle-btn" onclick="toggleTenantPaid('${mKey}','${tid}','${isPaid}')">${isPaid ? 'Mark Unpaid' : 'Mark Paid'}</button>
      </div>
    </div>`;
  }).join('');
}

async function toggleTenantPaid(mKey, tid, currentPaidStr) {
  if (!db) return;
  const isPaid = currentPaidStr === 'true';
  if (!db.months[mKey]) db.months[mKey] = { tenants: {} };
  if (!db.months[mKey].tenants) db.months[mKey].tenants = {};
  if (!db.months[mKey].tenants[tid]) db.months[mKey].tenants[tid] = { paid: false, amount: 0, paymentDate: '', updatedAt: 0 };
  const baseRate = parseFloat((db.settings.tenantRates || {})[tid]) || 0;
  db.months[mKey].tenants[tid].paid = !isPaid;
  db.months[mKey].tenants[tid].updatedAt = Date.now();
  if (!isPaid) { db.months[mKey].tenants[tid].amount = baseRate; db.months[mKey].tenants[tid].paymentDate = new Date().toISOString().substring(0, 10); }
  else { db.months[mKey].tenants[tid].amount = 0; db.months[mKey].tenants[tid].paymentDate = ''; }
  renderTenants();
  await saveData();
}

function editTenantAmount(mKey, tid) {
  const tData = (db.months[mKey] || {tenants:{}}).tenants[tid] || {};
  openModal(`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:4px;">EDIT PAYMENT</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">${escHtml((db.settings.tenantNames || {})[tid] || tid)}</div>
    </div>
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">AMOUNT PAID (Rs)</label>
    <input id="m-tenant-amt" type="number" step="0.01" value="${parseFloat(tData.amount) || 0}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:20px;font-weight:700;padding:12px 14px;outline:none;margin-bottom:16px;">
    <button onclick="saveTenantAmount('${mKey}','${tid}')" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">Save Amount</button>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:13px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
  setTimeout(() => { const inp = document.getElementById('m-tenant-amt'); if (inp) { inp.focus(); inp.select(); } }, 100);
}

async function saveTenantAmount(mKey, tid) {
  const amt = parseFloat(document.getElementById('m-tenant-amt').value) || 0;
  if (!db.months[mKey]) db.months[mKey] = { tenants: {} };
  if (!db.months[mKey].tenants[tid]) db.months[mKey].tenants[tid] = { paid: true, amount: 0, paymentDate: '', updatedAt: 0 };
  db.months[mKey].tenants[tid].amount = amt;
  db.months[mKey].tenants[tid].updatedAt = Date.now();
  closeModal();
  renderTenants();
  await saveData();
}

// ─── GOVERNANCE ──────────────────────────────────────────────────
function renderGovernance() {
  if (!db) return;
  const landlord = db.landlordLease || {}, fds = db.fixedDeposits || [];
  const baseRent = parseFloat(landlord.baseRent) || 0, leaseMonths = landlord.months || {};
  const paidCount = Object.values(leaseMonths).filter(v => parseFloat(v) > 0).length;
  setEl('lease-badge', `${paidCount}/12 paid`);

  const leaseList = document.getElementById('lease-list');
  if (leaseList) {
    leaseList.innerHTML = Object.keys(leaseMonths).sort().map(mKey => {
      const paidAmt = parseFloat(leaseMonths[mKey]) || 0;
      const isPaid = paidAmt >= baseRent && baseRent > 0, isPartial = paidAmt > 0 && paidAmt < baseRent;
      const chip = isPaid ? 'paid' : isPartial ? 'partial' : 'unpaid', chipLabel = isPaid ? 'PAID' : isPartial ? 'PARTIAL' : 'UNPAID';
      return `<div class="lease-row ${isPaid ? 'paid' : ''}">
        <div><div class="lease-month">${fmtMonthName(mKey)}</div><div class="lease-amount">Due: ${fmtRs(baseRent)} · Paid: ${fmtRs(paidAmt)}</div></div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;">
          <span class="lease-chip ${chip}">${chipLabel}</span>
          <button onclick="editLeasePayment('${mKey}')" style="background:rgba(108,108,255,0.15);border:1px solid rgba(108,108,255,0.3);color:#9c9cff;font-size:10px;font-weight:600;padding:3px 8px;border-radius:6px;cursor:pointer;">Edit</button>
        </div>
      </div>`;
    }).join('');
  }

  const fdList = document.getElementById('fd-list');
  if (fdList) {
    const addFdBtn = `<button onclick="showAddFD()" style="width:100%;background:rgba(108,108,255,0.15);border:1px solid rgba(108,108,255,0.3);color:#9c9cff;font-size:13px;font-weight:700;padding:10px;border-radius:10px;cursor:pointer;margin-bottom:10px;">+ Add Fixed Deposit</button>`;
    if (fds.length === 0) { fdList.innerHTML = addFdBtn + '<div class="fd-empty">No fixed deposits logged</div>'; }
    else {
      fdList.innerHTML = addFdBtn + fds.map((fd, idx) => {
        const maturity = fd.maturity ? new Date(fd.maturity).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }) : '—';
        return `<div class="fd-card"><div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div><div class="fd-bank">${escHtml(fd.bank || fd.institution || 'Unknown Bank')}</div><div class="fd-acct">#${escHtml(fd.accountNumber || fd.account || '—')}</div></div>
          <button onclick="deleteFD(${idx})" style="background:rgba(255,69,58,0.2);border:none;color:#ff453a;font-size:11px;border-radius:6px;padding:4px 8px;cursor:pointer;">Delete</button>
        </div>
        <div class="fd-row"><span class="fd-key">Principal</span><span class="fd-val gold">${fmtRs(fd.principal)}</span></div>
        <div class="fd-row"><span class="fd-key">Maturity</span><span class="fd-val">${maturity}</span></div>
        <div class="fd-row"><span class="fd-key">Rate</span><span class="fd-val">${fd.rate || fd.interestRate || '—'}%</span></div>
        ${fd.notes ? `<div class="fd-row"><span class="fd-key">Notes</span><span class="fd-val" style="font-size:12px;color:var(--text2)">${escHtml(fd.notes)}</span></div>` : ''}
        </div>`;
      }).join('');
    }
  }

  const loanList = document.getElementById('mobile-loan-list');
  if (loanList) {
    db.loansAndDeposits = db.loansAndDeposits || [];
    const addLoanBtn = `<button onclick="showAddLoan()" style="width:100%;background:rgba(108,108,255,0.15);border:1px solid rgba(108,108,255,0.3);color:#9c9cff;font-size:13px;font-weight:700;padding:10px;border-radius:10px;cursor:pointer;margin-bottom:10px;">+ Add Loan / Deposit</button>`;
    if (db.loansAndDeposits.length === 0) {
      loanList.innerHTML = addLoanBtn + '<div class="loan-empty">No loans or deposits logged</div>';
    } else {
      loanList.innerHTML = addLoanBtn + db.loansAndDeposits.map((loan, idx) => {
        // Normalization & dynamic calculation
        if (!loan.payments) loan.payments = [];
        const calculatedPaid = loan.payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
        loan.paidAmount = calculatedPaid;

        const balance = Math.max(0, loan.targetAmount - loan.paidAmount);
        let typeText = "Refundable Deposit";
        let typeClass = "deposit";
        if (loan.type === "loan_taken") { typeText = "Loan Taken (We Owe)"; typeClass = "loan_taken"; }
        else if (loan.type === "loan_given") { typeText = "Loan Given (We Lent)"; typeClass = "loan_given"; }
        
        return `<div class="loan-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <div>
              <div class="loan-title">${escHtml(loan.title)}</div>
              <span class="loan-badge ${typeClass}">${typeText}</span>
            </div>
            <div style="display:flex;gap:5px;">
              <button onclick="editLoanPaidAmount(${idx})" style="background:rgba(108,108,255,0.15);border:none;color:#9c9cff;font-size:11px;border-radius:6px;padding:4px 8px;cursor:pointer;">Pay</button>
              <button onclick="deleteLoan(${idx})" style="background:rgba(255,69,58,0.2);border:none;color:#ff453a;font-size:11px;border-radius:6px;padding:4px 8px;cursor:pointer;">Delete</button>
            </div>
          </div>
          <div class="loan-row"><span class="loan-key">Total Target</span><span class="loan-val">${fmtRs(loan.targetAmount)}</span></div>
          <div class="loan-row"><span class="loan-key">Paid So Far</span><span class="loan-val green">${fmtRs(loan.paidAmount)}</span></div>
          <div class="loan-row"><span class="loan-key">Remaining Balance</span><span class="loan-val ${balance > 0 ? 'red' : ''}">${fmtRs(balance)}</span></div>
          ${loan.notes ? `<div class="loan-row"><span class="loan-key">Notes</span><span class="loan-val" style="font-size:12px;color:var(--text2)">${escHtml(loan.notes)}</span></div>` : ''}
        </div>`;
      }).join('');
    }
  }
}

function showAddLoan() {
  openModal(`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:4px;">NEW AGREEMENT</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">Log Loan or Deposit</div>
    </div>
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">TITLE / DESCRIPTION</label>
    <input id="m-loan-title" type="text" placeholder="e.g. Building Lease Deposit" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:14px;padding:12px 14px;outline:none;margin-bottom:12px;">
    
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">TYPE</label>
    <select id="m-loan-type" style="width:100%;box-sizing:border-box;background:#1c1c28;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:14px;padding:12px 14px;outline:none;margin-bottom:12px;">
      <option value="deposit">Refundable Lease Deposit</option>
      <option value="loan_taken">Loan Taken (We Owe)</option>
      <option value="loan_given">Loan Given (We Lent)</option>
    </select>
    
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">TOTAL TARGET AMOUNT (Rs)</label>
    <input id="m-loan-target" type="number" step="0.01" placeholder="3000000.00" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:16px;padding:12px 14px;outline:none;margin-bottom:12px;">
    
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">AMOUNT PAID SO FAR (Rs)</label>
    <input id="m-loan-paid" type="number" step="0.01" placeholder="2880000.00" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:16px;padding:12px 14px;outline:none;margin-bottom:12px;">
    
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">NOTES</label>
    <input id="m-loan-notes" type="text" placeholder="e.g. Returnable when leaving" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:14px;padding:12px 14px;outline:none;margin-bottom:16px;">
    
    <button onclick="saveMobileLoan()" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">Save Agreement</button>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:13px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
}

async function saveMobileLoan() {
  const title = document.getElementById('m-loan-title').value.trim();
  const type = document.getElementById('m-loan-type').value;
  const target = parseFloat(document.getElementById('m-loan-target').value) || 0;
  const paid = parseFloat(document.getElementById('m-loan-paid').value) || 0;
  const notes = document.getElementById('m-loan-notes').value.trim();
  
  if (!title || target <= 0) { showToast('Please fill title and target amount'); return; }
  
  db.loansAndDeposits = db.loansAndDeposits || [];
  
  const payments = [];
  if (paid > 0) {
    payments.push({
      id: 'pay_default_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
      amount: paid,
      date: '2025-12-01'
    });
  }
  
  db.loansAndDeposits.push({
    id: 'loan_' + Date.now(),
    title,
    type,
    targetAmount: target,
    paidAmount: paid,
    payments,
    notes,
    updatedAt: Date.now()
  });
  
  closeModal();
  renderGovernance();
  await saveData();
  showToast('Agreement saved ✓');
}

function editLoanPaidAmount(idx) {
  const loan = db.loansAndDeposits[idx];
  if (!loan) return;
  openModal('');
  renderMobileLoanPayments(idx);
}

function renderMobileLoanPayments(idx) {
  const loan = db.loansAndDeposits[idx];
  if (!loan) return;
  
  if (!loan.payments) loan.payments = [];
  const calculatedPaid = loan.payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  loan.paidAmount = calculatedPaid;
  const balance = Math.max(0, loan.targetAmount - calculatedPaid);
  
  const contentEl = document.getElementById('modal-content');
  if (!contentEl) return;
  
  contentEl.innerHTML = `
    <div style="text-align:center;margin-bottom:14px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#9c9cff;margin-bottom:4px;">AGREEMENT PAYMENTS</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">${escHtml(loan.title)}</div>
    </div>
    
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;background:rgba(255,255,255,0.05);border-radius:10px;padding:10px;margin-bottom:12px;text-align:center;">
      <div>
        <div style="font-size:9px;color:#8e8e93;font-weight:700;text-transform:uppercase;">Target</div>
        <div style="font-size:12px;font-weight:700;color:#f0f0f5;margin-top:2px;">${fmtRs(loan.targetAmount)}</div>
      </div>
      <div>
        <div style="font-size:9px;color:#8e8e93;font-weight:700;text-transform:uppercase;">Paid</div>
        <div style="font-size:12px;font-weight:700;color:#34c759;margin-top:2px;">${fmtRs(calculatedPaid)}</div>
      </div>
      <div>
        <div style="font-size:9px;color:#8e8e93;font-weight:700;text-transform:uppercase;">Remaining</div>
        <div style="font-size:12px;font-weight:700;color:${balance > 0 ? '#ff3b30' : '#34c759'};margin-top:2px;">${fmtRs(balance)}</div>
      </div>
    </div>

    <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#9c9cff;margin-bottom:6px;">PAYMENT HISTORY</div>
    <div style="max-height:120px;overflow-y:auto;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);border-radius:10px;margin-bottom:12px;padding:4px 8px;">
      ${loan.payments.length === 0 ? `
        <div style="text-align:center;color:#56566a;font-size:12px;padding:12px 0;">No payments recorded</div>
      ` : loan.payments.sort((a,b) => new Date(a.date) - new Date(b.date)).map((p) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed rgba(255,255,255,0.05);">
          <div style="font-size:13px;font-weight:600;color:#f0f0f5;">${p.date}</div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:13px;font-weight:700;color:#f0f0f5;">${fmtRs(p.amount)}</span>
            <button onclick="deleteMobileLoanPayment(${idx}, '${p.id}')" style="background:transparent;border:none;color:#ff453a;font-size:16px;font-weight:bold;cursor:pointer;padding:0 4px;">&times;</button>
          </div>
        </div>
      `).join('')}
    </div>

    <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#9c9cff;margin-bottom:6px;">ADD NEW PAYMENT</div>
    <div style="display:flex;gap:6px;margin-bottom:16px;align-items:flex-end;">
      <div style="flex:1.2;">
        <label style="font-size:8px;color:#8e8e93;display:block;margin-bottom:3px;font-weight:700;">DATE</label>
        <input id="m-new-pay-date" type="date" value="${new Date().toISOString().substring(0, 10)}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#f0f0f5;font-size:11px;padding:8px;outline:none;height:31px;">
      </div>
      <div style="flex:1;">
        <label style="font-size:8px;color:#8e8e93;display:block;margin-bottom:3px;font-weight:700;">AMOUNT (Rs)</label>
        <input id="m-new-pay-amt" type="number" step="0.01" placeholder="e.g. 20000" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#f0f0f5;font-size:11px;padding:8px;outline:none;height:31px;">
      </div>
      <button onclick="addMobileLoanPayment(${idx})" style="background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:11px;padding:8px 12px;border:none;border-radius:8px;cursor:pointer;height:31px;white-space:nowrap;">+ Add</button>
    </div>

    <button onclick="closeModal()" style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;font-weight:700;font-size:14px;padding:12px;border-radius:12px;cursor:pointer;margin-bottom:8px;">Done</button>
  `;
}

async function addMobileLoanPayment(idx) {
  const loan = db.loansAndDeposits[idx];
  if (!loan) return;
  
  const dateInput = document.getElementById('m-new-pay-date');
  const amtInput = document.getElementById('m-new-pay-amt');
  if (!dateInput || !amtInput) return;
  
  const dateVal = dateInput.value;
  const amtVal = parseFloat(amtInput.value) || 0;
  
  if (!dateVal) { showToast('Please select a payment date'); return; }
  if (amtVal <= 0) { showToast('Please enter a valid amount'); return; }
  
  if (!loan.payments) loan.payments = [];
  loan.payments.push({
    id: 'pay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    amount: amtVal,
    date: dateVal
  });
  
  loan.paidAmount = loan.payments.reduce((sum, p) => sum + p.amount, 0);
  loan.updatedAt = Date.now();
  
  renderMobileLoanPayments(idx);
  renderGovernance();
  await saveData();
  showToast('Payment added ✓');
}

async function deleteMobileLoanPayment(idx, payId) {
  const loan = db.loansAndDeposits[idx];
  if (!loan) return;
  if (!confirm('Remove this payment entry?')) return;
  
  loan.payments = (loan.payments || []).filter(p => p.id !== payId);
  loan.paidAmount = loan.payments.reduce((sum, p) => sum + p.amount, 0);
  loan.updatedAt = Date.now();
  
  renderMobileLoanPayments(idx);
  renderGovernance();
  await saveData();
  showToast('Payment removed');
}

async function deleteLoan(idx) {
  const loan = db.loansAndDeposits[idx];
  if (!loan) return;
  if (!confirm(`Delete agreement: "${loan.title}"?`)) return;
  
  db.loansAndDeposits.splice(idx, 1);
  renderGovernance();
  await saveData();
  showToast('Agreement removed ✓');
}

function editLeasePayment(mKey) {
  const current = parseFloat((db.landlordLease.months || {})[mKey]) || 0;
  const baseRent = parseFloat(db.landlordLease.baseRent) || 0;
  openModal(`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:4px;">LEASE PAYMENT</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">${fmtMonthName(mKey)}</div>
      <div style="font-size:13px;color:#56566a;margin-top:4px;">Base Rent: ${fmtRs(baseRent)}</div>
    </div>
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">AMOUNT PAID (Rs)</label>
    <input id="m-lease-amt" type="number" step="0.01" value="${current}" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:20px;font-weight:700;padding:12px 14px;outline:none;margin-bottom:6px;">
    <button onclick="setLeasePayment('${mKey}',${baseRent})" style="background:rgba(108,108,255,0.2);border:1px solid rgba(108,108,255,0.3);color:#9c9cff;font-size:12px;font-weight:700;padding:7px 14px;border-radius:8px;cursor:pointer;margin-bottom:12px;">Set to Full (${fmtRs(baseRent)})</button>
    <button onclick="saveLeasePayment('${mKey}')" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">Save</button>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:13px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
  setTimeout(() => { const inp = document.getElementById('m-lease-amt'); if (inp) { inp.focus(); inp.select(); } }, 100);
}

function setLeasePayment(mKey, baseRent) { const inp = document.getElementById('m-lease-amt'); if (inp) inp.value = baseRent; }

async function saveLeasePayment(mKey) {
  const amt = parseFloat(document.getElementById('m-lease-amt').value) || 0;
  if (!db.landlordLease) db.landlordLease = { baseRent: 0, months: {} };
  if (!db.landlordLease.months) db.landlordLease.months = {};
  db.landlordLease.months[mKey] = amt;
  closeModal();
  renderGovernance();
  await saveData();
}

function showAddFD() {
  const today = new Date().toISOString().substring(0, 10);
  openModal(`
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#7c7cff;margin-bottom:4px;">NEW FIXED DEPOSIT</div>
      <div style="font-size:18px;font-weight:800;color:#f0f0f5;">Add FD Record</div>
    </div>
    ${['Bank Name|m-fd-bank|text|e.g. Commercial Bank', 'Account #|m-fd-acct|text|e.g. 849201234', 'Principal (Rs)|m-fd-principal|number|0.00', 'Interest Rate (%)|m-fd-rate|number|0.00', 'Maturity Date|m-fd-maturity|date|'].map(f => {
      const [lbl, id, type, ph] = f.split('|');
      return `<label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">${lbl.toUpperCase()}</label><input id="${id}" type="${type}" placeholder="${ph}" ${type==='date'?`value="${today}"`:'step="0.01"'} style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:15px;padding:10px 12px;outline:none;margin-bottom:10px;">`;
    }).join('')}
    <label style="font-size:11px;font-weight:700;letter-spacing:1px;color:#7c7cff;display:block;margin-bottom:6px;">NOTES (OPTIONAL)</label>
    <input id="m-fd-notes" type="text" placeholder="Any notes..." style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#f0f0f5;font-size:14px;padding:10px 12px;outline:none;margin-bottom:14px;">
    <button onclick="saveAddFD()" style="width:100%;background:linear-gradient(135deg,#6c6cff,#9c6cff);color:#fff;font-weight:700;font-size:15px;padding:13px;border:none;border-radius:12px;cursor:pointer;margin-bottom:8px;">Add Fixed Deposit</button>
    <button onclick="closeModal()" style="width:100%;background:transparent;color:#56566a;font-size:13px;padding:8px;border:none;cursor:pointer;">Cancel</button>
  `);
}

async function saveAddFD() {
  const bank      = document.getElementById('m-fd-bank').value.trim();
  const acct      = document.getElementById('m-fd-acct').value.trim();
  const principal = parseFloat(document.getElementById('m-fd-principal').value) || 0;
  const rate      = parseFloat(document.getElementById('m-fd-rate').value) || 0;
  const maturity  = document.getElementById('m-fd-maturity').value;
  const notes     = document.getElementById('m-fd-notes').value.trim();
  if (!db.fixedDeposits) db.fixedDeposits = [];
  db.fixedDeposits.push({ id: 'fd_' + Date.now(), bank, accountNumber: acct, principal, rate, maturity, notes });
  closeModal();
  renderGovernance();
  await saveData();
  showToast('Fixed deposit added ✓');
}

async function deleteFD(idx) {
  if (!db.fixedDeposits || !db.fixedDeposits[idx]) return;
  if (!confirm('Delete this fixed deposit record?')) return;
  db.fixedDeposits.splice(idx, 1);
  renderGovernance();
  await saveData();
}

// ─── TAB NAVIGATION ──────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + tab);
  if (target) target.classList.add('active');
  document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
  const tabEl = document.getElementById('tab-' + tab);
  if (tabEl) tabEl.classList.add('active');

  // Update page title
  const isPersonal = currentMode === 'personal';
  const name = getPersonalName() || 'My Profile';
  const titles = {
    dashboard:  isPersonal ? `👤 ${name}` : '⛪ Church',
    ledger:     isPersonal ? 'My Ledger'  : 'Church Ledger',
    tenants:    'Tenants',
    governance: 'Financial Vault'
  };
  setEl('page-title', titles[tab] || 'Ledger');

  renderCurrentTab();
  const main = document.getElementById('main-content');
  if (main) main.scrollTop = 0;

  // FAB only on Ledger
  const fab = document.getElementById('fab-add-sunday');
  if (fab) fab.style.display = tab === 'ledger' ? 'flex' : 'none';
}

// ─── HELPERS ─────────────────────────────────────────────────────
function setEl(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function escHtml(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// ─── ACCESS LOGGING ──────────────────────────────────────────────
async function logChurchAccessAttempt(success) {
  const url = getChurchUrl();
  if (!url) return;
  const devId = getDeviceId();
  const entry = {
    name: getPersonalName() || 'Unknown',
    deviceId: devId,
    success,
    timestamp: Date.now(),
    attemptTime: new Date().toISOString(),
    platform: navigator.platform || 'Unknown',
    userAgent: (navigator.userAgent || '').substring(0, 120),
    screen: `${screen.width}x${screen.height}`,
    language: navigator.language || 'Unknown',
    appVersion: '3.0'
  };
  try {
    await fetch(`${url}/access_log/${devId}_${Date.now()}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5000)
    });
  } catch(e) {
    console.warn('Could not log access attempt:', e);
  }
}

// ─── ADMIN MONITORING ────────────────────────────────────────────
function startAdminMonitoring() {
  if (!isAdminDevice()) return;
  const url = getChurchUrl();
  if (!url) return;

  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // Close any existing SSE connection
  if (adminEventSource) { adminEventSource.close(); adminEventSource = null; }

  // Firebase Realtime Database supports SSE (Server-Sent Events)
  // This gives REAL-TIME push without polling
  try {
    adminEventSource = new EventSource(`${url}/access_log.json`);

    const handleSseEvent = (data) => {
      if (!data) return;
      const path = data.path;
      const val = data.data;
      if (!val) return;

      if (path === '/') {
        // Initial snapshot or whole list update
        if (typeof val === 'object') {
          const timestamps = Object.values(val)
            .map(e => (e && e.timestamp) || 0);
          if (timestamps.length) {
            adminLastSeen = Math.max(adminLastSeen, ...timestamps);
          }
        }
      } else {
        // Child added/modified
        if (val.timestamp && val.timestamp > adminLastSeen) {
          adminLastSeen = val.timestamp;
          showAdminAccessAlert(val);
        } else if (typeof val === 'object') {
          // If a patch contains nested updates
          Object.values(val).forEach(entry => {
            if (entry && entry.timestamp && entry.timestamp > adminLastSeen) {
              adminLastSeen = entry.timestamp;
              showAdminAccessAlert(entry);
            }
          });
        }
      }
    };

    adminEventSource.addEventListener('put', (event) => {
      try {
        const data = JSON.parse(event.data);
        handleSseEvent(data);
      } catch(e) {}
    });

    adminEventSource.addEventListener('patch', (event) => {
      try {
        const data = JSON.parse(event.data);
        handleSseEvent(data);
      } catch(e) {}
    });

    adminEventSource.onerror = () => {
      // SSE disconnected — retry after 10s
      if (adminEventSource) { adminEventSource.close(); adminEventSource = null; }
      setTimeout(() => { if (isAdminDevice()) startAdminMonitoring(); }, 10000);
    };

    console.log('[Admin] Monitoring church access via Firebase SSE');
  } catch(e) {
    console.warn('[Admin] SSE not supported, falling back to polling');
    startAdminPolling();
  }
}

function startAdminPolling() {
  // Fallback polling every 5s if SSE not supported
  setInterval(async () => {
    if (!isAdminDevice()) return;
    const url = getChurchUrl();
    if (!url) return;
    try {
      const resp = await fetch(`${url}/access_log.json?orderBy=%22timestamp%22&startAt=${adminLastSeen + 1}&limitToFirst=5`, {
        signal: AbortSignal.timeout(4000)
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && typeof data === 'object') {
          Object.values(data).forEach(entry => {
            if (entry && entry.timestamp > adminLastSeen) {
              adminLastSeen = entry.timestamp;
              showAdminAccessAlert(entry);
            }
          });
        }
      }
    } catch(e) {}
  }, 5000);
}

function showAdminAccessAlert(entry) {
  const isSuccess = entry.success;
  const name = entry.name || 'Unknown';
  const platform = entry.platform || 'Unknown';
  const screen = entry.screen || '';
  const lang = entry.language || '';
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const devId = (entry.deviceId || '').substring(0, 18);
  const ua = (entry.userAgent || '').substring(0, 60);

  const icon  = isSuccess ? '✅' : '❌';
  const label = isSuccess ? 'ACCESS GRANTED' : 'WRONG PIN ATTEMPT';
  const color = isSuccess ? '#4ecb71' : '#ff453a';
  const bgColor = isSuccess ? 'rgba(78,203,113,0.08)' : 'rgba(255,69,58,0.08)';

  // 1. Native push notification (works even if app in background)
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`${icon} Church ${label}`, {
        body: `👤 ${name}\n📱 ${platform} · ${screen}\n🕐 ${time}`,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: `access_${entry.timestamp}`,
        requireInteraction: !isSuccess,
        vibrate: isSuccess ? [200] : [300, 100, 300, 100, 300]
      });
    } catch(e) {}
  }

  // 2. In-app floating alert (non-blocking)
  const alertEl = document.createElement('div');
  alertEl.style.cssText = `position:fixed;top:70px;left:50%;transform:translateX(-50%);width:92%;max-width:360px;background:#1c1c28;border:2px solid ${color};border-radius:16px;padding:14px 16px;z-index:99999;box-shadow:0 12px 40px rgba(0,0,0,0.9);`;
  alertEl.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <div style="font-size:26px;flex-shrink:0;margin-top:2px;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:10px;font-weight:800;letter-spacing:1px;color:${color};">${label}</div>
        <div style="font-size:15px;font-weight:700;color:#f0f0f5;margin-top:3px;">👤 ${escHtml(name)}</div>
        <div style="font-size:10px;color:#8888aa;margin-top:4px;">📱 ${escHtml(platform)} · ${escHtml(screen)} · ${escHtml(lang)}</div>
        <div style="font-size:9px;color:#56566a;margin-top:2px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">ID: ${escHtml(devId)}…</div>
        <div style="font-size:9px;color:#444;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(ua)}…</div>
        <div style="font-size:10px;color:#7c7cff;margin-top:4px;font-weight:600;">🕐 ${time}</div>
      </div>
      <button onclick="this.closest('[style]').remove()" style="background:none;border:none;color:#444;font-size:20px;cursor:pointer;padding:0;flex-shrink:0;">×</button>
    </div>`;
  document.body.appendChild(alertEl);
  // Slide-in animation
  alertEl.animate([{opacity:0,transform:'translateX(-50%) translateY(-20px)'},{opacity:1,transform:'translateX(-50%) translateY(0)'}], {duration:300,fill:'forwards'});
  // Auto-dismiss after 20s (failed attempts stay longer)
  setTimeout(() => { if (alertEl.parentNode) alertEl.remove(); }, isSuccess ? 12000 : 25000);
}

async function toggleAdminDevice() {
  const reqStatus = localStorage.getItem('ledger_admin_request_status');
  if (isAdminDevice() || reqStatus === 'pending') {
    if (reqStatus === 'pending') {
      try {
        if (useCloud()) {
          await fetch(`${getChurchUrl()}/admin_requests/${getDeviceId()}.json`, {
            method: 'DELETE'
          });
        } else if (getServerUrl()) {
          await fetch(`${getServerUrl()}/api/admin/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: getDeviceId(), status: 'none' })
          });
        }
      } catch(e) {}
      localStorage.removeItem('ledger_admin_request_status');
      if (adminRequestInterval) { clearInterval(adminRequestInterval); adminRequestInterval = null; }
      showToast('Admin request cancelled.');
    } else {
      setAdminDevice(false);
      if (adminEventSource) { adminEventSource.close(); adminEventSource = null; }
      showToast('Admin monitoring disabled on this device');
    }
    updateAdminStatus();
  } else {
    // Start request flow
    localStorage.setItem('ledger_admin_request_status', 'pending');
    updateAdminStatus();

    if ('Notification' in window) {
      Notification.requestPermission().then(perm => {
        if (perm !== 'granted') showToast('⚠️ Enable notifications in browser settings for alerts!');
      });
    }

    try {
      const payload = {
        deviceId: getDeviceId(),
        name: getPersonalName() || 'Unknown Phone',
        status: 'pending',
        timestamp: Date.now()
      };
      if (useCloud()) {
        await fetch(`${getChurchUrl()}/admin_requests/${getDeviceId()}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else if (getServerUrl()) {
        await fetch(`${getServerUrl()}/api/admin/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      showToast('Admin request sent! Please approve on the laptop.');
      startPollingAdminRequest();
    } catch(err) {
      localStorage.removeItem('ledger_admin_request_status');
      updateAdminStatus();
      showToast('❌ Failed to send admin request: ' + err.message);
    }
  }
}

function updateAdminStatus() {
  const btn = document.getElementById('admin-toggle-btn');
  const status = document.getElementById('admin-status-text');
  if (!btn || !status) return;

  const reqStatus = localStorage.getItem('ledger_admin_request_status');
  if (reqStatus === 'pending') {
    btn.textContent = '⏳ Cancel Admin Request';
    btn.style.background = 'rgba(255,159,10,0.15)';
    btn.style.borderColor = 'rgba(255,159,10,0.3)';
    btn.style.color = '#ff9f0a';
    status.textContent = '⏳ Pending laptop approval. Please allow this device to be the admin on the laptop app.';
    status.style.color = '#ff9f0a';
  } else if (isAdminDevice()) {
    btn.textContent = '🛡️ Disable Admin Mode';
    btn.style.background = 'rgba(255,69,58,0.15)';
    btn.style.borderColor = 'rgba(255,69,58,0.3)';
    btn.style.color = '#ff453a';
    status.textContent = '🛡️ ADMIN ACTIVE — You will receive real-time notifications for all church access attempts.';
    status.style.color = '#4ecb71';
  } else {
    btn.textContent = '🛡️ Request Admin Access';
    btn.style.background = 'rgba(255,159,10,0.1)';
    btn.style.borderColor = 'rgba(255,159,10,0.3)';
    btn.style.color = '#ff9f0a';
    status.textContent = 'Not admin. Request permission from the laptop to monitor church access.';
    status.style.color = '#56566a';
  }
}
