// ============================================================
// CONFIGURACIÓN DE FIREBASE
// ============================================================
//
// INSTRUCCIONES:
// 1. Ve a https://console.firebase.google.com/
// 2. Crea un proyecto nuevo (ej. "sola-mantenimiento")
// 3. En "Project settings" → "General" → baja a "Your apps"
// 4. Pulsa el icono "</>" (Web) para añadir una app web
// 5. Copia los valores del objeto `firebaseConfig` y pégalos abajo
// 6. Activa "Authentication" → método "Email/Password"
// 7. Activa "Firestore Database" en modo producción
// 8. Copia las reglas de seguridad del README.md
//
// Consulta el README.md para la guía completa paso a paso.
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyBZVnHo6myhhZxZG-n0ZU1NaNLq6KhEb8E",
  authDomain: "mantenimiento-sola.firebaseapp.com",
  projectId: "mantenimiento-sola",
  storageBucket: "mantenimiento-sola.firebasestorage.app",
  messagingSenderId: "674682939400",
  appId: "1:674682939400:web:4e760f2b332399de8649bd"
};

// No modifiques nada más debajo de esta línea
// ────────────────────────────────────────────────────────────

export const CONFIG_IS_VALID = firebaseConfig.apiKey !== "PEGA-AQUÍ-TU-API-KEY"
  && firebaseConfig.projectId !== "tu-proyecto";
