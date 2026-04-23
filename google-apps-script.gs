/**
 * SOLA · Notificador de mantenimientos por email
 * ============================================================
 *
 * Envía dos tipos de emails:
 *
 *  1. SEMANAL (enviarResumenSemanal):
 *     Se ejecuta el día/hora configurados en Ajustes de la app.
 *     Envía a responsable global + responsables por máquina un resumen
 *     con TODOS los mantenimientos de la semana siguiente, agrupados por día.
 *
 *  2. DIARIO URGENTE (enviarAvisosDiarios):
 *     Se ejecuta todos los días (configurable trigger).
 *     Envía SOLO si hay mantenimientos para hoy o mañana.
 *     Evita duplicados: solo reenvía si hay cambios respecto al último envío.
 *
 * CONFIGURACIÓN (obligatoria):
 *  - PROJECT_ID: tu projectId de Firebase.
 *  - Dos triggers:
 *      · enviarResumenSemanal → cada hora (el script decide si hoy toca).
 *      · enviarAvisosDiarios  → cada día a primera hora.
 */

// ⚙ CONFIGURACIÓN
const PROJECT_ID = 'PEGA-AQUÍ-TU-PROJECT-ID';
const EMAIL_FROM_NAME = 'SOLA Mantenimiento';

// ──────────────────────────────────────────────────────────────
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ============================================================
// FUNCIÓN PRINCIPAL 1 — Resumen semanal
// Trigger: cada hora. El script decide si hoy es el día + hora configurados.
// ============================================================
function enviarResumenSemanal() {
  console.log('=== RESUMEN SEMANAL ===');
  if (PROJECT_ID === 'PEGA-AQUÍ-TU-PROJECT-ID') {
    console.error('❌ Falta configurar PROJECT_ID'); return;
  }

  const settings = leerDocumento('settings/global') || {};
  const now = new Date();
  const weeklyDay = settings.weeklyDay ?? 1;   // 0=Dom ... 6=Sab
  const weeklyHour = settings.weeklyHour ?? 8;

  if (now.getDay() !== weeklyDay) {
    console.log(`No es el día configurado (hoy=${now.getDay()}, conf=${weeklyDay}). No se envía.`);
    return;
  }
  if (now.getHours() !== weeklyHour) {
    console.log(`No es la hora configurada (hoy=${now.getHours()}h, conf=${weeklyHour}h). No se envía.`);
    return;
  }

  const globalEmail = settings.globalResponsibleEmail;
  const workWeekdays = settings.workWeekdays || [1,2,3,4,5];
  const holidays = leerColeccion('holidays');
  const holidaySet = new Set(holidays.map(h => h.id));
  const machines = leerColeccion('machines');

  // Lista de mantenimientos de la próxima semana (7 días desde hoy inclusivo)
  const semana = [];
  const hoy = hoyDate();
  const maxDate = new Date(hoy); maxDate.setDate(hoy.getDate() + 7);

  machines.forEach(m => {
    if (!m.interval || !m.lastMaintenance) return;
    const nextDate = addWorkdays(fromISO(m.lastMaintenance), m.interval, workWeekdays, holidaySet);
    if (nextDate <= maxDate) {
      const daysUntil = Math.round((nextDate - hoy) / 86400000);
      semana.push({ m, nextDate, daysUntil });
    }
  });

  semana.sort((a,b) => a.nextDate - b.nextDate);

  // Email al responsable global
  if (globalEmail && semana.length > 0) {
    enviarEmail(
      globalEmail,
      `[SOLA] Resumen semanal · ${semana.length} mantenimiento${semana.length !== 1 ? 's' : ''}`,
      cuerpoSemanal(semana, 'global')
    );
    console.log(`✓ Resumen semanal enviado a responsable global (${globalEmail})`);
  } else if (!globalEmail) {
    console.log('⚠ Sin responsable global configurado');
  } else {
    console.log('No hay mantenimientos esta semana para el responsable global');
  }

  // Emails a responsables por máquina
  const porResponsable = {}; // email -> [ {m, nextDate, daysUntil}, ...]
  semana.forEach(item => {
    const re = item.m.responsibleEmail;
    if (re && re !== globalEmail) {
      if (!porResponsable[re]) porResponsable[re] = [];
      porResponsable[re].push(item);
    }
  });
  Object.entries(porResponsable).forEach(([email, items]) => {
    enviarEmail(
      email,
      `[SOLA] Resumen semanal · ${items.length} mantenimiento${items.length !== 1 ? 's' : ''}`,
      cuerpoSemanal(items, 'machine')
    );
    console.log(`✓ Resumen semanal enviado a ${email} (${items.length} máquinas)`);
  });

  console.log('Resumen semanal completado.');
}

// ============================================================
// FUNCIÓN PRINCIPAL 2 — Avisos urgentes diarios
// Trigger: cada día 7-9h.
// Envía solo si hay mantenimientos para hoy o mañana.
// Evita duplicados con colección sentNotifications.
// ============================================================
function enviarAvisosDiarios() {
  console.log('=== AVISOS DIARIOS ===');
  if (PROJECT_ID === 'PEGA-AQUÍ-TU-PROJECT-ID') {
    console.error('❌ Falta configurar PROJECT_ID'); return;
  }

  const settings = leerDocumento('settings/global') || {};
  const globalEmail = settings.globalResponsibleEmail;
  const workWeekdays = settings.workWeekdays || [1,2,3,4,5];
  const holidays = leerColeccion('holidays');
  const holidaySet = new Set(holidays.map(h => h.id));
  const machines = leerColeccion('machines');

  const hoy = hoyDate();
  const hoyISO = toISO(hoy);

  const urgentes = []; // hoy + mañana laborable + vencidos
  machines.forEach(m => {
    if (!m.interval || !m.lastMaintenance) return;
    const nextDate = addWorkdays(fromISO(m.lastMaintenance), m.interval, workWeekdays, holidaySet);
    const daysUntilCal = Math.round((nextDate - hoy) / 86400000);
    // Consideramos urgente: vencido (<=0) o en los próximos 2 días laborables
    if (daysUntilCal <= 2) {
      urgentes.push({ m, nextDate, daysUntilCal });
    }
  });

  if (urgentes.length === 0) {
    console.log('No hay mantenimientos urgentes hoy.');
    return;
  }

  // Calcular "firma" del conjunto para no duplicar
  const firma = urgentes.map(u => `${u.m.id}:${toISO(u.nextDate)}`).sort().join('|');

  // Email global
  if (globalEmail) {
    const sentId = `daily_global_${hoyISO}`;
    const sentDoc = leerDocumento(`sentNotifications/${sentId}`);
    if (sentDoc && sentDoc.firma === firma) {
      console.log('Nada nuevo desde el último envío al global. No se envía.');
    } else {
      enviarEmail(
        globalEmail,
        `[SOLA] ⚠ Urgente · ${urgentes.length} mantenimiento${urgentes.length !== 1 ? 's' : ''}`,
        cuerpoDiarioUrgente(urgentes)
      );
      escribirDocumento(`sentNotifications/${sentId}`, {
        firma,
        sentAt: new Date().toISOString(),
        email: globalEmail,
        count: urgentes.length
      });
      console.log(`✓ Aviso diario enviado al global (${globalEmail})`);
    }
  }

  // Emails a responsables por máquina
  const porResponsable = {};
  urgentes.forEach(item => {
    const re = item.m.responsibleEmail;
    if (re && re !== globalEmail) {
      if (!porResponsable[re]) porResponsable[re] = [];
      porResponsable[re].push(item);
    }
  });
  Object.entries(porResponsable).forEach(([email, items]) => {
    const firmaResp = items.map(u => `${u.m.id}:${toISO(u.nextDate)}`).sort().join('|');
    const sentIdResp = `daily_${email.replace(/[^a-zA-Z0-9]/g,'_')}_${hoyISO}`;
    const sentDoc = leerDocumento(`sentNotifications/${sentIdResp}`);
    if (sentDoc && sentDoc.firma === firmaResp) {
      console.log(`Nada nuevo para ${email}. No se envía.`);
    } else {
      enviarEmail(
        email,
        `[SOLA] ⚠ Urgente · ${items.length} mantenimiento${items.length !== 1 ? 's' : ''}`,
        cuerpoDiarioUrgente(items)
      );
      escribirDocumento(`sentNotifications/${sentIdResp}`, {
        firma: firmaResp,
        sentAt: new Date().toISOString(),
        email,
        count: items.length
      });
      console.log(`✓ Aviso diario enviado a ${email} (${items.length} máquinas)`);
    }
  });

  console.log('Avisos diarios completados.');
}

// ============================================================
// FUNCIONES AUXILIARES DE TEST
// ============================================================
function testConexion() {
  console.log('PROJECT_ID:', PROJECT_ID);
  if (PROJECT_ID === 'PEGA-AQUÍ-TU-PROJECT-ID') {
    console.error('❌ Falta configurar PROJECT_ID'); return;
  }
  try {
    const machines = leerColeccion('machines');
    console.log(`✓ Conexión OK. ${machines.length} máquinas encontradas.`);
    const settings = leerDocumento('settings/global');
    if (settings) {
      console.log(`  Responsable global: ${settings.globalResponsibleEmail || '(sin configurar)'}`);
      console.log(`  Día semanal: ${settings.weeklyDay}, hora: ${settings.weeklyHour}`);
    }
  } catch (err) {
    console.error('❌ Error:', err);
  }
}

function testEnvioEmail() {
  const email = Session.getActiveUser().getEmail();
  enviarEmail(email, '[SOLA] Test de configuración', `
    <p>Si recibes este email, la configuración del notificador SOLA funciona correctamente.</p>
    <p><strong>Fecha/hora:</strong> ${new Date().toLocaleString('es-ES')}</p>
  `);
  console.log(`Email de prueba enviado a ${email}`);
}

function resetearNotificaciones() {
  const sent = leerColeccion('sentNotifications');
  let n = 0;
  sent.forEach(s => {
    try { borrarDocumento(`sentNotifications/${s.id}`); n++; }
    catch (err) { console.error('Error:', s.id, err); }
  });
  console.log(`${n} notificaciones reseteadas`);
}

// ============================================================
// HELPERS: Email
// ============================================================
function enviarEmail(to, subject, htmlBody) {
  try {
    MailApp.sendEmail({
      to,
      subject,
      htmlBody: envolverCuerpo(htmlBody),
      name: EMAIL_FROM_NAME
    });
  } catch (err) {
    console.error(`Error enviando a ${to}:`, err);
  }
}

function envolverCuerpo(contenido) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#353535;color:#fff;padding:20px 24px;">
        <div style="font-size:24px;font-weight:800;letter-spacing:-0.02em;">SOLA</div>
        <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;opacity:0.8;margin-top:4px;">Mantenimiento</div>
      </div>
      <div style="padding:24px;background:#f7f6f3;">
        ${contenido}
      </div>
      <div style="padding:14px 24px;background:#353535;color:#999;font-size:11px;text-align:center;">
        Email automático · SOLA Gestor de Mantenimiento
      </div>
    </div>
  `;
}

function cuerpoSemanal(items, tipo) {
  // Agrupar por día
  const porDia = {};
  items.forEach(item => {
    const k = toISO(item.nextDate);
    if (!porDia[k]) porDia[k] = [];
    porDia[k].push(item);
  });
  const dias = Object.keys(porDia).sort();

  const titulo = tipo === 'global'
    ? 'Resumen semanal de mantenimientos'
    : 'Mantenimientos de tus máquinas esta semana';

  let html = `<h2 style="margin:0 0 8px 0;font-size:20px;">${titulo}</h2>`;
  html += `<p style="margin:0 0 20px 0;color:#666;font-size:13px;">Hay <strong>${items.length}</strong> mantenimiento${items.length !== 1 ? 's' : ''} previsto${items.length !== 1 ? 's' : ''} en los próximos 7 días.</p>`;

  dias.forEach(iso => {
    const d = fromISO(iso);
    const fechaStr = d.toLocaleDateString('es-ES', { weekday:'long', day:'2-digit', month:'long' });
    const hoy = hoyDate();
    const diff = Math.round((d - hoy) / 86400000);
    let badge = '';
    if (diff < 0) badge = '<span style="background:#b03a3a;color:white;padding:2px 8px;border-radius:3px;font-size:10px;margin-left:8px;">VENCIDO</span>';
    else if (diff === 0) badge = '<span style="background:#b03a3a;color:white;padding:2px 8px;border-radius:3px;font-size:10px;margin-left:8px;">HOY</span>';
    else if (diff === 1) badge = '<span style="background:#b8872a;color:white;padding:2px 8px;border-radius:3px;font-size:10px;margin-left:8px;">MAÑANA</span>';

    html += `<div style="margin-bottom:20px;">`;
    html += `<div style="font-weight:700;font-size:14px;margin-bottom:8px;text-transform:capitalize;">${fechaStr}${badge}</div>`;
    html += `<table style="width:100%;border-collapse:collapse;background:white;border:1px solid #e4e1d8;">`;
    porDia[iso].forEach(it => {
      html += `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #e4e1d8;font-weight:600;font-size:13px;">${escapeEmail(it.m.name)}${it.m.code ? ' <span style="color:#999;font-weight:400;font-size:11px;font-family:monospace;">(' + escapeEmail(it.m.code) + ')</span>' : ''}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e4e1d8;font-size:12px;color:#666;">${it.m.task ? '🔧 ' + escapeEmail(it.m.task) : ''}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e4e1d8;font-size:12px;color:#666;text-align:right;">${it.m.location ? '📍 ' + escapeEmail(it.m.location) : ''}</td>
      </tr>`;
    });
    html += '</table></div>';
  });

  html += `<p style="margin:24px 0 0 0;font-size:11px;color:#999;">Entra en la aplicación para registrar cada mantenimiento una vez realizado.</p>`;
  return html;
}

function cuerpoDiarioUrgente(items) {
  // Ordenar más urgente primero
  items.sort((a,b) => a.daysUntilCal - b.daysUntilCal);
  let html = `<h2 style="margin:0 0 8px 0;font-size:20px;color:#b03a3a;">⚠ Mantenimientos urgentes</h2>`;
  html += `<p style="margin:0 0 20px 0;color:#666;font-size:13px;">Hay <strong>${items.length}</strong> mantenimiento${items.length !== 1 ? 's' : ''} urgente${items.length !== 1 ? 's' : ''}:</p>`;

  items.forEach(it => {
    const diff = it.daysUntilCal;
    let estado;
    let color;
    if (diff < 0) { estado = `VENCIDO hace ${Math.abs(diff)} día${Math.abs(diff)!==1?'s':''}`; color = '#b03a3a'; }
    else if (diff === 0) { estado = 'HOY'; color = '#b03a3a'; }
    else if (diff === 1) { estado = 'MAÑANA'; color = '#b8872a'; }
    else { estado = `En ${diff} días`; color = '#b8872a'; }

    html += `<div style="background:white;border-left:4px solid ${color};padding:14px 18px;margin-bottom:10px;">`;
    html += `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;">`;
    html += `<div style="font-size:16px;font-weight:700;">${escapeEmail(it.m.name)}</div>`;
    html += `<div style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.1em;">${estado}</div>`;
    html += `</div>`;
    if (it.m.code) html += `<div style="font-size:11px;color:#999;font-family:monospace;margin-top:2px;">${escapeEmail(it.m.code)}</div>`;
    if (it.m.task) html += `<div style="font-size:13px;margin-top:8px;">🔧 ${escapeEmail(it.m.task)}</div>`;
    if (it.m.location) html += `<div style="font-size:12px;color:#666;margin-top:4px;">📍 ${escapeEmail(it.m.location)}</div>`;
    html += `<div style="font-size:12px;color:#666;margin-top:8px;">Fecha prevista: <strong>${it.nextDate.toLocaleDateString('es-ES', {weekday:'long', day:'2-digit', month:'long'})}</strong></div>`;
    if (it.m.notes) html += `<div style="font-size:11px;color:#666;margin-top:8px;padding:8px;background:#f7f6f3;border-radius:3px;">${escapeEmail(it.m.notes)}</div>`;
    html += `</div>`;
  });

  html += `<p style="margin:20px 0 0 0;font-size:11px;color:#999;">Cuando realices un mantenimiento, regístralo en la aplicación para actualizar el próximo ciclo.</p>`;
  return html;
}

function escapeEmail(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================================
// HELPERS: Firestore REST
// ============================================================
function getToken() { return ScriptApp.getOAuthToken(); }

function leerColeccion(coleccion) {
  const url = `${FIRESTORE_BASE}/${coleccion}?pageSize=500`;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + getToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`HTTP ${res.getResponseCode()}: ${res.getContentText()}`);
  }
  const data = JSON.parse(res.getContentText());
  if (!data.documents) return [];
  return data.documents.map(parseDoc);
}

function leerDocumento(path) {
  const url = `${FIRESTORE_BASE}/${path}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + getToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) {
    throw new Error(`HTTP ${res.getResponseCode()}: ${res.getContentText()}`);
  }
  return parseDoc(JSON.parse(res.getContentText()));
}

function escribirDocumento(path, data) {
  const url = `${FIRESTORE_BASE}/${path}`;
  const fields = encodeFields(data);
  const res = UrlFetchApp.fetch(url, {
    method: 'patch',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + getToken() },
    payload: JSON.stringify({ fields }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) {
    throw new Error(`HTTP ${res.getResponseCode()}: ${res.getContentText()}`);
  }
}

function borrarDocumento(path) {
  const url = `${FIRESTORE_BASE}/${path}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: { 'Authorization': 'Bearer ' + getToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400 && res.getResponseCode() !== 404) {
    throw new Error(`HTTP ${res.getResponseCode()}: ${res.getContentText()}`);
  }
}

function parseDoc(doc) {
  const parts = doc.name.split('/');
  const id = parts[parts.length - 1];
  const out = { id };
  if (doc.fields) for (const k in doc.fields) out[k] = decodeValue(doc.fields[k]);
  return out;
}

function decodeValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(decodeValue);
  if (v.mapValue !== undefined) {
    const out = {};
    const f = v.mapValue.fields || {};
    for (const k in f) out[k] = decodeValue(f[k]);
    return out;
  }
  return null;
}

function encodeFields(obj) {
  const out = {};
  for (const k in obj) out[k] = encodeValue(obj[k]);
  return out;
}
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: v } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

// ============================================================
// HELPERS: fechas
// ============================================================
function hoyDate() { const d = new Date(); d.setHours(0,0,0,0); return d; }
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function fromISO(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function isWorkday(date, workWeekdays, holidaySet) {
  if (holidaySet.has(toISO(date))) return false;
  return workWeekdays.includes(date.getDay());
}
function addWorkdays(startDate, n, workWeekdays, holidaySet) {
  const d = new Date(startDate);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate()+1);
    if (isWorkday(d, workWeekdays, holidaySet)) added++;
  }
  return d;
}
