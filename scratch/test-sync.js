// ─── standalone test script for LWW merge verification ────────────────────
const fs = require('fs');

function mergeMobileEdits(local, incoming) {
  if (!local) return incoming;
  if (!incoming) return local;

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

      if (incomingTime > localTime) {
        localTenants[tid] = JSON.parse(JSON.stringify(incomingT));
      }
    });
  });

  return merged;
}

// Mock Database States
const localDb = {
  weeks: {
    "2026-06-07": { sundayDate: "2026-06-07", offering: 5000, outgoings: [] } // edited on laptop
  },
  months: {
    "2026-06": {
      tenants: {
        "room1": { paid: false, amount: 0, paymentDate: "2026-06-07", updatedAt: 1000 },
        "room2": { paid: true, amount: 4000, paymentDate: "2026-06-07", updatedAt: 2000 } // laptop updated room2
      }
    }
  },
  settings: { tenantRates: { "room1": 3000, "room2": 4000 } }
};

const incomingDb = {
  weeks: {
    "2026-06-07": { sundayDate: "2026-06-07", offering: 0, outgoings: [] } // old/unupdated week data on phone
  },
  months: {
    "2026-06": {
      tenants: {
        "room1": { paid: true, amount: 3000, paymentDate: "2026-06-08", updatedAt: 5000 }, // phone marked room1 PAID offline
        "room2": { paid: false, amount: 0, paymentDate: "2026-06-07", updatedAt: 500 } // stale room2 on phone
      }
    }
  },
  settings: { tenantRates: { "room1": 3000, "room2": 4000 } }
};

console.log("=== RUNNING SYNC TEST ===");

const result = mergeMobileEdits(localDb, incomingDb);

let passed = true;

// Assertion 1: Weekly offerings from laptop MUST be preserved
if (result.weeks["2026-06-07"].offering === 5000) {
  console.log("✅ PASS: Laptop weekly offerings preserved (5000)");
} else {
  console.error("❌ FAIL: Laptop weekly offerings overwritten!");
  passed = false;
}

// Assertion 2: Room 1 (modified on phone offline with higher timestamp) must be PAID
if (result.months["2026-06"].tenants["room1"].paid === true && result.months["2026-06"].tenants["room1"].updatedAt === 5000) {
  console.log("✅ PASS: Phone offline edit for room1 merged successfully (PAID, t=5000)");
} else {
  console.error("❌ FAIL: Phone offline edit for room1 was lost!");
  passed = false;
}

// Assertion 3: Room 2 (modified on laptop with higher timestamp) must remain PAID (phone stale edit ignored)
if (result.months["2026-06"].tenants["room2"].paid === true && result.months["2026-06"].tenants["room2"].updatedAt === 2000) {
  console.log("✅ PASS: Laptop edit for room2 wins over stale phone data (PAID, t=2000)");
} else {
  console.error("❌ FAIL: Laptop edit for room2 was overwritten by stale phone data!");
  passed = false;
}

if (passed) {
  console.log("\n🎉 ALL MERGE SYNC TESTS PASSED SUCCESSFULLY! 🎉");
} else {
  process.exit(1);
}
