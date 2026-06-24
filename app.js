/* ════════════════════════════════════════════════════════
   app.js — מערכת נקודות אהל שלמה
   ════════════════════════════════════════════════════════ */

const firebaseConfig = {
  apiKey:            "AIzaSyAIYJa_CSmJ0zXgv_7BspsZ8PSq7NIoeMY",
  authDomain:        "osunits-638ff.firebaseapp.com",
  projectId:         "osunits-638ff",
  storageBucket:     "osunits-638ff.firebasestorage.app",
  messagingSenderId: "896549318068",
  appId:             "1:896549318068:web:a5b96ecdae6a15d67cd6e1"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// ─── Global state ────────────────────────────────────────
let currentUser        = null;
let nfcAbortController = null;
let activeTeacherUID   = null;
let selectedReason     = "הצטיינות בשיעור";
let allStudents        = [];          // cache for students tab
let pendingDeleteUID   = null;        // UID waiting for delete confirmation
let importRows         = [];          // parsed Excel rows waiting to import

// ─── Utilities ───────────────────────────────────────────

function showToast(msg, type = "default", duration = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className   = "show " + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = "", duration);
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("he-IL", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

function serialBytesToHex(serialNumber) {
  const clean = serialNumber.replace(/[^0-9a-fA-F]/g, "");
  return clean.match(/.{1,2}/g).join(":").toLowerCase();
}

function setNfcStatus(elementId, state, msg) {
  const el = document.getElementById(elementId);
  el.className   = "nfc-status " + state;
  el.textContent = msg;
}

function studentCardHTML(name, grade, balance) {
  return `
    <span class="sp-label">תלמיד</span>
    <p class="sp-name">${name}</p>
    <p class="sp-meta">כיתה ${grade}</p>
    <div class="sp-balance-row">
      <span class="sp-balance-label">יתרה</span>
      <span class="sp-balance">${balance}</span>
      <span class="sp-unit">נקודות</span>
    </div>`;
}

// ─── NFC ─────────────────────────────────────────────────

async function scanNFC(statusElId, btnLabelId, onUID) {
  if (!("NDEFReader" in window)) {
    setNfcStatus(statusElId, "error",
      "⚠️ Web NFC אינו נתמך בדפדפן זה. השתמש ב-Chrome אנדרואיד.");
    return;
  }
  if (nfcAbortController) { nfcAbortController.abort(); nfcAbortController = null; }
  nfcAbortController = new AbortController();
  try {
    const ndef = new NDEFReader();
    setNfcStatus(statusElId, "scanning", "📡 ממתין לתג NFC… הצמד את הכרטיס");
    document.getElementById(btnLabelId).textContent = "מבטל סריקה";
    await ndef.scan({ signal: nfcAbortController.signal });
    ndef.addEventListener("reading", ({ serialNumber }) => {
      const uid = serialBytesToHex(serialNumber);
      setNfcStatus(statusElId, "success", `✅ זוהה: ${uid}`);
      document.getElementById(btnLabelId).textContent = "סרוק שוב";
      nfcAbortController.abort();
      nfcAbortController = null;
      onUID(uid);
    });
    ndef.addEventListener("readingerror", () => {
      setNfcStatus(statusElId, "error", "❌ שגיאה בקריאת התג — נסה שוב");
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    const msg = err.name === "NotAllowedError"
      ? "⚠️ ההרשאה ל-NFC נדחתה. אנא אפשר גישה."
      : `❌ שגיאת NFC: ${err.message}`;
    setNfcStatus(statusElId, "error", msg);
  }
}

function stopNFC(btnLabelId, originalLabel) {
  if (nfcAbortController) { nfcAbortController.abort(); nfcAbortController = null; }
  if (btnLabelId) document.getElementById(btnLabelId).textContent = originalLabel;
}

// ─── Auth ─────────────────────────────────────────────────

// Email / password login
document.getElementById("btn-login").addEventListener("click", async () => {
  const email    = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const errEl    = document.getElementById("auth-error");
  const btn      = document.getElementById("btn-login");
  const lbl      = document.getElementById("login-label");
  if (!email || !password) {
    errEl.textContent = "יש למלא אימייל וסיסמה.";
    errEl.className   = "nfc-status error mt-8";
    return;
  }
  lbl.innerHTML = '<div class="spinner"></div>';
  btn.disabled  = true;
  errEl.className = "nfc-status mt-8";
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    const msgs = {
      "auth/user-not-found":    "משתמש לא נמצא.",
      "auth/wrong-password":    "סיסמה שגויה.",
      "auth/invalid-email":     "כתובת אימייל לא תקינה.",
      "auth/invalid-credential":"אימייל או סיסמה שגויים.",
      "auth/too-many-requests": "יותר מדי ניסיונות. נסה שוב מאוחר יותר."
    };
    errEl.textContent = msgs[err.code] || `שגיאה: ${err.message}`;
    errEl.className   = "nfc-status error mt-8";
  } finally {
    lbl.textContent = "כניסה";
    btn.disabled    = false;
  }
});

// Google login
document.getElementById("btn-google-login").addEventListener("click", async () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  const errEl    = document.getElementById("auth-error");
  try {
    await auth.signInWithPopup(provider);
    // onAuthStateChanged handles the rest
  } catch (err) {
    if (err.code === "auth/popup-closed-by-user") return;
    errEl.textContent = `שגיאת Google: ${err.message}`;
    errEl.className   = "nfc-status error mt-8";
  }
});

// Enter key
document.getElementById("auth-password").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

// Logout
document.getElementById("btn-logout").addEventListener("click", async () => {
  stopNFC();
  await auth.signOut();
});

// Auth state
auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) {
    document.getElementById("auth-screen").style.display = "none";
    document.getElementById("app-screen").classList.add("visible");
    document.getElementById("user-email-display").textContent =
      user.displayName || user.email;
    loadRecentTransactions();
  } else {
    document.getElementById("auth-screen").style.display = "flex";
    document.getElementById("app-screen").classList.remove("visible");
  }
});

// ─── Tab navigation ───────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    stopNFC();
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "store")    loadRecentTransactions();
    if (btn.dataset.tab === "students") loadStudents();
  });
});

// ─── Register tab ─────────────────────────────────────────

let pendingRegUID = null;

document.getElementById("btn-scan-register").addEventListener("click", () => {
  if (nfcAbortController) {
    stopNFC("scan-reg-label", "סרוק תג NFC לשיוך");
    setNfcStatus("nfc-status-register", "", "");
    return;
  }
  scanNFC("nfc-status-register", "scan-reg-label", uid => {
    pendingRegUID = uid;
    document.getElementById("reg-uid-manual").value = uid;
    document.getElementById("scan-reg-label").textContent = "סרוק תג NFC לשיוך";
  });
});

document.getElementById("btn-register-submit").addEventListener("click", async () => {
  const name  = document.getElementById("reg-name").value.trim();
  const grade = document.getElementById("reg-grade").value;
  const uid   = (document.getElementById("reg-uid-manual").value.trim() || pendingRegUID || "").toLowerCase();
  if (!name)  return showToast("יש להזין שם תלמיד", "error");
  if (!grade) return showToast("יש לבחור כיתה", "error");
  if (!uid)   return showToast("יש לסרוק תג NFC או להזין UID ידנית", "error");

  const btn = document.getElementById("btn-register-submit");
  btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>';
  try {
    const docRef = db.collection("students").doc(uid);
    const snap   = await docRef.get();
    if (snap.exists) {
      showToast("❌ תג זה כבר שויך לתלמיד: " + snap.data().name, "error", 4000);
      return;
    }
    await docRef.set({
      name, grade, balance: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.email
    });
    await logTransaction(uid, name, currentUser.email, 0, "רישום תלמיד חדש");
    document.getElementById("reg-student-preview").innerHTML = studentCardHTML(name, grade, 0);
    document.getElementById("reg-result-card").style.display = "block";
    document.getElementById("reg-name").value        = "";
    document.getElementById("reg-grade").value       = "";
    document.getElementById("reg-uid-manual").value  = "";
    pendingRegUID = null;
    setNfcStatus("nfc-status-register", "success", `✅ ${name} נרשם בהצלחה! UID: ${uid}`);
    showToast(`✅ ${name} נרשם בהצלחה!`, "success");
  } catch (err) {
    showToast("❌ שגיאה ברישום: " + err.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "רשום תלמיד";
  }
});

// ─── Teacher tab ──────────────────────────────────────────

document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    selectedReason = chip.dataset.reason;
    const custom = document.getElementById("teacher-reason-custom");
    if (selectedReason === "אחר") { custom.style.display = "block"; custom.focus(); }
    else { custom.style.display = "none"; custom.value = ""; }
  });
});

document.getElementById("btn-scan-teacher").addEventListener("click", () => {
  if (nfcAbortController) {
    stopNFC("scan-teacher-label", "הצמד כרטיס לזיהוי");
    setNfcStatus("nfc-status-teacher", "", "");
    return;
  }
  scanNFC("nfc-status-teacher", "scan-teacher-label", uid => {
    document.getElementById("teacher-uid-manual").value = uid;
    loadStudentForTeacher(uid);
  });
});

document.getElementById("btn-teacher-manual-lookup").addEventListener("click", () => {
  const uid = document.getElementById("teacher-uid-manual").value.trim().toLowerCase();
  if (!uid) return showToast("הזן UID תחילה", "error");
  loadStudentForTeacher(uid);
});

async function loadStudentForTeacher(uid) {
  document.getElementById("teacher-student-section").style.display = "none";
  activeTeacherUID = null;
  try {
    const snap = await db.collection("students").doc(uid).get();
    if (!snap.exists) {
      setNfcStatus("nfc-status-teacher", "error", "❌ תלמיד לא נמצא — בדוק שהתג רשום במערכת");
      return;
    }
    const s = snap.data();
    activeTeacherUID = uid;
    document.getElementById("teacher-student-preview").innerHTML =
      studentCardHTML(s.name, s.grade, s.balance);
    document.getElementById("teacher-student-section").style.display = "block";
    setNfcStatus("nfc-status-teacher", "success", `✅ ${s.name} — כיתה ${s.grade}`);
  } catch (err) {
    setNfcStatus("nfc-status-teacher", "error", "❌ שגיאה בטעינת נתונים");
  }
}

document.getElementById("btn-award-points").addEventListener("click", async () => {
  if (!activeTeacherUID) return showToast("יש לסרוק כרטיס תחילה", "error");
  const points = parseInt(document.getElementById("teacher-points").value);
  if (!points || points <= 0) return showToast("הזן כמות נקודות תקינה", "error");
  const customReason = document.getElementById("teacher-reason-custom").value.trim();
  const reason = (selectedReason === "אחר" && customReason) ? customReason : selectedReason;
  if (!reason) return showToast("בחר סיבה לתגמול", "error");

  const btn = document.getElementById("btn-award-points");
  btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>';
  try {
    const ref  = db.collection("students").doc(activeTeacherUID);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("תלמיד לא נמצא");
    const s = snap.data();
    const newBalance = s.balance + points;
    await ref.update({
      balance: firebase.firestore.FieldValue.increment(points),
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    });
    await logTransaction(activeTeacherUID, s.name, currentUser.email, points, reason);
    document.getElementById("teacher-student-preview").innerHTML =
      studentCardHTML(s.name, s.grade, newBalance);
    showToast(`✅ הוענקו ${points} נקודות ל-${s.name}!`, "success");
    document.getElementById("teacher-points").value = "";
  } catch (err) {
    showToast("❌ שגיאה בהענקת נקודות: " + err.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "הענק נקודות ✨";
  }
});

// ─── Store tab ────────────────────────────────────────────

document.getElementById("btn-scan-store").addEventListener("click", () => {
  if (nfcAbortController) {
    stopNFC("scan-store-label", "הצמד כרטיס לתשלום");
    setNfcStatus("nfc-status-store", "", "");
    return;
  }
  const cost = parseInt(document.getElementById("store-cost").value);
  if (!cost || cost <= 0) { showToast("הזן עלות מוצר לפני הסריקה", "error"); return; }
  scanNFC("nfc-status-store", "scan-store-label", uid => {
    document.getElementById("store-uid-manual").value = uid;
    processPayment(uid);
  });
});

document.getElementById("btn-store-manual-pay").addEventListener("click", () => {
  const uid = document.getElementById("store-uid-manual").value.trim().toLowerCase();
  if (!uid) return showToast("הזן UID תחילה", "error");
  processPayment(uid);
});

async function processPayment(uid) {
  const cost     = parseInt(document.getElementById("store-cost").value);
  const itemName = document.getElementById("store-item").value.trim() || "מוצר";
  document.getElementById("store-result-card").style.display = "none";
  if (!cost || cost <= 0) return showToast("הזן עלות מוצר תקינה", "error");

  const btn = document.getElementById("btn-scan-store");
  btn.disabled = true;
  try {
    const studentRef = db.collection("students").doc(uid);
    const result = await db.runTransaction(async txn => {
      const snap = await txn.get(studentRef);
      if (!snap.exists) throw new Error("תלמיד לא נמצא במערכת");
      const s = snap.data();
      if (s.balance < cost)
        throw new Error(`יתרה לא מספיקה: ${s.balance} נקודות (נדרש: ${cost})`);
      txn.update(studentRef, {
        balance: firebase.firestore.FieldValue.increment(-cost),
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { name: s.name, grade: s.grade, newBalance: s.balance - cost };
    });
    await logTransaction(uid, result.name, currentUser.email, -cost, `קניה בחנות: ${itemName}`);
    document.getElementById("store-student-preview").innerHTML =
      studentCardHTML(result.name, result.grade, result.newBalance);
    document.getElementById("store-result-card").style.display = "block";
    setNfcStatus("nfc-status-store", "success",
      `✅ תשלום אושר! ${result.name} שילם ${cost} נקודות עבור "${itemName}"`);
    showToast(`✅ תשלום של ${cost} נקודות אושר!`, "success");
    document.getElementById("store-cost").value       = "";
    document.getElementById("store-item").value       = "";
    document.getElementById("store-uid-manual").value = "";
    loadRecentTransactions();
  } catch (err) {
    setNfcStatus("nfc-status-store", "error", "❌ " + err.message);
    showToast("❌ " + err.message, "error", 4500);
  } finally {
    btn.disabled = false;
    document.getElementById("scan-store-label").textContent = "הצמד כרטיס לתשלום";
  }
}

// ─── Students tab ─────────────────────────────────────────

document.getElementById("btn-refresh-students").addEventListener("click", loadStudents);

document.getElementById("students-search").addEventListener("input", function () {
  renderStudentsTable(this.value.trim());
});

async function loadStudents() {
  const tbody = document.getElementById("students-tbody");
  tbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center" style="padding:20px">טוען...</td></tr>';
  try {
    // ללא orderBy — ממיינים בצד הלקוח כדי למנוע שגיאת Firestore Index
    const snap = await db.collection("students").get();
    allStudents = [];
    snap.forEach(doc => allStudents.push({ uid: doc.id, ...doc.data() }));
    // מיון לפי שם בעברית
    allStudents.sort((a, b) => (a.name || "").localeCompare(b.name || "", "he"));
    renderStudentsTable(document.getElementById("students-search").value.trim());
  } catch (err) {
    console.error("loadStudents error:", err);
    tbody.innerHTML = `<tr><td colspan="5" class="text-muted text-center" style="padding:20px;color:red">שגיאה: ${err.message}</td></tr>`;
  }
}

function renderStudentsTable(filter = "") {
  const tbody = document.getElementById("students-tbody");
  const q     = filter.toLowerCase();
  const rows  = filter
    ? allStudents.filter(s =>
        s.name?.toLowerCase().includes(q) || s.grade?.toLowerCase().includes(q))
    : allStudents;

  document.getElementById("students-count").textContent =
    `סה"כ: ${rows.length} תלמידים מתוך ${allStudents.length}`;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center" style="padding:20px">לא נמצאו תלמידים</td></tr>';
    return;
  }
  tbody.innerHTML = "";
  rows.forEach(s => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight:600">${s.name}</td>
      <td>${s.grade || "—"}</td>
      <td><span class="badge-balance">${s.balance ?? 0}</span></td>
      <td style="color:var(--c-muted);font-size:12px">${fmtDate(s.lastUpdated)}</td>
      <td>
        <button class="btn-delete-student" data-uid="${s.uid}" data-name="${s.name}" title="מחק תלמיד">🗑️</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // Bind delete buttons
  tbody.querySelectorAll(".btn-delete-student").forEach(btn => {
    btn.addEventListener("click", () => openDeleteModal(btn.dataset.uid, btn.dataset.name));
  });
}

// ─── Delete modal ─────────────────────────────────────────

function openDeleteModal(uid, name) {
  pendingDeleteUID = uid;
  document.getElementById("delete-modal-text").textContent =
    `האם למחוק את "${name}"? כל הנקודות וההיסטוריה שלו יישמרו בעסקאות, אך הפרופיל יימחק לצמיתות.`;
  document.getElementById("delete-modal").classList.remove("hidden");
}

document.getElementById("btn-cancel-delete").addEventListener("click", () => {
  document.getElementById("delete-modal").classList.add("hidden");
  pendingDeleteUID = null;
});

document.getElementById("btn-confirm-delete").addEventListener("click", async () => {
  if (!pendingDeleteUID) return;
  const btn = document.getElementById("btn-confirm-delete");
  btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>';
  try {
    await db.collection("students").doc(pendingDeleteUID).delete();
    document.getElementById("delete-modal").classList.add("hidden");
    showToast("🗑️ התלמיד נמחק בהצלחה", "success");
    allStudents = allStudents.filter(s => s.uid !== pendingDeleteUID);
    pendingDeleteUID = null;
    renderStudentsTable(document.getElementById("students-search").value.trim());
  } catch (err) {
    showToast("❌ שגיאה במחיקה: " + err.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "כן, מחק";
  }
});

// Close modal on overlay click
document.getElementById("delete-modal").addEventListener("click", function(e) {
  if (e.target === this) {
    this.classList.add("hidden");
    pendingDeleteUID = null;
  }
});

// ─── Excel import ─────────────────────────────────────────

document.getElementById("excel-upload-zone").addEventListener("click", () => {
  document.getElementById("excel-file-input").click();
});

document.getElementById("excel-file-input").addEventListener("change", function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const wb   = XLSX.read(e.target.result, { type: "array" });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { defval: "" });

      if (!data.length) { showToast("הקובץ ריק או לא נקרא כראוי", "error"); return; }

      // Try to find name/grade/points columns flexibly
      importRows = data.map(row => {
        const keys  = Object.keys(row);
        const nameKey   = keys.find(k => /שם|name/i.test(k)) || keys[0];
        const gradeKey  = keys.find(k => /כית|class|grade/i.test(k)) || keys[1];
        const pointsKey = keys.find(k => /נקוד|point|balance/i.test(k));
        return {
          name:    String(row[nameKey] || "").trim(),
          grade:   String(row[gradeKey] || "").trim(),
          balance: pointsKey ? (parseInt(row[pointsKey]) || 0) : 0
        };
      }).filter(r => r.name);

      if (!importRows.length) { showToast("לא נמצאו שורות תקינות עם שמות", "error"); return; }

      // Show preview
      const tbody = document.getElementById("import-preview-body");
      tbody.innerHTML = "";
      importRows.slice(0, 10).forEach((r, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${i+1}</td><td>${r.name}</td><td>${r.grade||"—"}</td><td>${r.balance}</td>`;
        tbody.appendChild(tr);
      });
      if (importRows.length > 10) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="4" class="text-muted text-center">...ועוד ${importRows.length - 10} תלמידים</td>`;
        tbody.appendChild(tr);
      }
      document.getElementById("import-preview-count").textContent =
        `נמצאו ${importRows.length} תלמידים לייבוא`;
      document.getElementById("import-preview").style.display = "block";
    } catch (err) {
      showToast("❌ שגיאה בקריאת הקובץ: " + err.message, "error");
    }
  };
  reader.readAsArrayBuffer(file);
  this.value = ""; // reset input
});

document.getElementById("btn-import-cancel").addEventListener("click", () => {
  document.getElementById("import-preview").style.display = "none";
  importRows = [];
});

document.getElementById("btn-import-confirm").addEventListener("click", async () => {
  if (!importRows.length) return;
  const btn = document.getElementById("btn-import-confirm");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> מייבא...';

  let added = 0, skipped = 0;
  try {
    // Batch writes (max 500 per batch)
    const BATCH_SIZE = 400;
    for (let i = 0; i < importRows.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = importRows.slice(i, i + BATCH_SIZE);
      for (const row of chunk) {
        // Use auto-ID for imported students (no NFC tag yet)
        const ref = db.collection("students").doc();
        batch.set(ref, {
          name:        row.name,
          grade:       row.grade,
          balance:     row.balance,
          createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
          lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy:   currentUser.email,
          importedFromExcel: true
        });
        added++;
      }
      await batch.commit();
    }
    showToast(`✅ יובאו ${added} תלמידים בהצלחה!`, "success", 4000);
    document.getElementById("import-preview").style.display = "none";
    importRows = [];
    loadStudents(); // refresh table
  } catch (err) {
    showToast("❌ שגיאה בייבוא: " + err.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "ייבא לכל התלמידים ✅";
  }
});

// ─── Transactions ─────────────────────────────────────────

async function logTransaction(studentUID, studentName, teacherEmail, amount, description) {
  await db.collection("transactions").add({
    timestamp:     firebase.firestore.FieldValue.serverTimestamp(),
    student_uid:   studentUID,
    student_name:  studentName,
    teacher_email: teacherEmail,
    amount,
    description
  });
}

async function loadRecentTransactions() {
  const list = document.getElementById("tx-list");
  list.innerHTML = '<li class="text-muted">טוען...</li>';
  try {
    const snap = await db.collection("transactions")
      .orderBy("timestamp", "desc").limit(20).get();
    if (snap.empty) {
      list.innerHTML = '<li class="text-muted text-center">אין עסקאות עדיין</li>';
      return;
    }
    list.innerHTML = "";
    snap.forEach(doc => {
      const t  = doc.data();
      const li = document.createElement("li");
      li.className = "tx-item";
      const positive = t.amount >= 0;
      li.innerHTML = `
        <div>
          <p class="tx-desc">${t.student_name || "—"}
            <span style="color:var(--c-muted);font-weight:400;font-size:12px"> / ${t.description}</span>
          </p>
          <p class="tx-sub">${fmtDate(t.timestamp)} · ${t.teacher_email}</p>
        </div>
        <span class="tx-amount ${positive ? "positive" : "negative"}">
          ${positive ? "+" : ""}${t.amount}
        </span>`;
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = '<li class="nfc-status error">שגיאה בטעינת עסקאות</li>';
  }
}

// ─── PWA ──────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch(err => console.warn("SW registration failed:", err));
  });
}
