# 🔐 CRUD Usuarios - Guía de Implementación

## 📋 Cambios Implementados

### ✅ 1. Seguridad - Contraseñas con Bcrypt
Se ha implementado **encriptación segura de contraseñas** con bcrypt en lugar de texto plano:
- ✓ Las nuevas contraseñas se hashean automáticamente
- ✓ El login verifica contraseñas hashadas
- ✓ Script de migración para contraseñas existentes

### ✅ 2. CRUD Completo de Usuarios
El modulo de RRHH ahora permite a los admins:
- ✅ **CREATE** (POST): Crear nuevos usuarios con validación
- ✅ **READ** (GET): Listar todos los usuarios del sistema
- ✅ **UPDATE** (PUT): Editar rol, estado y empleado asociado
- ✅ **PATCH**: Cambiar contraseña de usuarios
- ✅ **DELETE**: Desactivar usuarios (soft delete)

### ✅ 3. Validaciones
Se agregó validación robusta:
- Nombre de usuario único (3+ caracteres, alfanumérico)
- Contraseñas mínimo 6 caracteres
- Roles válidos: `admin` o `usuario`
- Sin eliminar usuarios (se desactivan para auditoría)

### ✅ 4. Vistas Mejoradas
- Tabla de usuarios con estados y roles
- Formulario para crear/editar usuarios
- Modal para cambiar contraseña de usuarios existentes
- Mensajes de éxito/error

---

## 🚀 Instalación

### Paso 1: Instalar Dependencias
```bash
npm install bcrypt express-validator
```

### Paso 2: Migrar Contraseñas Existentes (IMPORTANTE)
Si tienes contraseñas en texto plano, migralas a bcrypt:
```bash
node scripts/migrate-passwords.js
```

⚠️ **Esto se debe hacer UNA SOLA VEZ**

### Paso 3: Probar el Sistema
1. Inicia el servidor: `npm start`
2. Accede a `/login` e intenta iniciar sesión
3. Como admin, ve a `/rrhh` y gestiona usuarios

---

## 📊 Cambios en la Base de Datos

### Tabla: `users`
```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(60) NOT NULL UNIQUE,
  password VARCHAR(120) NOT NULL,           -- Ahora contiene hash bcrypt
  role ENUM('admin','usuario') NOT NULL,
  empleado_id INT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (empleado_id) REFERENCES empleados(id)
);
```

NO se necesitan cambios en la estructura existente.

---

## 🔄 Flujo de Usuarios

### Crear Usuario (Admin)
```
GET  /rrhh/usuarios/nuevo
  ↓
POST /rrhh/usuarios
  ├─ Validar formato
  ├─ Hashear contraseña con bcrypt
  ├─ Insertar en BD
  └─ Redirigir a /rrhh
```

### Editar Usuario (Admin)
```
GET  /rrhh/usuarios/:id/editar
  ↓
PUT  /rrhh/usuarios/:id
  ├─ Validar datos
  ├─ Actualizar rol, estado, empleado
  └─ Redirigir
```

### Cambiar Contraseña (Admin)
```
PATCH /rrhh/usuarios/:id/cambiar-contraseña
  ├─ Validar nueva contraseña
  ├─ Hashear con bcrypt
  ├─ Actualizar en BD
  └─ Responder JSON
```

### Eliminar Usuario (Admin)
```
DELETE /rrhh/usuarios/:id
  ├─ Verificar que no sea el usuario actual
  ├─ Desactivar usuario (UPDATE activo = 0)
  └─ Responder JSON
```

### Login (Todos)
```
POST /login
  ├─ Buscar usuario por username
  ├─ Comparar contraseña con bcrypt.compare()
  ├─ Crear sesión si es correcta
  └─ Redirigir a dashboard
```

---

## 📝 Endpoints RRHH

```
GET    /rrhh                         # Dashboard RRHH (lista usuarios)
GET    /rrhh/usuarios/nuevo          # Formulario nuevo usuario
POST   /rrhh/usuarios                # Crear nuevo usuario
GET    /rrhh/usuarios/:id/editar    # Formulario editar usuario
PUT    /rrhh/usuarios/:id            # Actualizar usuario
PATCH  /rrhh/usuarios/:id/cambiar-contraseña  # Cambiar contraseña
DELETE /rrhh/usuarios/:id            # Desactivar usuario
```

---

## 🔍 Middleware de Autenticación

### requireRole(roles...)
Protege rutas verificando:
1. Que el usuario esté autenticado (sesión válida)
2. Que tenga el rol requerido

```javascript
// Solo admins pueden acceder
router.get('/rrhh', requireRole('admin'), ...)

// Admins o usuarios específicos
router.post('/solicitud', requireRole('admin', 'supervisor'), ...)
```

---

## 🛡️ Mejoras de Seguridad

✅ **Contraseñas Hashadas**
- Usa bcrypt con salt rounds = 10
- Imposible recuperar la contraseña original
- Resistente a ataques de fuerza bruta

✅ **Validación de Entrada**
- express-validator previene inyecciones
- Formatos estrictamente validados
- Mensajes de error informativos

✅ **Soft Deletes**
- No se borran usuarios, se desactivan
- Permite auditoría y recuperación
- El campo `activo` controla acceso

✅ **Prevención de Auto-Eliminación**
- Un admin no puede desactivarse a sí mismo
- Evita bloqueos accidentales del sistema

---

## 📚 Datos de Prueba

Después de migrar contraseñas, puedes crear usuarios así:

```bash
# Usuario: admin, Contraseña: admin@123
# Rol: admin

# Usuario: operario, Contraseña: work@2024
# Rol: usuario
```

---

## 🐛 Solución de Problemas

### "Credenciales incorrectas" al iniciar sesión
**Causa**: Contraseña todavía en texto plano
**Solución**: Ejecutar migración: `node scripts/migrate-passwords.js`

### No aparecen opciones de roles
**Causa**: Falta express-validator
**Solución**: `npm install express-validator`

### Usuarios desactivados reaparece activos
**Causa**: Se fue el valor `activo` en PUT
**Solución**: El código ahora valida automáticamente

---

## 📖 Archivos Modificados

```
✏️  routes/rrhh.js                    # CRUD de usuarios
✏️  routes/auth.js                    # Login con bcrypt
✏️  views/rrhh/index.ejs              # Tabla de usuarios
✨  views/rrhh/form.ejs               # Formulario crear/editar
✨  scripts/migrate-passwords.js       # Migración bcrypt
```

---

## 🚀 Próximas Mejoras (Sugeridas)

- [ ] Recuperación de contraseña por email
- [ ] 2FA (Autenticación de dos factores)
- [ ] Auditoría de cambios de usuarios
- [ ] Bloqueo después de N intentos fallidos
- [ ] Sistema de permisos más granular

---

**¡Implementación completada exitosamente! 🎉**
