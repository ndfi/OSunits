/* ════════════════════════════════════════════════════════
   app.js — School NFC Credit Card System
   ════════════════════════════════════════════════════════ */

// ─── 1. Firebase configuration ───────────────────────────
// ⚠️  החלף את הערכים האלה בפרטי פרויקט Firebase שלך
//     (מצא אותם ב-Firebase Console → Project Settings → General)
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// ─── 2. Global state ────────────────────────────────────
let currentUser       = null;   // Firebase Auth user
let nfcAbortController = null;  // for stopping NDEFReader.scan()
let activeTeacherUID  = null;   // UID loaded on teacher tab
let selectedReason    = "הצטיינות בשיעור";

// ─── 3. Utility helpers ─────────────────────────────────

/** Show a temporary toast message */
function showToast(msg, type = "default", duration = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className   = "show " + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = "", duration);
}

/** Format a Firestore Timestamp (or Date) to Hebrew locale string */
function fmtDate(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("he-IL", { day:"2-digit", month:"2-digit", year:"2-digit",
                                     hour:"2-digit", minute:"2-digit" });
}

/** Convert raw NFC serial bytes to hex string: "04:a3:2b:…" */
function serialBytesToHex(serialNumber) {
  // serialNumber from NDEFReader is a string like "04a32b..."
  // Some browsers return it as colon-separated already; normalise:
  const clean = serialNumber.replace(/[^0-9a-fA-F]/g, "");
  return clean.match(/.{1,2}/g).join(":").toLowerCase();
}

/** Set status badge on a given element */
function setNfcStatus(elementId, state, msg) {
  const el = document.getElementById(elementId);
  el.className = "nfc-status " + state;
  el.textContent = msg;
  if (state === "") el.style.display = "none";
}

/** Build the student card HTML */
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

// ─── 4. NFC core ────────────────────────────────────────

/**
 * Launch Web NFC scan.
 * @param {string} statusElId  - element id for status text
 * @param {string} btnLabelId  - element id for button label
 * @param {function} onUID     - callback(uid: string)
 * @returns {Promise}          - resolves once a tag is read
 */
async function scanNFC(statusElId, btnLabelId, onUID) {
  if (!("NDEFReader" in window)) {
    setNfcStatus(statusElId, "error",
      "⚠️ Web NFC אינו נתמך בדפדפן זה. השתמש ב-Chrome אנדרואיד.");
    return;
  }

  // Stop any previous scan
  if (nfcAbortController) {
    nfcAbortController.abort();
    nfcAbortController = null;
  }

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
      // Stop listening after first read
      nfcAbortController.abort();
      nfcAbortController = null;
      onUID(uid);
    });

    ndef.addEventListener("readingerror", () => {
      setNfcStatus(statusElId, "error", "❌ שגיאה בקריאת התג — נסה שוב");
    });

  } catch (err) {
    if (err.name === "AbortError") return; // user cancelled — silent
    console.error("NFC error:", err);
    const msg = err.name === "NotAllowedError"
      ? "⚠️ ההרשאה ל-NFC נדחתה. אנא אפשר גישה והפעל מחדש."
      : `❌ שגיאת NFC: ${err.message}`;
    setNfcStatus(statusElId, "error", msg);
  }
}

/** Stop any active NFC scan */
function stopNFC(btnLabelId, originalLabel) {
  if (nfcAbortController) {
    nfcAbortController.abort();
    nfcAbortController = null;
  }
  if (btnLabelId) document.getElementById(btnLabelId).textContent = originalLabel;
}

// ─── 5. Auth ────────────────────────────────────────────

document.getElementById("btn-login").addEventListener("click", async () => {
  const email    = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const errEl    = document.getElementById("auth-error");
  const btn      = document.getElementById("btn-login");
  const lbl      = document.getElementById("login-label");

  if (!email || !password) {
    errEl.textContent = "יש למלא אימייל וסיסמה.";
    errEl.style.display = "block";
    return;
  }

  lbl.innerHTML = '<div class="spinner"></div>';
  btn.disabled  = true;
  errEl.style.display = "none";

  try {
    await auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged handles the rest
  } catch (err) {
    const msgs = {
      "auth/user-not-found":  "משתמש לא נמצא.",
      "auth/wrong-password":  "סיסמה שגויה.",
      "auth/invalid-email":   "כתובת אימייל לא תקינה.",
      "auth/too-many-requests":"יותר מדי ניסיונות. נסה שוב מאוחר יותר."
    };
    errEl.textContent = msgs[err.code] || `שגיאה: ${err.message}`;
    errEl.style.display = "block";
  } finally {
    lbl.textContent = "כניסה";
    btn.disabled    = false;
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  stopNFC();
  await auth.signOut();
});

// Enter key on password field → login
document.getElementById("auth-password").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

// Auth state listener
auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) {
    document.getElementById("auth-screen").style.display  = "none";
    document.getElementById("app-screen").classList.add("visible");
    document.getElementById("user-email-display").textContent = user.email;
    loadRecentTransactions();
  } else {
    document.getElementById("auth-screen").style.display  = "flex";
    document.getElementById("app-screen").classList.remove("visible");
  }
});

// ─── 6. Tab navigation ──────────────────────────────────

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    stopNFC(); // cancel any running NFC
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "store") loadRecentTransactions();
  });
});

// ─── 7. Registration tab ────────────────────────────────

let pendingRegUID = null; // UID waiting to be confirmed during registration

document.getElementById("btn-scan-register").addEventListener("click", function() {
  if (nfcAbortController) {
    // Button acts as cancel when scanning
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
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const docRef = db.collection("students").doc(uid);
    const snap   = await docRef.get();

    if (snap.exists) {
      showToast("❌ תג זה כבר שויך לתלמיד: " + snap.data().name, "error", 4000);
      return;
    }

    await docRef.set({
      name,
      grade,
      balance: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.email
    });

    // Log transaction
    await logTransaction(uid, name, currentUser.email, 0, "רישום תלמיד חדש");

    // Show result card
    const preview = document.getElementById("reg-student-preview");
    preview.innerHTML = studentCardHTML(name, grade, 0);
    document.getElementById("reg-result-card").style.display = "block";

    // Reset form
    document.getElementById("reg-name").value  = "";
    document.getElementById("reg-grade").value = "";
    document.getElementById("reg-uid-manual").value = "";
    pendingRegUID = null;
    setNfcStatus("nfc-status-register", "success",
      `✅ ${name} נרשם בהצלחה! UID: ${uid}`);
    showToast(`✅ ${name} נרשם בהצלחה!`, "success");

  } catch (err) {
    console.error(err);
    showToast("❌ שגיאה ברישום: " + err.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "רשום תלמיד";
  }
});

// ─── 8. Teacher tab ─────────────────────────────────────

// Reason chips
document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    selectedReason = chip.dataset.reason;
    const customInput = document.getElementById("teacher-reason-custom");
    if (selectedReason === "אחר") {
      customInput.style.display = "block";
      customInput.focus();
    } else {
      customInput.style.display  = "none";
      customInput.value = "";
    }
  });
});

document.getElementById("btn-scan-teacher").addEventListener("click", function() {
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
  const section = document.getElementById("teacher-student-section");
  section.style.display = "none";
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
    section.style.display = "block";
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
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const ref  = db.collection("students").doc(activeTeacherUID);
    const snap = await ref.get();
    if (!snap.exists) throw new Error("תלמיד לא נמצא");

    const s = snap.data();
    const newBalance = s.balance + points;

    await ref.update({ balance: firebase.firestore.FieldValue.increment(points) });
    await logTransaction(activeTeacherUID, s.name, currentUser.email, points, reason);

    // Refresh card preview
    document.getElementById("teacher-student-preview").innerHTML =
      studentCardHTML(s.name, s.grade, newBalance);

    showToast(`✅ הוענקו ${points} נקודות ל-${s.name}!`, "success");
    document.getElementById("teacher-points").value = "";

  } catch (err) {
    console.error(err);
    showToast("❌ שגיאה בהענקת נקודות: " + err.message, "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "הענק נקודות ✨";
  }
});

// ─── 9. Store / cashier tab ─────────────────────────────

document.getElementById("btn-scan-store").addEventListener("click", function() {
  if (nfcAbortController) {
    stopNFC("scan-store-label", "הצמד כרטיס לתשלום");
    setNfcStatus("nfc-status-store", "", "");
    return;
  }
  const cost = parseInt(document.getElementById("store-cost").value);
  if (!cost || cost <= 0) {
    showToast("הזן עלות מוצר לפני הסריקה", "error");
    return;
  }
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
  const resultCard = document.getElementById("store-result-card");
  resultCard.style.display = "none";

  if (!cost || cost <= 0) return showToast("הזן עלות מוצר תקינה", "error");

  const btn = document.getElementById("btn-scan-store");
  btn.disabled = true;

  try {
    const studentRef = db.collection("students").doc(uid);

    // ── Firestore runTransaction: atomic balance check + deduct ──
    const result = await db.runTransaction(async txn => {
      const snap = await txn.get(studentRef);

      if (!snap.exists) throw new Error("תלמיד לא נמצא במערכת");

      const s = snap.data();
      if (s.balance < cost) {
        throw new Error(
          `יתרה לא מספיקה: ${s.balance} נקודות (נדרש: ${cost})`
        );
      }

      txn.update(studentRef, {
        balance: firebase.firestore.FieldValue.increment(-cost)
      });

      return { name: s.name, grade: s.grade, newBalance: s.balance - cost };
    });

    // Log after successful transaction
    await logTransaction(uid, result.name, currentUser.email, -cost,
                         `קניה בחנות: ${itemName}`);

    // Show result
    const preview = document.getElementById("store-student-preview");
    preview.innerHTML = studentCardHTML(result.name, result.grade, result.newBalance);
    resultCard.style.display = "block";

    setNfcStatus("nfc-status-store", "success",
      `✅ תשלום אושר! ${result.name} שילם ${cost} נקודות עבור "${itemName}"`);
    showToast(`✅ תשלום של ${cost} נקודות אושר!`, "success");

    // Clear fields after success
    document.getElementById("store-cost").value  = "";
    document.getElementById("store-item").value  = "";
    document.getElementById("store-uid-manual").value = "";
    loadRecentTransactions();

  } catch (err) {
    console.error(err);
    setNfcStatus("nfc-status-store", "error", "❌ " + err.message);
    showToast("❌ " + err.message, "error", 4500);
  } finally {
    btn.disabled = false;
    document.getElementById("scan-store-label").textContent = "הצמד כרטיס לתשלום";
  }
}

// ─── 10. Transactions helper & display ──────────────────

async function logTransaction(studentUID, studentName, teacherEmail, amount, description) {
  await db.collection("transactions").add({
    timestamp:   firebase.firestore.FieldValue.serverTimestamp(),
    student_uid: studentUID,
    student_name: studentName,
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
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();

    if (snap.empty) {
      list.innerHTML = '<li class="text-muted text-center">אין עסקאות עדיין</li>';
      return;
    }

    list.innerHTML = "";
    snap.forEach(doc => {
      const t   = doc.data();
      const li  = document.createElement("li");
      li.className = "tx-item";
      const positive = t.amount >= 0;
      li.innerHTML = `
        <div>
          <p class="tx-desc">${t.student_name || "—"} <span style="color:var(--c-muted);font-weight:400;font-size:12px">/ ${t.description}</span></p>
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

// ─── 11. PWA Service Worker registration ────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch(err => console.warn("SW registration failed:", err));
  });
}
