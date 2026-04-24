rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function userRole() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role;
    }
    function isSignedIn() {
      return request.auth != null;
    }
    function isAdmin() {
      return isSignedIn() && userRole() == 'admin';
    }
    function isEditor() {
      return isSignedIn() && userRole() == 'editor';
    }
    function canManageMachines() {
      return isSignedIn() && (userRole() == 'admin' || userRole() == 'editor');
    }
    function hasUserDoc() {
      return isSignedIn() && exists(/databases/$(database)/documents/users/$(request.auth.uid));
    }
    function targetUserRole(userId) {
      return get(/databases/$(database)/documents/users/$(userId)).data.role;
    }

    // USUARIOS
    //  - Lectura: admin/editor leen todos; viewer lee solo el suyo.
    //  - Create:
    //    · BOOTSTRAP (primer admin): permitido si NO existe settings/global aún.
    //    · Admin puede crear cualquier usuario.
    //  - Update:
    //    · Admin puede actualizar cualquiera.
    //    · Editor puede actualizar usuarios NO-admin.
    //  - Delete: solo admin.
    match /users/{userId} {
      allow read: if isSignedIn() && (
        request.auth.uid == userId
        || isAdmin()
        || isEditor()
      );
      allow create: if isSignedIn() && (
        // Bootstrap inicial
        (request.auth.uid == userId
          && !exists(/databases/$(database)/documents/users/$(userId))
          && !exists(/databases/$(database)/documents/settings/global))
        || isAdmin()
      );
      allow update: if isSignedIn() && (
        isAdmin()
        || (isEditor()
            && targetUserRole(userId) != 'admin'
            && request.resource.data.role != 'admin')
      );
      allow delete: if isAdmin();
    }

    // MÁQUINAS
    //  - Lectura: todos con perfil
    //  - Crear/borrar/editar: admin o editor
    //  - Actualización parcial (campos de último mantenimiento): TODOS (incluido viewer)
    match /machines/{machineId} {
      allow read: if hasUserDoc();
      allow create, delete: if canManageMachines();
      allow update: if hasUserDoc() && (
        canManageMachines() ||
        // viewers solo pueden actualizar estos campos
        request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['lastMaintenance', 'lastMaintenanceBy', 'lastMaintenanceByName', 'lastMaintenanceNote'])
      );

      // SUBCOLECCIÓN HISTORIAL
      //  - Lectura: todos con perfil
      //  - Create (nuevo registro): todos con perfil
      //  - Update (editar comentario):
      //      · admin/editor: cualquier registro
      //      · viewer: solo sus propios registros (donde by == uid)
      //  - Delete: solo admin
      match /history/{historyId} {
        allow read: if hasUserDoc();
        allow create: if hasUserDoc();
        allow update: if hasUserDoc() && (
          canManageMachines()
          || resource.data.by == request.auth.uid
        );
        allow delete: if isAdmin();
      }
    }

    // FESTIVOS
    match /holidays/{date} {
      allow read: if hasUserDoc();
      allow write: if canManageMachines();
    }

    // AJUSTES
    //  - settings/global: lectura pública (para chequeo de primer setup).
    //    Escritura solo admin/editor.
    match /settings/{settingId} {
      allow read: if settingId == 'global' || hasUserDoc();
      allow write: if canManageMachines();
    }

    // NOTIFICACIONES ENVIADAS (gestionadas por Google Apps Script)
    match /sentNotifications/{notifId} {
      allow read: if hasUserDoc();
      allow write: if isAdmin();
    }
  }
}

