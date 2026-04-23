# SOLA · Gestor de Mantenimiento

Aplicación web para gestionar el mantenimiento preventivo de máquinas, con **base de datos en la nube** (Firebase) y **avisos automáticos por email** (Google Apps Script).

## ✨ Funcionalidades

- 🔥 **Firebase**: base de datos en la nube, sincronizada en tiempo real.
- 🔐 **Login real** con email + contraseña + recuperación por email.
- 🏠 **Panel de control** con vista de urgentes y acceso rápido para registrar mantenimientos.
- ✓ **Registro ultra simple**: clic en la máquina, botón "Hecho", comentario opcional. Confirmación grande.
- 📜 **Historial completo** agrupado por máquina, con gráfico mensual y frecuencia real de mantenimiento.
- 👥 **3 roles**: administrador, edición, consulta. **Todos pueden registrar mantenimientos y editar comentarios**.
- 📅 **Calendario laboral** con festivos individuales o por rango.
- ✉️ **Emails automáticos**:
  - **Semanal**: resumen de los mantenimientos de la semana (día y hora configurables).
  - **Diario urgente**: solo cuando hay mantenimientos para hoy/mañana. Evita duplicados.

---

# 🚀 Guía de configuración

## PARTE 1 — Firebase (obligatoria)

### 1. Crear proyecto Firebase

1. Entra en https://console.firebase.google.com/ con tu cuenta Google.
2. Pulsa **"Añadir proyecto"** / **"Crear proyecto"**.
3. Nombre: `sola-mantenimiento` (o el que prefieras).
4. Puedes desactivar Google Analytics.

### 2. Activar Authentication

1. Busca **"Authentication"** (barra superior o menú lateral).
2. Pulsa **"Comenzar"**.
3. En **"Sign-in method"**, activa **"Correo electrónico/Contraseña"** (solo el primer interruptor).
4. Guarda.

⚠️ No actives otros proveedores (Google, Facebook, etc.). La app solo soporta email/contraseña.

### 3. Crear Firestore Database

1. Busca **"Firestore Database"**.
2. **Crear base de datos** → Ubicación **`eur3 (europe-west)`** → Modo **producción** → Habilitar.

### 4. Poner las reglas de seguridad

1. Firestore → pestaña **"Reglas"**.
2. Borra todo el contenido.
3. Copia el contenido del archivo **`firestore-rules.txt`** del proyecto y pégalo.
4. Publica.

### 5. Registrar la app web

1. Engranaje ⚙ arriba a la izquierda → **"Configuración del proyecto"**.
2. Pestaña **"General"** → baja hasta **"Tus apps"** → icono **`</>`** (Web).
3. Alias: `SOLA Web`. **NO marques** "Firebase Hosting".
4. Registrar app.

### 6. Copiar credenciales

Copia los valores del `firebaseConfig` que te muestra y pégalos en `firebase-config.js` del proyecto.

### 7. Subir a GitHub Pages

1. Crea repositorio en GitHub.
2. Sube: `index.html`, `app.js`, `firebase-config.js`, `logo-sola.png`, `README.md`, `firestore-rules.txt`, `google-apps-script.gs`, `.gitignore`.
3. **Settings → Pages** → rama `main` / raíz → Save.

### 8. Autorizar dominio

Firebase → **Authentication → Settings → Authorized domains** → Añadir `TU-USUARIO.github.io`.

### 9. Crear cuenta admin

1. Abre la app online.
2. Pulsa **"Primera vez: crear cuenta de administrador"**.
3. Rellena datos → listo.

---

## PARTE 2 — Google Apps Script (emails automáticos)

⚠️ Opcional pero recomendado. Sin esto, la app funciona pero no envía emails.

### 10. Crear el proyecto de script

1. Entra en https://script.google.com/ con la **misma cuenta Google** que Firebase.
2. **"Proyecto nuevo"** → Se abre editor con `Code.gs`.
3. Borra todo el contenido de `Code.gs`.
4. Abre el archivo **`google-apps-script.gs`** de este proyecto, copia TODO su contenido y pégalo.

### 11. Configurar tu PROJECT_ID

En las primeras líneas del código, localiza:

```javascript
const PROJECT_ID = 'PEGA-AQUÍ-TU-PROJECT-ID';
```

Sustituye `'PEGA-AQUÍ-TU-PROJECT-ID'` por el **ID de tu proyecto Firebase** (mismo valor que `projectId` en `firebase-config.js`).

### 12. Guardar

Pulsa `Ctrl + S`. Nombre del proyecto: `SOLA Notificador`.

### 13. Autorizar permisos

Google Apps Script necesita permiso para acceder a Firestore y enviar emails:

1. Arriba, en el selector de funciones, elige **`testConexion`**.
2. Pulsa **"Ejecutar"**.
3. Se abre ventana de autorización → **"Revisar permisos"** → elige tu cuenta.
4. Aparece **"Google no ha verificado esta aplicación"** → **"Configuración avanzada"** → **"Ir a SOLA Notificador (no seguro)"**.
5. **"Permitir"**.
6. Revisa los **"Registros"**: deberías ver `✓ Conexión OK. N máquinas encontradas.`

### 14. Test de envío

Selector de funciones → **`testEnvioEmail`** → Ejecutar. Revisa tu bandeja: debería llegar un email de prueba.

### 15. Configurar los triggers (ejecución automática)

Hacen falta **DOS triggers**:

**Trigger A — Resumen semanal** (cada hora, el script decide si toca enviar):

1. Menú lateral izquierdo → icono de reloj 🕐 (**"Activadores"**).
2. **"+ Añadir activador"**.
3. Configuración:
   - **Función**: `enviarResumenSemanal`
   - **Despliegue**: `Head`
   - **Origen del evento**: `Basado en tiempo`
   - **Tipo**: `Temporizador por horas`
   - **Intervalo**: `Cada hora`
4. Guardar.

**Trigger B — Avisos urgentes diarios** (una vez al día):

1. **"+ Añadir activador"** de nuevo.
2. Configuración:
   - **Función**: `enviarAvisosDiarios`
   - **Despliegue**: `Head`
   - **Origen del evento**: `Basado en tiempo`
   - **Tipo**: `Temporizador diario`
   - **Horario**: `7:00 a.m. a 8:00 a.m.` (o el que prefieras)
3. Guardar.

### 16. Configurar los emails en la app

Vuelve a SOLA → **Ajustes → Avisos por email**:

- **Responsable global**: email de la persona que recibirá todos los emails (resumen semanal + urgentes).
- **Día del email semanal**: (ej. Lunes).
- **Hora del envío semanal**: (ej. 08:00).
- Pulsa **Guardar**.

Opcionalmente, en cada máquina puedes poner un **"Responsable de esta máquina"** (email). Esa persona recibirá solo avisos de sus máquinas.

---

## 🧭 Cómo funciona la aplicación

### Panel (pestaña inicial)

- **Stats arriba**: Total / Al día / Próximos / Vencidos.
- **Urgentes**: tarjetas grandes con las máquinas vencidas o que vencen en ≤3 días.
- **Todas las máquinas**: vista compacta ordenada por urgencia.

Clic en cualquier tarjeta abre un diálogo rápido:
- Botón grande **✓ Hecho** (fecha = hoy).
- Comentario opcional.
- Si hiciste el mantenimiento otro día, pulsa **"Cambiar fecha"**.
- Al confirmar, confirmación pantalla completa "✓ Registrado — Siguiente el X" durante 2,5 s.

### Historial

Pestaña **Historial** del menú:
- Filtros: máquina / operario / rango de fechas.
- Bloques colapsables por máquina con estadísticas (total, frecuencia real, configurada, último).
- Al expandir: gráfico de barras por mes + tabla de registros con fecha, operario y comentario.

También se puede ver el historial específico de una máquina desde el botón **"📜 Historial"** en su tarjeta (pestaña Máquinas).

### Máquinas

- Admin/Edición pueden crear, editar, eliminar máquinas.
- Todos pueden registrar mantenimientos y ver historial.

### Calendario

- Admin/Edición pueden añadir festivos (día único o rango completo).
- Todos pueden consultar.

### Usuarios (solo admin)

- Crear nuevos usuarios con rol.
- ⚠️ **Al crear un usuario, Firebase cambia la sesión a esa cuenta nueva**. Tendrás que cerrar sesión y volver a entrar como admin.

---

## 👥 Permisos

| Acción                                | Admin | Edición | Consulta |
|---------------------------------------|:-----:|:-------:|:--------:|
| Ver todo                              |   ✅   |    ✅    |    ✅     |
| Registrar mantenimiento               |   ✅   |    ✅    |    ✅     |
| Editar comentarios (propios y ajenos) |   ✅   |    ✅    |    ✅     |
| Borrar registros de historial         |   ✅   |    ❌    |    ❌     |
| Crear/editar/eliminar máquinas        |   ✅   |    ✅    |    ❌     |
| Editar calendario / festivos          |   ✅   |    ✅    |    ❌     |
| Gestionar usuarios                    |   ✅   |    ❌    |    ❌     |
| Cambiar responsable global / ajustes  |   ✅   |    ❌    |    ❌     |
| Exportar / borrar datos               |   ✅   |    ❌    |    ❌     |

---

## 📋 Modelo de datos en Firestore

```
users/{uid}             → { name, email, role, createdAt, createdBy }
machines/{id}           → { name, code, location, interval, lastMaintenance,
                            lastMaintenanceBy, lastMaintenanceByName,
                            lastMaintenanceNote, task, notes,
                            responsibleEmail, createdAt, createdBy }
  history/{timestamp}   → { date, by, byName, note, registeredAt,
                            editedBy, editedByName, editedAt }
holidays/{YYYY-MM-DD}   → { description }
settings/global         → { workWeekdays: [1,2,3,4,5],
                            globalResponsibleEmail, weeklyDay, weeklyHour }
sentNotifications/{id}  → { firma, sentAt, email, count }
```

---

## 💰 Costes

Gratis para un taller pequeño:

- **Firebase (plan Spark)**: 50 000 lecturas, 20 000 escrituras/día. Con 2-3 usuarios estarás <1 %.
- **Google Apps Script**: 100 emails/día (cuenta personal) o 1 500/día (Workspace).

---

## 🆘 Problemas frecuentes

**"Missing or insufficient permissions"** → Reglas de Firestore no publicadas. Revisa el paso 4.

**"auth/unauthorized-domain"** → Falta añadir tu dominio de GitHub Pages. Paso 8.

**"⚙ Configuración pendiente"** → Faltan credenciales en `firebase-config.js`. Paso 6.

**El script no envía emails** →
- Revisa que los dos triggers están activos (Apps Script → Activadores).
- Ejecuta `testEnvioEmail` manualmente.
- Mira los registros de ejecución para ver errores.

**Quiero re-enviar el email urgente hoy** → En Apps Script, ejecuta `resetearNotificaciones` para borrar el registro de envíos. El siguiente trigger volverá a evaluar y enviar.

**El resumen semanal no llega** → El script comprueba cada hora si es el día + hora configurados. Revisa en Ajustes que day/hour son correctos, y que el trigger de `enviarResumenSemanal` corre cada hora.

---

## Estructura del proyecto

```
sola-firebase/
├── index.html              ← Estructura de la app
├── app.js                  ← Lógica cliente
├── firebase-config.js      ← ⚠ Editar con tus credenciales
├── logo-sola.png           ← Logo
├── firestore-rules.txt     ← Reglas de seguridad
├── google-apps-script.gs   ← Script de emails automáticos
├── README.md               ← Este archivo
└── .gitignore
```

## Licencia

Uso libre. Adáptalo a las necesidades de SOLA.
