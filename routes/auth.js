const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');

router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.render('auth/login', { layout: false, title: 'Iniciar sesion', error: null });
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const [[user]] = await db.query(`
      SELECT u.id, u.username, u.password, u.role, u.empleado_id, e.nombre AS empleado_nombre
      FROM users u
      LEFT JOIN empleados e ON e.id = u.empleado_id
      WHERE u.username = ? AND u.activo = 1
      LIMIT 1
    `, [username]);

    if (!user) {
      return res.status(401).render('auth/login', { layout: false, title: 'Iniciar sesion', error: 'Credenciales incorrectas.' });
    }

    // Compatibilidad: si la contraseña no esta hasheada aun, permitir login legado
    // y migrar automaticamente a bcrypt tras autenticacion exitosa.
    const isBcryptHash = typeof user.password === 'string' && /^\$2[aby]\$\d{2}\$/.test(user.password);
    let isValidPassword = false;

    if (isBcryptHash) {
      isValidPassword = await bcrypt.compare(password, user.password);
    } else {
      isValidPassword = password === user.password;
      if (isValidPassword) {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id]);
      }
    }

    if (!isValidPassword) {
      return res.status(401).render('auth/login', { layout: false, title: 'Iniciar sesion', error: 'Credenciales incorrectas.' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      empleado_id: user.empleado_id,
      nombre: user.empleado_nombre || user.username
    };
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* ── PERFIL ─────────────────────────────────────────────── */
router.get('/perfil', requireAuth, async (req, res, next) => {
  try {
    const [[user]] = await db.query(
      `SELECT u.username, e.nombre
       FROM users u
       LEFT JOIN empleados e ON e.id = u.empleado_id
       WHERE u.id = ? LIMIT 1`,
      [req.session.user.id]
    );
    res.render('auth/perfil', {
      title: 'Mi Perfil',
      userData: { username: user.username, nombre: user.nombre || req.session.user.nombre },
      success: null,
      error: null
    });
  } catch (err) { next(err); }
});

router.post('/perfil', requireAuth, async (req, res, next) => {
  try {
    const { nombre, username, password, password_confirm } = req.body;

    // Validaciones básicas
    if (!nombre || !nombre.trim() || !username || !username.trim()) {
      return res.render('auth/perfil', {
        title: 'Mi Perfil',
        userData: { nombre, username },
        success: null,
        error: 'El nombre y el usuario son obligatorios.'
      });
    }

    if (password && password.length < 6) {
      return res.render('auth/perfil', {
        title: 'Mi Perfil',
        userData: { nombre, username },
        success: null,
        error: 'La contraseña debe tener al menos 6 caracteres.'
      });
    }

    if (password && password !== password_confirm) {
      return res.render('auth/perfil', {
        title: 'Mi Perfil',
        userData: { nombre, username },
        success: null,
        error: 'Las contraseñas no coinciden.'
      });
    }

    // Verificar que el username no esté en uso por otro usuario
    const [[existing]] = await db.query(
      'SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1',
      [username.trim(), req.session.user.id]
    );
    if (existing) {
      return res.render('auth/perfil', {
        title: 'Mi Perfil',
        userData: { nombre, username },
        success: null,
        error: 'Ese nombre de usuario ya está en uso.'
      });
    }

    // Actualizar username en users
    await db.query(
      'UPDATE users SET username = ? WHERE id = ?',
      [username.trim(), req.session.user.id]
    );

    // Actualizar nombre en empleados si existe el registro
    if (req.session.user.empleado_id) {
      await db.query(
        'UPDATE empleados SET nombre = ? WHERE id = ?',
        [nombre.trim(), req.session.user.empleado_id]
      );
    }

    // Actualizar contraseña si se proporcionó
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.session.user.id]);
    }

    // Actualizar sesión
    req.session.user.nombre = nombre.trim();
    req.session.user.username = username.trim();

    res.render('auth/perfil', {
      title: 'Mi Perfil',
      userData: { nombre: nombre.trim(), username: username.trim() },
      success: 'Perfil actualizado correctamente.',
      error: null
    });
  } catch (err) { next(err); }
});

module.exports = router;
