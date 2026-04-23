// ============================================================
// SOLA · Gestor de Mantenimiento - Versión reestructurada
// ============================================================

import { firebaseConfig, CONFIG_IS_VALID } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection,
  query, where, limit, onSnapshot, collectionGroup, getDocs, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// ============================================================
// STATE
// ============================================================
let app, auth, db;
let currentUser = null;
let currentAuthUser = null;

let state = {
  machines: [],
  holidays: {},
  workWeekdays: [1, 2, 3, 4, 5],
  users: [],
  settings: {
    globalResponsibleEmail: '',
    weeklyDay: 1,
    weeklyHour: 8
  },
  historyByMachine: {} // { machineId: [ {id, date, by, byName, note, registeredAt, editedBy, editedAt}, ... ] }
};

let unsubscribes = [];

// ============================================================
// INIT FIREBASE
// ============================================================
function initFirebase() {
  if (!CONFIG_IS_VALID) { showConfigMissing(); return false; }
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    return true;
  } catch (err) {
    console.error('Error init Firebase:', err);
    showConfigMissing();
    return false;
  }
}

function showConfigMissing() {
  document.getElementById('loginScreen').style.display = 'grid';
  document.getElementById('app').style.display = 'none';
  document.getElementById('configMissing').style.display = 'block';
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('setupForm').style.display = 'none';
  document.getElementById('loginLoading').style.display = 'none';
}

// ============================================================
// DATE HELPERS
// ============================================================
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function isWorkday(date) {
  const iso = toISO(date);
  if (state.holidays[iso] !== undefined) return false;
  return state.workWeekdays.includes(date.getDay());
}
function addWorkdays(startDate, n) {
  const d = new Date(startDate);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (isWorkday(d)) added++;
  }
  return d;
}
function workdaysBetween(start, end) {
  if (toISO(start) === toISO(end)) return 0;
  const forward = end > start;
  const from = forward ? start : end;
  const to = forward ? end : start;
  const d = new Date(from);
  let count = 0;
  while (toISO(d) !== toISO(to)) {
    d.setDate(d.getDate() + 1);
    if (isWorkday(d)) count++;
  }
  return forward ? count : -count;
}
function formatDateES(d) {
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatDateLong(d) {
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: '2-digit', month: 'long' });
}

// ============================================================
// PERMISSIONS
// Todos pueden registrar mantenimientos y editar comentarios.
// Admin/Editor gestionan máquinas y calendario. Admin gestiona usuarios.
// ============================================================
const ROLE_LABELS = { admin: 'Administrador', editor: 'Edición', viewer: 'Consulta' };
const PERMS = {
  admin: ['view', 'register', 'editComment', 'deleteRecord', 'manageMachines', 'manageCalendar', 'manageUsers', 'manageData'],
  editor: ['view', 'register', 'editComment', 'manageMachines', 'manageCalendar'],
  viewer: ['view', 'register', 'editComment']
};
function can(p) {
  if (!currentUser) return false;
  return PERMS[currentUser.role]?.includes(p) || false;
}
function requirePerm(p) {
  if (!can(p)) { toast('No tienes permiso para esta acción', 'error'); return false; }
  return true;
}

// ============================================================
// AUTH
// ============================================================
function showLogin() {
  document.getElementById('loginScreen').style.display = 'grid';
  document.getElementById('app').style.display = 'none';
  document.getElementById('configMissing').style.display = 'none';
  document.getElementById('loginLoading').style.display = 'none';
  document.getElementById('setupForm').style.display = 'none';
  document.getElementById('loginForm').style.display = 'block';
  hideSyncIndicator();
  // Comprobar si ya existe algún admin para ocultar el enlace "Primera vez"
  checkFirstSetupNeeded();
  setTimeout(() => document.getElementById('loginUser').focus(), 100);
}

async function checkFirstSetupNeeded() {
  // Si el documento settings/global ya existe, significa que ya se hizo
  // el primer setup y NO debemos mostrar el enlace "Primera vez".
  // Las reglas permiten lectura pública de este documento.
  const hint = document.getElementById('firstSetupHint');
  if (!hint) return;
  try {
    const snap = await getDoc(doc(db, 'settings', 'global'));
    if (snap.exists()) {
      hint.style.display = 'none';
      return;
    }
  } catch (err) {
    // Si las reglas bloquean la lectura, asumimos que hace falta setup
    // (fail-safe: en el peor caso se ve el enlace pero el servidor lo bloqueará)
    console.log('checkFirstSetup: no se pudo verificar, mostrando enlace por defecto');
  }
  hint.style.display = '';
}

async function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  applyUserUI();
  await startListeners();
  showSyncIndicator();
}

function applyUserUI() {
  if (!currentUser) return;
  document.getElementById('userName').textContent = currentUser.name || currentUser.email;
  document.getElementById('userRole').textContent = ROLE_LABELS[currentUser.role];
  document.getElementById('userAvatar').textContent = (currentUser.name || currentUser.email).charAt(0).toUpperCase();

  document.querySelectorAll('[data-permission]').forEach(el => {
    const req = el.dataset.permission;
    const allowed = (req === 'admin' && currentUser.role === 'admin')
                 || (req === 'edit' && can('manageMachines'));
    el.style.display = allowed ? '' : 'none';
  });

  // Ocultar form de añadir máquina a viewers
  const machineForm = document.getElementById('machineFormCard');
  if (machineForm) machineForm.style.display = can('manageMachines') ? '' : 'none';

  const activeBtn = document.querySelector('.tab-btn.active');
  if (activeBtn && activeBtn.style.display === 'none') switchTab('dashboard');
}

function setupAuthListener() {
  onAuthStateChanged(auth, async (user) => {
    document.getElementById('loginLoading').style.display = 'none';
    if (user) {
      currentAuthUser = user;
      try {
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if (!userDoc.exists()) {
          await signOut(auth);
          toast('Tu cuenta no tiene perfil. Contacta con el administrador.', 'error');
          return;
        }
        const data = userDoc.data();
        currentUser = {
          uid: user.uid, email: user.email,
          name: data.name, role: data.role,
          createdAt: data.createdAt
        };
        await showApp();
      } catch (err) {
        console.error(err);
        toast('Error al cargar tu perfil: ' + err.message, 'error');
        await signOut(auth);
      }
    } else {
      currentUser = null; currentAuthUser = null;
      stopListeners();
      showLogin();
    }
  });
}

document.getElementById('loginFormEl').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.classList.remove('show');
  try {
    await signInWithEmailAndPassword(
      auth,
      document.getElementById('loginUser').value.trim(),
      document.getElementById('loginPass').value
    );
    document.getElementById('loginFormEl').reset();
  } catch (err) {
    errEl.textContent = mapAuthError(err);
    errEl.classList.add('show');
  }
});

document.getElementById('showSetupLink').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('setupForm').style.display = 'block';
});
document.getElementById('backToLoginBtn').addEventListener('click', () => {
  document.getElementById('setupForm').style.display = 'none';
  document.getElementById('loginForm').style.display = 'block';
});

document.getElementById('setupFormEl').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('setupError');
  errEl.classList.remove('show');
  const name = document.getElementById('setupName').value.trim();
  const email = document.getElementById('setupUser').value.trim();
  const pass = document.getElementById('setupPass').value;
  const pass2 = document.getElementById('setupPass2').value;
  if (pass !== pass2) {
    errEl.textContent = 'Las contraseñas no coinciden.';
    errEl.classList.add('show');
    return;
  }
  // Verificar que no exista ya un admin (comprobando si settings/global existe)
  try {
    const settingsSnap = await getDoc(doc(db, 'settings', 'global'));
    if (settingsSnap.exists()) {
      errEl.textContent = 'Ya existe una cuenta de administrador. Pide al admin que cree tu cuenta.';
      errEl.classList.add('show');
      return;
    }
  } catch {
    // Si falla (reglas restrictivas), las reglas del servidor bloquearán igualmente
  }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    try {
      await setDoc(doc(db, 'users', cred.user.uid), {
        name, email, role: 'admin', createdAt: toISO(new Date())
      });
    } catch (rulesErr) {
      // Si las reglas bloquean: borrar la cuenta Auth y avisar
      try { await cred.user.delete(); } catch {}
      errEl.textContent = 'No se pudo crear el admin. Puede que ya exista uno. Contacta con el admin actual.';
      errEl.classList.add('show');
      return;
    }
    await setDoc(doc(db, 'settings', 'global'), {
      workWeekdays: [1,2,3,4,5],
      globalResponsibleEmail: '',
      weeklyDay: 1, weeklyHour: 8
    });
    toast('Cuenta de administrador creada.', 'success');
  } catch (err) {
    errEl.textContent = mapAuthError(err);
    errEl.classList.add('show');
  }
});

document.getElementById('forgotPassLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = prompt('Introduce tu email para recibir el enlace de recuperación:');
  if (!email) return;
  try {
    await sendPasswordResetEmail(auth, email.trim());
    toast('Revisa tu email para el enlace', 'success');
  } catch (err) {
    toast(mapAuthError(err), 'error');
  }
});

function mapAuthError(err) {
  const map = {
    'auth/invalid-email': 'Email no válido',
    'auth/user-not-found': 'Usuario o contraseña incorrectos',
    'auth/wrong-password': 'Usuario o contraseña incorrectos',
    'auth/invalid-credential': 'Usuario o contraseña incorrectos',
    'auth/invalid-login-credentials': 'Usuario o contraseña incorrectos',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
    'auth/email-already-in-use': 'Ese email ya está registrado',
    'auth/weak-password': 'Contraseña demasiado débil (mín. 6)',
    'auth/network-request-failed': 'Error de red'
  };
  return map[err.code] || err.message || 'Error desconocido';
}

document.getElementById('userChip').addEventListener('click', () => {
  document.getElementById('accountModal').classList.add('show');
});
document.getElementById('closeAccountModal').addEventListener('click', () => {
  document.getElementById('accountModal').classList.remove('show');
  document.getElementById('changePassForm').reset();
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
  document.getElementById('accountModal').classList.remove('show');
  await signOut(auth);
  toast('Sesión cerrada');
});
document.getElementById('changePassForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = document.getElementById('currentPass').value;
  const nw = document.getElementById('newPass').value;
  const nw2 = document.getElementById('newPass2').value;
  if (nw !== nw2) { toast('Las contraseñas no coinciden', 'error'); return; }
  try {
    const credential = EmailAuthProvider.credential(currentAuthUser.email, cur);
    await reauthenticateWithCredential(currentAuthUser, credential);
    await updatePassword(currentAuthUser, nw);
    document.getElementById('accountModal').classList.remove('show');
    document.getElementById('changePassForm').reset();
    toast('Contraseña actualizada', 'success');
  } catch (err) {
    toast(mapAuthError(err), 'error');
  }
});

// ============================================================
// LISTENERS
// ============================================================
function stopListeners() {
  unsubscribes.forEach(u => { try { u(); } catch {} });
  unsubscribes = [];
}

async function startListeners() {
  stopListeners();

  unsubscribes.push(onSnapshot(collection(db, 'machines'), (snap) => {
    state.machines = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderDashboard();
    renderMachines();
    renderHistoryFilters();
    renderHistory();
    flashSync();
  }, (err) => { console.error('Err machines:', err); setSyncError('Error'); }));

  unsubscribes.push(onSnapshot(collection(db, 'holidays'), (snap) => {
    state.holidays = {};
    snap.docs.forEach(d => { state.holidays[d.id] = d.data().description || ''; });
    renderHolidays();
    renderCalendar();
    renderDashboard();
    renderMachines();
    flashSync();
  }, (err) => console.error('Err holidays:', err)));

  unsubscribes.push(onSnapshot(doc(db, 'settings', 'global'), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      state.workWeekdays = d.workWeekdays || [1,2,3,4,5];
      state.settings.globalResponsibleEmail = d.globalResponsibleEmail || '';
      state.settings.weeklyDay = d.weeklyDay ?? 1;
      state.settings.weeklyHour = d.weeklyHour ?? 8;
    }
    renderWeekdaysChecks();
    renderCalendar();
    renderDashboard();
    renderMachines();
    renderEmailSettings();
    flashSync();
  }, (err) => console.error('Err settings:', err)));

  if (currentUser.role === 'admin') {
    unsubscribes.push(onSnapshot(collection(db, 'users'), (snap) => {
      state.users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      renderUsers();
      renderHistoryFilters();
      flashSync();
    }, (err) => console.error('Err users:', err)));
  } else {
    // Para que viewer/editor puedan ver nombres en el historial
    try {
      const snap = await getDocs(collection(db, 'users'));
      state.users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      renderHistoryFilters();
    } catch {}
  }

  // Historial (subcoleccion machines/{id}/history) con collectionGroup
  unsubscribes.push(onSnapshot(collectionGroup(db, 'history'), (snap) => {
    state.historyByMachine = {};
    snap.docs.forEach(d => {
      const data = d.data();
      // ref.path es "machines/{mid}/history/{hid}"
      const parts = d.ref.path.split('/');
      const mid = parts[1];
      if (!state.historyByMachine[mid]) state.historyByMachine[mid] = [];
      state.historyByMachine[mid].push({ id: d.id, ...data });
    });
    Object.keys(state.historyByMachine).forEach(mid => {
      state.historyByMachine[mid].sort((a,b) => (b.date || '').localeCompare(a.date || ''));
    });
    renderHistory();
    flashSync();
  }, (err) => console.error('Err history:', err)));
}

function showSyncIndicator() {
  document.getElementById('syncIndicator').style.display = 'flex';
  setSyncOk('Conectado');
}
function hideSyncIndicator() { document.getElementById('syncIndicator').style.display = 'none'; }
let flashTimer = null;
function flashSync() {
  setSyncOk('Sincronizado');
  clearTimeout(flashTimer);
  const dot = document.getElementById('syncDot');
  dot.style.background = 'var(--sola-beige-dark)';
  flashTimer = setTimeout(() => { dot.style.background = 'var(--success)'; }, 500);
}
function setSyncOk(t) {
  document.getElementById('syncDot').style.background = 'var(--success)';
  document.getElementById('syncText').textContent = t;
}
function setSyncError(t) {
  document.getElementById('syncDot').style.background = 'var(--danger)';
  document.getElementById('syncText').textContent = t;
}
window.addEventListener('online', () => setSyncOk('Conectado'));
window.addEventListener('offline', () => setSyncError('Sin conexión'));

// ============================================================
// TABS
// ============================================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const panel = document.getElementById('panel-' + tabName);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');
  if (tabName === 'calendar') renderCalendar();
  if (tabName === 'dashboard') renderDashboard();
  if (tabName === 'machines') renderMachines();
  if (tabName === 'users') renderUsers();
  if (tabName === 'history') renderHistory();
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ============================================================
// TOAST
// ============================================================
let toastTimer = null;
function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================================
// MACHINE STATUS
// ============================================================
function getMachineStatus(m) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const last = m.lastMaintenance ? fromISO(m.lastMaintenance) : today;
  const next = addWorkdays(last, m.interval);
  const daysDiff = workdaysBetween(today, next);
  let status = 'ok';
  if (daysDiff < 0) status = 'overdue';
  else if (daysDiff <= 3) status = 'due';
  return { nextDate: next, daysRemaining: daysDiff, status };
}

// ============================================================
// DASHBOARD (registrar + avisos)
// ============================================================
function renderDashboard() {
  const machines = state.machines;
  const statuses = machines.map(m => ({ m, ...getMachineStatus(m) }));
  const total = machines.length;
  const overdue = statuses.filter(s => s.status === 'overdue').length;
  const due = statuses.filter(s => s.status === 'due').length;
  const ok = statuses.filter(s => s.status === 'ok').length;

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat accent"><div class="stat-label">Total</div><div class="stat-value">${total}</div></div>
    <div class="stat success"><div class="stat-label">Al día</div><div class="stat-value">${ok}</div></div>
    <div class="stat warn"><div class="stat-label">Próximos</div><div class="stat-value">${due}</div></div>
    <div class="stat danger"><div class="stat-label">Vencidos</div><div class="stat-value">${overdue}</div></div>
  `;

  // Urgent: overdue + due. Ordenados por urgencia (más vencidas arriba)
  const urgent = statuses.filter(s => s.status !== 'ok').sort((a,b) => a.daysRemaining - b.daysRemaining);
  const urgentGrid = document.getElementById('urgentGrid');
  const urgentSection = document.getElementById('urgentSection');
  document.getElementById('urgentCount').textContent = urgent.length;

  if (urgent.length === 0) {
    urgentSection.style.display = total > 0 ? '' : 'none';
    urgentGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">✓ Todo al día — no hay mantenimientos urgentes</div>';
  } else {
    urgentSection.style.display = '';
    urgentGrid.innerHTML = urgent.map(s => {
      const cls = s.status;
      const urg = s.status === 'overdue'
        ? `Vencido hace ${Math.abs(s.daysRemaining)} día${Math.abs(s.daysRemaining)!==1?'s':''}`
        : s.daysRemaining === 0 ? 'Hoy'
        : `En ${s.daysRemaining} día${s.daysRemaining!==1?'s':''}`;
      return `
        <div class="urgent-card ${cls}" data-action="quick" data-id="${s.m.id}">
          <div class="urgent-urgency ${cls}">${urg}</div>
          <div class="urgent-name">${escapeHtml(s.m.name)}</div>
          ${s.m.code ? `<div class="urgent-code">${escapeHtml(s.m.code)}</div>` : ''}
          <div class="urgent-meta">
            ${s.m.location ? `<div class="urgent-meta-item">📍 ${escapeHtml(s.m.location)}</div>` : ''}
            ${s.m.task ? `<div class="urgent-meta-item">🔧 ${escapeHtml(s.m.task)}</div>` : ''}
            <div class="urgent-meta-item">📅 ${formatDateES(s.nextDate)}</div>
          </div>
          <div class="urgent-cta">→ Registrar mantenimiento</div>
        </div>
      `;
    }).join('');
    urgentGrid.querySelectorAll('[data-action=quick]').forEach(el => {
      el.addEventListener('click', () => openQuickMaintain(el.dataset.id));
    });
  }

  // All machines (pequeñas)
  const allGrid = document.getElementById('allMachinesMiniGrid');
  document.getElementById('allCount').textContent = total;
  if (total === 0) {
    allGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">// Sin máquinas registradas</div>';
    return;
  }
  // Orden: primero urgentes, luego por días restantes
  const sorted = statuses.slice().sort((a,b) => a.daysRemaining - b.daysRemaining);
  allGrid.innerHTML = sorted.map(s => {
    const cls = s.status;
    const label = s.status === 'overdue'
      ? `Vencido ${Math.abs(s.daysRemaining)}d`
      : s.status === 'due' ? (s.daysRemaining === 0 ? 'Hoy' : `${s.daysRemaining}d`)
      : `${s.daysRemaining}d`;
    return `
      <div class="machine-mini ${cls}" data-action="quick" data-id="${s.m.id}">
        <div class="machine-mini-name">${escapeHtml(s.m.name)}</div>
        <div class="machine-mini-meta">${label} · ${formatDateES(s.nextDate).split(' ').slice(0,2).join(' ')}</div>
      </div>
    `;
  }).join('');
  allGrid.querySelectorAll('[data-action=quick]').forEach(el => {
    el.addEventListener('click', () => openQuickMaintain(el.dataset.id));
  });
}

// ============================================================
// QUICK MAINTAIN MODAL
// ============================================================
let qmCurrentMachineId = null;
const qmModal = document.getElementById('quickMaintainModal');

function openQuickMaintain(machineId) {
  if (!requirePerm('register')) return;
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  qmCurrentMachineId = machineId;
  document.getElementById('qmMachineName').textContent = m.name;
  document.getElementById('qmMachineCode').textContent = m.code ? `Código: ${m.code}` : '';
  const todayISO = toISO(new Date());
  document.getElementById('qmDate').value = todayISO;
  document.getElementById('qmDate').max = todayISO;
  document.getElementById('qmTodayLabel').textContent = 'Fecha: ' + formatDateLong(new Date()).toUpperCase();
  document.getElementById('qmDateField').classList.remove('show');
  document.getElementById('qmNote').value = '';
  qmModal.classList.add('show');
}

document.getElementById('qmCancelBtn').addEventListener('click', () => {
  qmModal.classList.remove('show');
  qmCurrentMachineId = null;
});
qmModal.addEventListener('click', (e) => {
  if (e.target === qmModal) {
    qmModal.classList.remove('show');
    qmCurrentMachineId = null;
  }
});
document.getElementById('qmChangeDateBtn').addEventListener('click', () => {
  const f = document.getElementById('qmDateField');
  const btn = document.getElementById('qmChangeDateBtn');
  const label = document.getElementById('qmTodayLabel');
  f.classList.toggle('show');
  if (f.classList.contains('show')) {
    btn.textContent = 'Usar hoy';
    label.style.display = 'none';
  } else {
    btn.textContent = 'Cambiar fecha';
    label.style.display = '';
    document.getElementById('qmDate').value = toISO(new Date());
  }
});

document.getElementById('quickMaintainForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!qmCurrentMachineId) return;
  if (!requirePerm('register')) return;
  const dateISO = document.getElementById('qmDate').value;
  const note = document.getElementById('qmNote').value.trim();
  if (!dateISO) { toast('Fecha inválida', 'error'); return; }

  try {
    const m = state.machines.find(x => x.id === qmCurrentMachineId);
    await updateDoc(doc(db, 'machines', qmCurrentMachineId), {
      lastMaintenance: dateISO,
      lastMaintenanceBy: currentUser.uid,
      lastMaintenanceByName: currentUser.name || currentUser.email,
      lastMaintenanceNote: note
    });
    const histId = Date.now().toString() + '_' + Math.random().toString(36).slice(2,5);
    await setDoc(doc(db, 'machines', qmCurrentMachineId, 'history', histId), {
      date: dateISO,
      by: currentUser.uid,
      byName: currentUser.name || currentUser.email,
      note,
      registeredAt: new Date().toISOString()
    });

    qmModal.classList.remove('show');
    qmCurrentMachineId = null;

    // Pantalla de confirmación grande
    const next = addWorkdays(fromISO(dateISO), m.interval);
    document.getElementById('confirmSubtitle').textContent =
      `${m.name} · Siguiente mantenimiento: ${formatDateLong(next)}`;
    const confirm = document.getElementById('confirmFullscreen');
    confirm.classList.add('show');
    setTimeout(() => confirm.classList.remove('show'), 2500);
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
});

// ============================================================
// MACHINES CRUD
// ============================================================
let editingMachineId = null;
const machineForm = document.getElementById('machineForm');
const cancelEditBtn = document.getElementById('cancelEditBtn');

machineForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requirePerm('manageMachines')) return;

  const resp = document.getElementById('m_responsible').value.trim();
  if (resp && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resp)) {
    toast('Email del responsable no es válido', 'error'); return;
  }

  const data = {
    name: document.getElementById('m_name').value.trim(),
    code: document.getElementById('m_code').value.trim(),
    location: document.getElementById('m_location').value.trim(),
    interval: parseInt(document.getElementById('m_interval').value, 10),
    lastMaintenance: document.getElementById('m_last').value || toISO(new Date()),
    task: document.getElementById('m_task').value.trim(),
    notes: document.getElementById('m_notes').value.trim(),
    responsibleEmail: resp
  };
  if (!data.name || !data.interval || data.interval < 1) {
    toast('Nombre e intervalo obligatorios', 'error'); return;
  }
  try {
    if (editingMachineId) {
      await updateDoc(doc(db, 'machines', editingMachineId), data);
      toast('Máquina actualizada', 'success');
      editingMachineId = null;
      cancelEditBtn.style.display = 'none';
      machineForm.querySelector('button[type=submit]').textContent = '+ Añadir máquina';
    } else {
      data.createdAt = toISO(new Date());
      data.createdBy = currentUser.uid;
      const newId = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      await setDoc(doc(db, 'machines', newId), data);
      toast('Máquina añadida', 'success');
    }
    machineForm.reset();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

cancelEditBtn.addEventListener('click', () => {
  editingMachineId = null;
  cancelEditBtn.style.display = 'none';
  machineForm.reset();
  machineForm.querySelector('button[type=submit]').textContent = '+ Añadir máquina';
});

function renderMachines() {
  const grid = document.getElementById('machinesGrid');
  if (!grid) return;
  document.getElementById('machineCount').textContent =
    state.machines.length + ' EQUIPO' + (state.machines.length !== 1 ? 'S' : '');
  if (state.machines.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">// Sin máquinas registradas</div>';
    return;
  }
  const canManage = can('manageMachines');
  grid.innerHTML = state.machines.map(m => {
    const st = getMachineStatus(m);
    const statusClass = 'status-' + st.status;
    const badge = st.status === 'overdue' ? 'Vencido' : st.status === 'due' ? 'Próximo' : 'Al día';
    const daysLabel = st.status === 'overdue'
      ? `Hace ${Math.abs(st.daysRemaining)} día${Math.abs(st.daysRemaining)!==1?'s':''} lab.`
      : st.daysRemaining === 0 ? 'Hoy' : `En ${st.daysRemaining} día${st.daysRemaining!==1?'s':''} lab.`;
    const daysClass = st.status === 'overdue' ? 'danger' : st.status === 'due' ? 'warn' : 'success';

    return `
      <div class="machine-card ${statusClass}">
        <div class="machine-id">${escapeHtml(m.code || m.id.slice(-6).toUpperCase())}</div>
        <div class="machine-name">${escapeHtml(m.name)}</div>
        <span class="status-badge ${st.status}">${badge}</span>
        ${m.location ? `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-dim);margin-top:10px;">📍 ${escapeHtml(m.location)}</div>` : ''}
        ${m.task ? `<div style="font-size:13px;color:var(--text);margin-top:6px;">🔧 ${escapeHtml(m.task)}</div>` : ''}
        ${m.responsibleEmail ? `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-dim);margin-top:6px;">✉ ${escapeHtml(m.responsibleEmail)}</div>` : ''}
        <div class="machine-meta">
          <div class="meta-item"><span class="meta-label">Intervalo</span><span class="meta-value accent">${m.interval} días lab.</span></div>
          <div class="meta-item"><span class="meta-label">Último</span><span class="meta-value">${formatDateES(fromISO(m.lastMaintenance))}</span></div>
          <div class="meta-item"><span class="meta-label">Próximo</span><span class="meta-value">${formatDateES(st.nextDate)}</span></div>
          <div class="meta-item"><span class="meta-label">Estado</span><span class="meta-value ${daysClass}">${daysLabel}</span></div>
        </div>
        ${m.notes ? `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-dim);padding:10px;background:var(--bg-soft);border-left:2px solid var(--border);margin-top:10px;border-radius:2px;">${escapeHtml(m.notes)}</div>` : ''}
        <div class="machine-actions">
          <button class="btn btn-primary btn-sm" data-action="maintain" data-id="${m.id}">✓ Registrar</button>
          <button class="btn btn-ghost btn-sm" data-action="viewHistory" data-id="${m.id}">📜 Historial</button>
          ${canManage ? `<button class="btn btn-ghost btn-sm" data-action="edit" data-id="${m.id}">Editar</button>` : ''}
          ${canManage ? `<button class="btn btn-danger btn-sm" data-action="delete" data-id="${m.id}">Eliminar</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const a = btn.dataset.action;
      if (a === 'maintain') openQuickMaintain(id);
      else if (a === 'edit') editMachine(id);
      else if (a === 'delete') deleteMachine(id);
      else if (a === 'viewHistory') openHistoryModal(id);
    });
  });
}

function editMachine(id) {
  if (!requirePerm('manageMachines')) return;
  const m = state.machines.find(x => x.id === id);
  if (!m) return;
  editingMachineId = id;
  document.getElementById('m_name').value = m.name || '';
  document.getElementById('m_code').value = m.code || '';
  document.getElementById('m_location').value = m.location || '';
  document.getElementById('m_interval').value = m.interval || '';
  document.getElementById('m_last').value = m.lastMaintenance || '';
  document.getElementById('m_task').value = m.task || '';
  document.getElementById('m_notes').value = m.notes || '';
  document.getElementById('m_responsible').value = m.responsibleEmail || '';
  cancelEditBtn.style.display = 'inline-flex';
  machineForm.querySelector('button[type=submit]').textContent = '💾 Guardar cambios';
  document.getElementById('m_name').focus();
  document.getElementById('m_name').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteMachine(id) {
  if (!requirePerm('manageMachines')) return;
  const m = state.machines.find(x => x.id === id);
  if (!m) return;
  if (!confirm(`¿Eliminar "${m.name}"?\n\nSe borrará también su historial. Esta acción no se puede deshacer.`)) return;
  try {
    // Borrar historial primero (subcollection)
    const hist = state.historyByMachine[id] || [];
    const batch = writeBatch(db);
    hist.forEach(h => batch.delete(doc(db, 'machines', id, 'history', h.id)));
    batch.delete(doc(db, 'machines', id));
    await batch.commit();
    toast('Máquina eliminada');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ============================================================
// CALENDAR
// ============================================================
let calCursor = new Date();
calCursor.setDate(1);
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DOW_ES = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

document.getElementById('prevMonth').addEventListener('click', () => {
  calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar();
});
document.getElementById('nextMonth').addEventListener('click', () => {
  calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar();
});
document.getElementById('todayBtn').addEventListener('click', () => {
  calCursor = new Date(); calCursor.setDate(1); renderCalendar();
});

function renderCalendar() {
  const label = document.getElementById('monthLabel');
  if (!label) return;
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  label.textContent = `${MONTHS_ES[month]} ${year}`;
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  const grid = document.getElementById('calendarGrid');
  let html = DOW_ES.map(d => `<div class="cal-dayname">${d}</div>`).join('');
  for (let i = 0; i < startOffset; i++) html += '<div class="cal-cell empty"></div>';

  const today = new Date(); today.setHours(0,0,0,0);
  const readonly = !can('manageCalendar');

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const date = new Date(year, month, d);
    const iso = toISO(date);
    const dow = date.getDay();
    const isHol = state.holidays[iso] !== undefined;
    const isWe = !state.workWeekdays.includes(dow);
    const isToday = toISO(today) === iso;
    let cls = 'cal-cell';
    let status = '';
    if (isHol) { cls += ' holiday'; status = 'Festivo'; }
    else if (isWe) { cls += ' weekend'; status = 'No lab.'; }
    else { cls += ' workday'; status = 'Lab.'; }
    if (isToday) cls += ' today';
    if (readonly) cls += ' readonly';
    html += `<div class="${cls}" data-date="${iso}" title="${escapeHtml(isHol ? (state.holidays[iso] || 'Festivo') : '')}">
      <div class="day-num">${d}</div>
      <div class="day-status">${status}</div>
    </div>`;
  }
  grid.innerHTML = html;
  if (!readonly) {
    grid.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
      cell.addEventListener('click', () => toggleHoliday(cell.dataset.date));
    });
  }
}

async function toggleHoliday(iso) {
  if (!requirePerm('manageCalendar')) return;
  try {
    if (state.holidays[iso] !== undefined) {
      await deleteDoc(doc(db, 'holidays', iso));
      toast('Festivo eliminado');
    } else {
      const desc = prompt('Descripción (opcional):', '') || '';
      await setDoc(doc(db, 'holidays', iso), { description: desc });
      toast('Festivo añadido', 'success');
    }
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ============================================================
// SETTINGS
// ============================================================
function renderWeekdaysChecks() {
  const names = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const order = [1,2,3,4,5,6,0];
  const container = document.getElementById('weekdaysChecks');
  if (!container) return;
  const disabled = !can('manageCalendar');
  container.innerHTML = order.map(dow => {
    const checked = state.workWeekdays.includes(dow);
    return `<label class="check-pill ${checked ? 'checked' : ''}" style="${disabled ? 'opacity:0.6;cursor:not-allowed;' : ''}">
      <input type="checkbox" data-dow="${dow}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      ${names[dow]}
    </label>`;
  }).join('');
  if (disabled) return;
  container.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const dow = parseInt(cb.dataset.dow, 10);
      let newDays = [...state.workWeekdays];
      if (cb.checked) { if (!newDays.includes(dow)) newDays.push(dow); }
      else { newDays = newDays.filter(x => x !== dow); }
      try {
        await setDoc(doc(db, 'settings', 'global'), { workWeekdays: newDays }, { merge: true });
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    });
  });
}

function renderHolidays() {
  const list = document.getElementById('holidaysList');
  if (!list) return;
  const entries = Object.entries(state.holidays).sort((a,b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">// Sin festivos configurados</div>';
    return;
  }
  const canDel = can('manageCalendar');
  list.innerHTML = entries.map(([iso, desc]) => `
    <div class="holiday-item">
      <div><span class="holiday-date">${iso}</span> ${desc ? '· ' + escapeHtml(desc) : ''}</div>
      ${canDel ? `<button class="btn btn-danger btn-sm" data-iso="${iso}" data-action="rmholiday">Quitar</button>` : ''}
    </div>
  `).join('');
  list.querySelectorAll('button[data-action=rmholiday]').forEach(btn => {
    btn.addEventListener('click', () => removeHoliday(btn.dataset.iso));
  });
}

async function removeHoliday(iso) {
  if (!requirePerm('manageCalendar')) return;
  try { await deleteDoc(doc(db, 'holidays', iso)); toast('Festivo eliminado'); }
  catch (err) { toast('Error: ' + err.message, 'error'); }
}

document.getElementById('addHolidayBtn').addEventListener('click', async () => {
  if (!requirePerm('manageCalendar')) return;
  const iso = document.getElementById('newHoliday').value;
  const desc = document.getElementById('newHolidayDesc').value.trim();
  if (!iso) { toast('Selecciona fecha', 'error'); return; }
  try {
    await setDoc(doc(db, 'holidays', iso), { description: desc });
    document.getElementById('newHoliday').value = '';
    document.getElementById('newHolidayDesc').value = '';
    toast('Festivo añadido', 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

document.getElementById('addRangeBtn').addEventListener('click', async () => {
  if (!requirePerm('manageCalendar')) return;
  const start = document.getElementById('rangeStart').value;
  const end = document.getElementById('rangeEnd').value;
  const desc = document.getElementById('rangeDesc').value.trim();
  if (!start || !end) { toast('Selecciona inicio y fin', 'error'); return; }
  if (start > end) { toast('Inicio debe ser anterior a fin', 'error'); return; }
  const dates = [];
  const d = fromISO(start); const e = fromISO(end);
  while (d <= e) { dates.push(toISO(d)); d.setDate(d.getDate() + 1); }
  if (dates.length > 60 && !confirm(`Vas a añadir ${dates.length} festivos. ¿Continuar?`)) return;
  try {
    const batch = writeBatch(db);
    dates.forEach(iso => {
      batch.set(doc(db, 'holidays', iso), { description: desc || 'Rango' });
    });
    await batch.commit();
    document.getElementById('rangeStart').value = '';
    document.getElementById('rangeEnd').value = '';
    document.getElementById('rangeDesc').value = '';
    toast(`${dates.length} festivos añadidos`, 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

// Email settings
function renderEmailSettings() {
  const input = document.getElementById('globalResponsible');
  const day = document.getElementById('weeklyDay');
  const hour = document.getElementById('weeklyHour');
  if (!input) return;
  const canEdit = currentUser && currentUser.role === 'admin';
  input.value = state.settings.globalResponsibleEmail || '';
  day.value = String(state.settings.weeklyDay ?? 1);
  hour.value = String(state.settings.weeklyHour ?? 8);
  input.disabled = !canEdit;
  day.disabled = !canEdit;
  hour.disabled = !canEdit;
  document.getElementById('saveEmailSettingsBtn').style.display = canEdit ? '' : 'none';
}

document.getElementById('saveEmailSettingsBtn').addEventListener('click', async () => {
  if (currentUser.role !== 'admin') { toast('Solo admins', 'error'); return; }
  const email = document.getElementById('globalResponsible').value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('Email no válido', 'error'); return;
  }
  const day = parseInt(document.getElementById('weeklyDay').value, 10);
  const hour = parseInt(document.getElementById('weeklyHour').value, 10);
  try {
    await setDoc(doc(db, 'settings', 'global'), {
      globalResponsibleEmail: email,
      weeklyDay: day,
      weeklyHour: hour
    }, { merge: true });
    toast('Ajustes guardados', 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

// Export / Reset
document.getElementById('exportBtn').addEventListener('click', () => {
  if (currentUser.role !== 'admin') { toast('Solo admins', 'error'); return; }
  const exportData = {
    exportedAt: new Date().toISOString(),
    machines: state.machines,
    holidays: state.holidays,
    workWeekdays: state.workWeekdays,
    settings: state.settings,
    history: state.historyByMachine,
    users: state.users.map(u => ({ ...u }))
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sola-mantenimiento-${toISO(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Datos exportados', 'success');
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (currentUser.role !== 'admin') { toast('Solo admins', 'error'); return; }
  if (!confirm('⚠ ¿Borrar TODAS las máquinas (con su historial), festivos y ajustes?\n\nLos USUARIOS no se borran desde aquí.\n\nNo se puede deshacer.')) return;
  if (!confirm('Última confirmación. ¿Continuar?')) return;
  try {
    const batch = writeBatch(db);
    // Borrar máquinas + historial
    for (const m of state.machines) {
      const hist = state.historyByMachine[m.id] || [];
      hist.forEach(h => batch.delete(doc(db, 'machines', m.id, 'history', h.id)));
      batch.delete(doc(db, 'machines', m.id));
    }
    Object.keys(state.holidays).forEach(iso => batch.delete(doc(db, 'holidays', iso)));
    batch.set(doc(db, 'settings', 'global'), {
      workWeekdays: [1,2,3,4,5],
      globalResponsibleEmail: '',
      weeklyDay: 1, weeklyHour: 8
    });
    await batch.commit();
    toast('Datos borrados', 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

// Holiday mode tabs
document.querySelectorAll('.holiday-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.holiday-mode-btn').forEach(b => {
      b.classList.remove('active');
      b.style.background = 'transparent';
      b.style.color = 'var(--text-dim)';
    });
    btn.classList.add('active');
    btn.style.background = 'var(--sola-dark)';
    btn.style.color = 'var(--bg)';
    const mode = btn.dataset.mode;
    document.getElementById('holidaySingleMode').style.display = mode === 'single' ? '' : 'none';
    document.getElementById('holidayRangeMode').style.display = mode === 'range' ? '' : 'none';
  });
});

// ============================================================
// USERS
// ============================================================
document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (currentUser.role !== 'admin') { toast('Solo admins', 'error'); return; }
  const name = document.getElementById('u_name').value.trim();
  const email = document.getElementById('u_user').value.trim();
  const pass = document.getElementById('u_pass').value;
  const role = document.getElementById('u_role').value;
  if (!confirm(`Se creará el usuario "${email}" y se iniciará sesión con esa cuenta automáticamente.\n\nDespués tendrás que cerrar sesión y volver a entrar como ${currentAuthUser.email}.\n\n¿Continuar?`)) return;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await setDoc(doc(db, 'users', cred.user.uid), {
      name, email, role,
      createdAt: toISO(new Date()),
      createdBy: currentUser.uid
    });
    document.getElementById('userForm').reset();
    toast(`Usuario "${name}" creado. Inicia sesión con tu admin.`, 'success');
  } catch (err) { toast(mapAuthError(err), 'error'); }
});

function renderUsers() {
  if (!currentUser || currentUser.role !== 'admin') return;
  const tbody = document.getElementById('usersTbody');
  if (!tbody) return;
  document.getElementById('userCount').textContent = state.users.length + ' USUARIO' + (state.users.length !== 1 ? 'S' : '');
  tbody.innerHTML = state.users.map(u => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="user-avatar" style="width:28px;height:28px;background:var(--sola-beige);color:var(--sola-dark);">${(u.name || u.email || '?').charAt(0).toUpperCase()}</div>
          <div>
            <div style="font-weight:600;">${escapeHtml(u.name || '—')}</div>
            ${u.uid === currentUser.uid ? '<div style="font-size:10px;color:var(--text-dim);">(tú)</div>' : ''}
          </div>
        </div>
      </td>
      <td><code style="font-family:'JetBrains Mono',monospace;font-size:12px;">${escapeHtml(u.email || '—')}</code></td>
      <td>
        <select data-uid="${u.uid}" data-action="changeRole" ${u.uid === currentUser.uid ? 'disabled' : ''} style="padding:4px 8px;border:1px solid var(--border);border-radius:3px;background:var(--bg);font-family:inherit;font-size:12px;">
          <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Consulta</option>
          <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>Edición</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option>
        </select>
      </td>
      <td style="color:var(--text-dim);font-family:'JetBrains Mono',monospace;font-size:11px;">${u.createdAt || '—'}</td>
      <td style="text-align:right;">
        <button class="btn btn-ghost btn-sm" data-uid="${u.uid}" data-action="resetpass">Reset contraseña</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('select[data-action=changeRole]').forEach(sel => {
    sel.addEventListener('change', () => changeRole(sel.dataset.uid, sel.value));
  });
  tbody.querySelectorAll('button[data-action=resetpass]').forEach(btn => {
    btn.addEventListener('click', () => resetUserPassword(btn.dataset.uid));
  });
}

async function changeRole(userId, newRole) {
  if (currentUser.role !== 'admin') return;
  if (userId === currentUser.uid) { toast('No puedes cambiar tu propio rol', 'error'); return; }
  const u = state.users.find(x => x.uid === userId);
  if (!u) return;
  if (u.role === 'admin' && newRole !== 'admin') {
    const adminCount = state.users.filter(x => x.role === 'admin').length;
    if (adminCount <= 1) { toast('Debe haber al menos un admin', 'error'); renderUsers(); return; }
  }
  try { await updateDoc(doc(db, 'users', userId), { role: newRole }); toast(`Rol: ${ROLE_LABELS[newRole]}`, 'success'); }
  catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function resetUserPassword(userId) {
  if (currentUser.role !== 'admin') return;
  const u = state.users.find(x => x.uid === userId);
  if (!u) return;
  if (!confirm(`¿Enviar email de reset a ${u.email}?`)) return;
  try { await sendPasswordResetEmail(auth, u.email); toast('Email enviado', 'success'); }
  catch (err) { toast(mapAuthError(err), 'error'); }
}

// ============================================================
// HISTORY
// ============================================================
function renderHistoryFilters() {
  const selM = document.getElementById('histFilterMachine');
  const selU = document.getElementById('histFilterUser');
  if (!selM || !selU) return;
  const curM = selM.value, curU = selU.value;
  selM.innerHTML = '<option value="">Todas las máquinas</option>' +
    state.machines.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  selM.value = curM || '';
  // Usuarios que han registrado algo
  const uids = new Set();
  Object.values(state.historyByMachine).forEach(arr => arr.forEach(h => uids.add(h.by)));
  const userMap = {};
  state.users.forEach(u => { userMap[u.uid] = u.name || u.email; });
  const userList = [...uids].map(uid => ({ uid, name: userMap[uid] || uid.slice(-6) }));
  selU.innerHTML = '<option value="">Todos los operarios</option>' +
    userList.map(u => `<option value="${u.uid}">${escapeHtml(u.name)}</option>`).join('');
  selU.value = curU || '';
}

document.getElementById('histFilterMachine').addEventListener('change', renderHistory);
document.getElementById('histFilterUser').addEventListener('change', renderHistory);
document.getElementById('histFilterFrom').addEventListener('change', renderHistory);
document.getElementById('histFilterTo').addEventListener('change', renderHistory);

function applyHistoryFilters(records, machineId) {
  const fm = document.getElementById('histFilterMachine').value;
  const fu = document.getElementById('histFilterUser').value;
  const ff = document.getElementById('histFilterFrom').value;
  const ft = document.getElementById('histFilterTo').value;
  if (fm && fm !== machineId) return [];
  return records.filter(r => {
    if (fu && r.by !== fu) return false;
    if (ff && r.date < ff) return false;
    if (ft && r.date > ft) return false;
    return true;
  });
}

function computeMachineStats(records) {
  if (!records || records.length === 0) return { total: 0, avgDays: null, last: null };
  const sorted = records.slice().sort((a,b) => (a.date || '').localeCompare(b.date || ''));
  const total = sorted.length;
  const last = sorted[sorted.length - 1].date;
  let avgDays = null;
  if (total > 1) {
    let sum = 0;
    for (let i = 1; i < sorted.length; i++) {
      const d1 = fromISO(sorted[i-1].date);
      const d2 = fromISO(sorted[i].date);
      sum += Math.abs(workdaysBetween(d1, d2));
    }
    avgDays = Math.round(sum / (total - 1));
  }
  return { total, avgDays, last };
}

function computeMonthlyChart(records) {
  // Últimos 12 meses
  const today = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push({
      year: d.getFullYear(),
      month: d.getMonth(),
      label: MONTHS_ES[d.getMonth()].slice(0,3),
      count: 0
    });
  }
  records.forEach(r => {
    const d = fromISO(r.date);
    const idx = months.findIndex(m => m.year === d.getFullYear() && m.month === d.getMonth());
    if (idx >= 0) months[idx].count++;
  });
  return months;
}

function renderBarChart(monthly) {
  const max = Math.max(1, ...monthly.map(m => m.count));
  return `<div class="history-chart-wrap">
    <div class="history-chart">
      ${monthly.map(m => {
        const pct = (m.count / max) * 100;
        return `<div class="history-bar" style="height:${pct}%;" title="${m.label}: ${m.count}">
          ${m.count > 0 ? `<div class="history-bar-value">${m.count}</div>` : ''}
          <div class="history-bar-label">${m.label}</div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderHistory() {
  const content = document.getElementById('historyContent');
  if (!content) return;
  if (state.machines.length === 0) {
    content.innerHTML = '<div class="empty-state">// Sin máquinas para mostrar historial</div>';
    return;
  }

  const fm = document.getElementById('histFilterMachine').value;
  const machinesToShow = fm ? state.machines.filter(m => m.id === fm) : state.machines;

  const blocks = machinesToShow.map(m => {
    const all = state.historyByMachine[m.id] || [];
    const filtered = applyHistoryFilters(all, m.id);
    const stats = computeMachineStats(all);
    const monthly = computeMonthlyChart(all);

    return `
      <div class="history-machine-block" data-mid="${m.id}">
        <div class="history-machine-header" data-action="toggle">
          <div class="history-machine-header-left">
            <div class="history-machine-header-title">
              <span class="history-expand-icon">▸</span>
              ${escapeHtml(m.name)}
            </div>
            <div class="history-machine-header-code">${escapeHtml(m.code || '—')}${m.location ? ' · ' + escapeHtml(m.location) : ''}</div>
          </div>
          <div class="history-machine-stats">
            <div class="history-stat"><div class="history-stat-label">Total</div><div class="history-stat-value">${stats.total}</div></div>
            <div class="history-stat"><div class="history-stat-label">Frec. real</div><div class="history-stat-value">${stats.avgDays != null ? stats.avgDays + 'd lab.' : '—'}</div></div>
            <div class="history-stat"><div class="history-stat-label">Configurada</div><div class="history-stat-value">${m.interval}d lab.</div></div>
            <div class="history-stat"><div class="history-stat-label">Último</div><div class="history-stat-value">${stats.last ? formatDateES(fromISO(stats.last)) : '—'}</div></div>
          </div>
        </div>
        <div class="history-machine-body">
          ${stats.total >= 1 ? renderBarChart(monthly) : ''}
          ${renderHistoryTable(m.id, filtered)}
        </div>
      </div>
    `;
  }).join('');

  content.innerHTML = blocks || '<div class="empty-state">// Sin resultados</div>';

  content.querySelectorAll('.history-machine-header').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('expanded'));
  });

  bindHistoryActions(content);
}

function renderHistoryTable(machineId, records) {
  if (records.length === 0) {
    return '<div class="history-empty-msg">// Sin registros (revisa filtros si corresponde)</div>';
  }
  return `<table class="history-table">
    <thead>
      <tr>
        <th style="width:120px;">Fecha</th>
        <th style="width:180px;">Operario</th>
        <th>Comentario</th>
        <th style="width:100px;text-align:right;">Acciones</th>
      </tr>
    </thead>
    <tbody>
      ${records.map(r => {
        const edited = r.editedAt ? `<span class="history-edited-tag"> · editado</span>` : '';
        const noteHtml = r.note
          ? `<span class="history-comment">${escapeHtml(r.note)}</span>${edited}`
          : `<span class="history-comment history-comment-empty">Sin comentario</span>`;
        const canDelete = currentUser && currentUser.role === 'admin';
        const canEdit = can('editComment');
        return `<tr>
          <td>${formatDateES(fromISO(r.date))}</td>
          <td>${escapeHtml(r.byName || '—')}</td>
          <td>${noteHtml}</td>
          <td style="text-align:right;">
            ${canEdit ? `<button class="btn btn-ghost btn-sm" data-hist-action="editComment" data-mid="${machineId}" data-hid="${r.id}">Editar</button>` : ''}
            ${canDelete ? `<button class="btn btn-danger btn-sm" data-hist-action="deleteRecord" data-mid="${machineId}" data-hid="${r.id}">🗑</button>` : ''}
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function bindHistoryActions(container) {
  container.querySelectorAll('button[data-hist-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.histAction;
      const mid = btn.dataset.mid;
      const hid = btn.dataset.hid;
      if (action === 'editComment') openEditComment(mid, hid);
      else if (action === 'deleteRecord') deleteHistoryRecord(mid, hid);
    });
  });
}

// Edit comment modal
let editingCommentCtx = null;
document.getElementById('editCommentCancel').addEventListener('click', () => {
  document.getElementById('editCommentModal').classList.remove('show');
  editingCommentCtx = null;
});
document.getElementById('editCommentModal').addEventListener('click', (e) => {
  if (e.target.id === 'editCommentModal') {
    document.getElementById('editCommentModal').classList.remove('show');
    editingCommentCtx = null;
  }
});
document.getElementById('editCommentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingCommentCtx) return;
  if (!requirePerm('editComment')) return;
  const newText = document.getElementById('editCommentText').value.trim();
  try {
    await updateDoc(doc(db, 'machines', editingCommentCtx.mid, 'history', editingCommentCtx.hid), {
      note: newText,
      editedBy: currentUser.uid,
      editedByName: currentUser.name || currentUser.email,
      editedAt: new Date().toISOString()
    });
    document.getElementById('editCommentModal').classList.remove('show');
    editingCommentCtx = null;
    toast('Comentario actualizado', 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

function openEditComment(machineId, histId) {
  if (!requirePerm('editComment')) return;
  const h = (state.historyByMachine[machineId] || []).find(x => x.id === histId);
  if (!h) return;
  editingCommentCtx = { mid: machineId, hid: histId };
  const m = state.machines.find(x => x.id === machineId);
  document.getElementById('editCommentContext').textContent =
    `${m ? m.name : ''} · ${formatDateES(fromISO(h.date))} · ${h.byName || ''}`;
  document.getElementById('editCommentText').value = h.note || '';
  document.getElementById('editCommentModal').classList.add('show');
  setTimeout(() => document.getElementById('editCommentText').focus(), 100);
}

async function deleteHistoryRecord(mid, hid) {
  if (currentUser.role !== 'admin') { toast('Solo admins', 'error'); return; }
  if (!confirm('¿Eliminar este registro del historial?\n\nNo afectará a la fecha del último mantenimiento. Esta acción no se puede deshacer.')) return;
  try {
    await deleteDoc(doc(db, 'machines', mid, 'history', hid));
    toast('Registro eliminado');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// Machine history modal
document.getElementById('historyMachineModalClose').addEventListener('click', () => {
  document.getElementById('historyMachineModal').classList.remove('show');
});
document.getElementById('historyMachineModal').addEventListener('click', (e) => {
  if (e.target.id === 'historyMachineModal') {
    document.getElementById('historyMachineModal').classList.remove('show');
  }
});

function openHistoryModal(machineId) {
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  const records = state.historyByMachine[machineId] || [];
  const stats = computeMachineStats(records);
  const monthly = computeMonthlyChart(records);
  document.getElementById('historyMachineModalTitle').textContent = `Historial · ${m.name}`;
  document.getElementById('historyMachineModalSub').innerHTML =
    `${stats.total} registros · Frecuencia real: ${stats.avgDays != null ? stats.avgDays + ' días lab.' : '—'} · Configurada: ${m.interval} días lab.`;
  const body = document.getElementById('historyMachineModalBody');
  body.innerHTML = (stats.total >= 1 ? renderBarChart(monthly) : '') + renderHistoryTable(machineId, records);
  bindHistoryActions(body);
  document.getElementById('historyMachineModal').classList.add('show');
}

// ============================================================
// INIT
// ============================================================
document.getElementById('loginLoading').style.display = 'block';
document.getElementById('loginForm').style.display = 'none';

if (initFirebase()) {
  setupAuthListener();
}
