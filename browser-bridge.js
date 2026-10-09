/**
 * CHURCH LEDGER — UNIVERSAL BROWSER BRIDGE
 * Enables the full Desktop Church Ledger interface to run seamlessly in any browser
 * (Safari/Chrome on iPad M5, Mac, iPhone, Android, Windows, Linux) with real-time Firebase sync!
 */

(function () {
  'use strict';

  // If already running in Electron desktop with native bridge, keep it!
  if (window.electronAPI && typeof window.electronAPI.loadData === 'function') {
    console.log('⚡ Running in Electron Desktop native mode');
    return;
  }

  console.log('🌐 Initializing Church Ledger Universal Web/iPad Bridge...');

  const DEFAULT_FB_URL = 'https://church-ledger-e11f1-default-rtdb.asia-southeast1.firebasedatabase.app';
  
  function getFbUrl() {
    const u = localStorage.getItem('church_ledger_firebase_url') || DEFAULT_FB_URL;
    return u.trim().replace(/\/$/, '');
  }

  function getProfile() {
    return localStorage.getItem('church_ledger_active_profile') || 'church';
  }

  const listeners = {
    remoteDataUpdated: [],
    personalDataUpdated: [],
    adminRequest: [],
    adminRequestsUpdated: [],
    serverInfoReady: []
  };

  let localDataSnapshot = null;
  let lastRemoteTimestamp = 0;

  function seedDatabase() {
    return {
      weeks: {},
      months: {},
      fixedDeposits: [],
      loansAndDeposits: [],
      landlordLease: { baseRent: 150000, months: {} },
      settings: {
        tenantRates: {},
        tenantNames: {},
        columns: []
      },
      metrics: {
        liquidAssets: 0,
        fixedReserves: 0,
        sundayCollections: 0,
        estateYield: 0,
        operatingLosses: 0,
        vaultBalance: 0
      }
    };
  }

  // Load SheetJS dynamically if not already present
  function ensureXLSX() {
    return new Promise((resolve, reject) => {
      if (typeof window.XLSX !== 'undefined') return resolve(window.XLSX);
      
      const s = document.createElement('script');
      s.src = 'xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => {
        // Fallback to CDN
        const cdn = document.createElement('script');
        cdn.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        cdn.onload = () => resolve(window.XLSX);
        cdn.onerror = (e) => reject(new Error('Could not load Excel exporter library'));
        document.head.appendChild(cdn);
      };
      document.head.appendChild(s);
    });
  }

  // Define full electronAPI implementation for web browsers
  window.electronAPI = {
    // 1. Load Data
    loadData: async function () {
      const fbUrl = getFbUrl();
      const profile = getProfile();
      const isPersonal = profile === 'personal';
      const path = isPersonal ? '/personal_vault_data.json' : '/data.json';

      // Try Firebase Cloud first
      try {
        const resp = await fetch(`${fbUrl}${path}`, {
          signal: AbortSignal.timeout(7000),
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (resp.ok) {
          const cloudData = await resp.json();
          if (cloudData && typeof cloudData === 'object' && (cloudData.weeks || cloudData.months || cloudData.settings)) {
            localStorage.setItem(`church_ledger_cache_${profile}`, JSON.stringify(cloudData));
            localDataSnapshot = cloudData;
            return cloudData;
          }
        }
      } catch (err) {
        console.warn('Cloud fetch failed, trying local server API or cache:', err.message);
      }

      // Try backend server API if hosted on Node.js/Railway
      try {
        const apiPath = isPersonal ? '/api/personal' : '/api/data';
        const resp = await fetch(apiPath, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const srvData = await resp.json();
          if (srvData && typeof srvData === 'object' && (srvData.weeks || srvData.months)) {
            localStorage.setItem(`church_ledger_cache_${profile}`, JSON.stringify(srvData));
            localDataSnapshot = srvData;
            return srvData;
          }
        }
      } catch (e) {}

      // Fallback to local storage cache
      const cached = localStorage.getItem(`church_ledger_cache_${profile}`);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          localDataSnapshot = parsed;
          return parsed;
        } catch (e) {}
      }

      // Default seed database
      const fallback = seedDatabase();
      localDataSnapshot = fallback;
      return fallback;
    },

    // 2. Save Data
    saveData: async function (data) {
      if (!data) return false;
      const fbUrl = getFbUrl();
      const profile = getProfile();
      const isPersonal = profile === 'personal';
      const path = isPersonal ? '/personal_vault_data.json' : '/data.json';

      localDataSnapshot = data;
      localStorage.setItem(`church_ledger_cache_${profile}`, JSON.stringify(data));

      // Push to Firebase Realtime Database
      try {
        await fetch(`${fbUrl}${path}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
      } catch (err) {
        console.warn('Firebase sync failed (offline?):', err.message);
      }

      // Push to local/cloud backend server if available
      try {
        const apiPath = isPersonal ? '/api/personal' : '/api/data';
        fetch(apiPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        }).catch(() => {});
      } catch (e) {}

      return true;
    },

    // 3. Firebase Config
    getFirebaseUrl: async function () {
      return getFbUrl();
    },

    setFirebaseUrl: async function (url) {
      if (!url) {
        localStorage.removeItem('church_ledger_firebase_url');
      } else {
        localStorage.setItem('church_ledger_firebase_url', url.trim().replace(/\/$/, ''));
      }
      return true;
    },

    // 4. Profiles
    getActiveProfile: async function () {
      return getProfile();
    },

    switchProfile: async function (profile) {
      localStorage.setItem('church_ledger_active_profile', profile || 'church');
      return true;
    },

    // 5. PIN Access
    getChurchPin: async function () {
      const fbUrl = getFbUrl();
      try {
        const resp = await fetch(`${fbUrl}/config.json`, { signal: AbortSignal.timeout(4000) });
        if (resp.ok) {
          const cfg = await resp.json();
          if (cfg && cfg.churchPin) {
            localStorage.setItem('church_ledger_pin', String(cfg.churchPin).trim());
            return String(cfg.churchPin).trim();
          }
        }
      } catch (e) {}
      return localStorage.getItem('church_ledger_pin') || '1976';
    },

    setChurchPin: async function (pin) {
      const cleanPin = String(pin).trim();
      localStorage.setItem('church_ledger_pin', cleanPin);
      const fbUrl = getFbUrl();
      try {
        await fetch(`${fbUrl}/config/churchPin.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cleanPin)
        });
      } catch (e) {}
      return true;
    },

    // 6. Personal Device Profiles
    getAllPersonalProfiles: async function () {
      const fbUrl = getFbUrl();
      try {
        const resp = await fetch(`${fbUrl}/personal.json`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          return await resp.json() || {};
        }
      } catch (e) {}
      return {};
    },

    savePersonalProfile: async function (deviceId, profileData) {
      const fbUrl = getFbUrl();
      try {
        await fetch(`${fbUrl}/personal/${deviceId}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileData)
        });
      } catch (e) {}
      return true;
    },

    // 7. Admin Requests
    getPendingAdminRequests: async function () {
      const fbUrl = getFbUrl();
      try {
        const resp = await fetch(`${fbUrl}/admin_requests.json`, { signal: AbortSignal.timeout(4000) });
        if (resp.ok) return await resp.json() || {};
      } catch (e) {}
      return {};
    },

    setAdminRequestStatus: async function (deviceId, status) {
      const fbUrl = getFbUrl();
      try {
        if (status === 'denied' || status === 'none') {
          await fetch(`${fbUrl}/admin_requests/${deviceId}.json`, { method: 'DELETE' });
        } else {
          await fetch(`${fbUrl}/admin_requests/${deviceId}/status.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(status)
          });
          if (status === 'approved') {
            await fetch(`${fbUrl}/config/approvedAdminDeviceId.json`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(deviceId)
            });
          }
        }
      } catch (e) {}
      return true;
    },

    // 8. Excel Export (Client-Side SheetJS)
    exportExcel: async function (data) {
      try {
        const XLSX = await ensureXLSX();
        const wb = XLSX.utils.book_new();

        if (data.mainGrid && data.mainGrid.length) {
          const ws = XLSX.utils.json_to_sheet(data.mainGrid);
          XLSX.utils.book_append_sheet(wb, ws, "Master Ledger Grid");
        }
        if (data.tenants && data.tenants.length) {
          const ws = XLSX.utils.json_to_sheet(data.tenants);
          XLSX.utils.book_append_sheet(wb, ws, "Tenant Ledger History");
        }
        if (data.outgoings && data.outgoings.length) {
          const ws = XLSX.utils.json_to_sheet(data.outgoings);
          XLSX.utils.book_append_sheet(wb, ws, "Operating Expenses");
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = `Church_Ledger_${dateStr}.xlsx`;
        XLSX.writeFile(wb, fileName);
        return true;
      } catch (err) {
        console.error('Browser Excel Export Error:', err);
        throw err;
      }
    },

    // 9. Backup & Import
    createBackup: async function (data) {
      try {
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateStr = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `Church_Ledger_Backup_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1000);
        return true;
      } catch (err) {
        console.error('Backup Error:', err);
        throw err;
      }
    },

    importData: async function () {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';

        input.onchange = async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) {
            document.body.removeChild(input);
            return resolve({ canceled: true });
          }
          try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!parsed.weeks && !parsed.months && !parsed.settings) {
              document.body.removeChild(input);
              return resolve({ success: false, error: 'File is not a valid Church Ledger backup.' });
            }
            await window.electronAPI.saveData(parsed);
            document.body.removeChild(input);
            resolve({ success: true, data: parsed });
          } catch (err) {
            document.body.removeChild(input);
            resolve({ success: false, error: err.message });
          }
        };

        document.body.appendChild(input);
        input.click();
      });
    },

    // 10. Receipts & File Handling
    copyReceipt: async function (fileOrPath) {
      if (typeof fileOrPath === 'string' && (fileOrPath.startsWith('data:') || fileOrPath.startsWith('http'))) {
        return fileOrPath;
      }
      return new Promise((resolve, reject) => {
        if (fileOrPath instanceof Blob || fileOrPath instanceof File) {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(fileOrPath);
        } else {
          resolve(String(fileOrPath));
        }
      });
    },

    openFile: async function (filePath) {
      if (!filePath) return;
      if (filePath.startsWith('data:') || filePath.startsWith('http://') || filePath.startsWith('https://')) {
        const win = window.open('');
        if (win) {
          win.document.write(`
            <!DOCTYPE html>
            <html>
            <head><title>Receipt Viewer</title></head>
            <body style="margin:0;background:#0d0d12;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
              <div style="text-align:center;">
                <img src="${filePath}" style="max-width:92vw;max-height:90vh;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.7);object-fit:contain;background:#fff;padding:8px;" alt="Receipt">
                <div style="margin-top:12px;"><a href="${filePath}" download="receipt.png" style="color:#7c7cff;font-weight:700;text-decoration:none;background:rgba(124,124,255,0.15);padding:8px 16px;border-radius:8px;">⬇ Download Receipt</a></div>
              </div>
            </body>
            </html>
          `);
        } else {
          window.location.href = filePath;
        }
      } else {
        alert('File path: ' + filePath);
      }
    },

    // 11. Server info & QR codes
    getServerInfo: async function () {
      return {
        ip: window.location.hostname || 'cloud',
        port: window.location.port || '443',
        url: window.location.origin || getFbUrl(),
        qrDataUrl: null
      };
    },

    // 12. Realtime Event Handlers
    onRemoteDataUpdated: function (callback) {
      listeners.remoteDataUpdated.push(callback);
    },
    onPersonalDataUpdated: function (callback) {
      listeners.personalDataUpdated.push(callback);
    },
    onAdminRequest: function (callback) {
      listeners.adminRequest.push(callback);
    },
    onAdminRequestsUpdated: function (callback) {
      listeners.adminRequestsUpdated.push(callback);
    },
    onServerInfoReady: function (callback) {
      listeners.serverInfoReady.push(callback);
      callback({
        ip: window.location.hostname || 'cloud',
        port: window.location.port || '443',
        url: window.location.origin || getFbUrl()
      });
    },

    // 13. Window control mocks for browser
    windowMinimize: function () {},
    windowMaximize: function () {},
    windowClose: function () {}
  };

  // ── Realtime Firebase Live Sync Listener ────────────────────────────────
  function startRealtimeSync() {
    const fbUrl = getFbUrl();
    let sse = null;

    try {
      sse = new EventSource(`${fbUrl}/data.json`);
      sse.addEventListener('put', (e) => {
        try {
          const parsed = JSON.parse(e.data);
          if (parsed && parsed.data && typeof parsed.data === 'object') {
            const newJson = JSON.stringify(parsed.data);
            const currentJson = JSON.stringify(localDataSnapshot);
            if (newJson !== currentJson) {
              console.log('🔄 Live remote sync update received from cloud');
              localDataSnapshot = parsed.data;
              localStorage.setItem(`church_ledger_cache_${getProfile()}`, newJson);
              listeners.remoteDataUpdated.forEach(cb => {
                try { cb(); } catch (err) {}
              });
            }
          }
        } catch (err) {}
      });

      sse.onerror = () => {
        // Fallback to polling if SSE is closed/blocked
        sse.close();
        startPollingFallback();
      };
    } catch (e) {
      startPollingFallback();
    }
  }

  let pollInterval = null;
  function startPollingFallback() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      if (document.hidden) return; // Save battery/data when tab in background
      const fbUrl = getFbUrl();
      const profile = getProfile();
      const path = profile === 'personal' ? '/personal_vault_data.json' : '/data.json';
      try {
        const resp = await fetch(`${fbUrl}${path}?shallow=false`, {
          signal: AbortSignal.timeout(4000),
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && typeof data === 'object') {
            const newJson = JSON.stringify(data);
            const currentJson = JSON.stringify(localDataSnapshot);
            if (newJson !== currentJson) {
              console.log('🔄 Cloud polling update detected');
              localDataSnapshot = data;
              localStorage.setItem(`church_ledger_cache_${profile}`, newJson);
              listeners.remoteDataUpdated.forEach(cb => {
                try { cb(); } catch (err) {}
              });
            }
          }
        }
      } catch (err) {}
    }, 4000);
  }

  // Start syncing once DOM is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startRealtimeSync();
      applyBrowserUIEnhancements();
    });
  } else {
    startRealtimeSync();
    applyBrowserUIEnhancements();
  }

  // ── UI Enhancements for iPad & Web Browsers ─────────────────────────────
  function applyBrowserUIEnhancements() {
    // Hide native Mac/Windows titlebar buttons when inside standard browser
    const winControls = document.querySelector('.window-controls');
    if (winControls) {
      winControls.style.display = 'none';
    }

    // Add Live Sync Badge in titlebar
    const titleBar = document.querySelector('.app-titlebar');
    if (titleBar && !document.getElementById('live-cloud-badge')) {
      const badge = document.createElement('div');
      badge.id = 'live-cloud-badge';
      badge.style.cssText = 'display:flex;align-items:center;gap:6px;background:rgba(78,203,113,0.12);border:1px solid rgba(78,203,113,0.3);border-radius:12px;padding:3px 10px;font-size:10px;font-weight:700;color:#4ecb71;margin-left:12px;cursor:pointer;';
      badge.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#4ecb71;display:inline-block;box-shadow:0 0 8px #4ecb71;"></span> LIVE CLOUD SYNC';
      badge.title = 'Connected to Firebase Realtime Cloud — synced with all devices';
      
      const titleEl = document.querySelector('.app-title');
      if (titleEl && titleEl.parentNode) {
        titleEl.parentNode.insertBefore(badge, titleEl.nextSibling);
      }
    }
  }
})();
