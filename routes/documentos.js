const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

const uploadDir = path.join(__dirname, '..', 'uploads', 'documentos');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path.basename(file.originalname || 'documento', ext)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'documento';
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    if (allowed.has(file.mimetype)) return cb(null, true);
    cb(new Error('Solo se permiten archivos PDF, JPG, PNG o WEBP.'));
  }
});

async function getCurrentUserProjectId(userId) {
  const [[row]] = await db.query(
    `SELECT e.proyecto_id
     FROM users u
     LEFT JOIN empleados e ON e.id = u.empleado_id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  return row?.proyecto_id ? Number(row.proyecto_id) : null;
}

router.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.session?.user?.role === 'admin';
    const userProjectId = isAdmin ? null : await getCurrentUserProjectId(req.session.user.id);
    const canManage = isAdmin || !!userProjectId;
    const { proyecto_id, tipo, q, desde, hasta, edit } = req.query;
    const [proyectos] = isAdmin
      ? await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre')
      : await db.query('SELECT id, nombre FROM proyectos WHERE id = ? ORDER BY nombre', [userProjectId || 0]);
    const where = [];
    const params = [];

    if (!isAdmin) {
      if (!userProjectId) {
        return res.status(403).render('partials/error', {
          title: 'Acceso denegado',
          error: 'Tu usuario no tiene un proyecto asignado para gestionar documentos.'
        });
      }
      where.push('d.proyecto_id = ?');
      params.push(userProjectId);
    } else if (proyecto_id) {
      where.push('d.proyecto_id = ?');
      params.push(proyecto_id);
    }
    if (tipo && String(tipo).trim()) {
      where.push('d.tipo LIKE ?');
      params.push(`%${String(tipo).trim()}%`);
    }
    if (q && String(q).trim()) {
      where.push('(d.titulo LIKE ? OR d.responsable LIKE ? OR p.nombre LIKE ?)');
      const term = `%${String(q).trim()}%`;
      params.push(term, term, term);
    }
    if (desde) {
      where.push('d.fecha_documento >= ?');
      params.push(desde);
    }
    if (hasta) {
      where.push('d.fecha_documento <= ?');
      params.push(hasta);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [documentos] = await db.query(`
      SELECT d.*, p.nombre AS proyecto,
             u_doc.role AS creado_por_role,
             u_doc.username AS creado_por_username
      FROM documentos d
      LEFT JOIN proyectos p ON p.id = d.proyecto_id
      LEFT JOIN users u_doc ON u_doc.id = d.created_by_user_id
      ${whereSql}
      ORDER BY d.fecha_documento DESC, d.id DESC
    `, params);

    const documentosConPermisos = documentos.map((d) => ({
      ...d,
      puedeEliminarOperador: Boolean(d.created_by_user_id) && d.creado_por_role !== 'admin'
    }));

    let editDocumento = null;
    if (edit && canManage) {
      const editWhere = isAdmin ? 'WHERE d.id = ?' : 'WHERE d.id = ? AND d.proyecto_id = ?';
      const editParams = isAdmin ? [edit] : [edit, userProjectId];
      const [[doc]] = await db.query(`
        SELECT d.*, u_doc.role AS creado_por_role
        FROM documentos d
        LEFT JOIN users u_doc ON u_doc.id = d.created_by_user_id
        ${editWhere}
        LIMIT 1
      `, editParams);
      editDocumento = doc || null;
    }

    res.render('documentos/index', {
      title: 'Informes y Documentos',
      documentos: documentosConPermisos,
      proyectos,
      editDocumento,
      isAdmin,
      canManage,
      filtros: {
        proyecto_id: isAdmin ? (proyecto_id || '') : String(userProjectId || ''),
        tipo: tipo || '',
        q: q || '',
        desde: desde || '',
        hasta: hasta || ''
      }
    });
  } catch (error) { next(error); }
});

router.post('/', requireRole('admin', 'usuario'), upload.single('archivo'), async (req, res, next) => {
  try {
    const isAdmin = req.session?.user?.role === 'admin';
    const userProjectId = isAdmin ? null : await getCurrentUserProjectId(req.session.user.id);
    if (!isAdmin && !userProjectId) {
      return res.status(403).render('partials/error', {
        title: 'Acceso denegado',
        error: 'Tu usuario no tiene un proyecto asignado para registrar documentos.'
      });
    }

    const { proyecto_id, tipo, titulo, responsable, fecha_documento, url_referencia } = req.body;
    const finalProyectoId = isAdmin ? (proyecto_id || null) : userProjectId;
    const referenciaFinal = req.file
      ? `/uploads/documentos/${req.file.filename}`
      : (url_referencia || '').trim() || null;

    await db.query(
      'INSERT INTO documentos (proyecto_id, tipo, titulo, responsable, fecha_documento, url_referencia, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [finalProyectoId, tipo, titulo, responsable, fecha_documento, referenciaFinal, req.session.user.id]
    );
    res.redirect('/documentos');
  } catch (error) { next(error); }
});

router.put('/:id', requireRole('admin', 'usuario'), upload.single('archivo'), async (req, res, next) => {
  try {
    const isAdmin = req.session?.user?.role === 'admin';
    const userProjectId = isAdmin ? null : await getCurrentUserProjectId(req.session.user.id);
    const { id } = req.params;
    const { proyecto_id, tipo, titulo, responsable, fecha_documento, url_referencia, mantener_referencia } = req.body;

    const [[actual]] = await db.query('SELECT id, proyecto_id, url_referencia FROM documentos WHERE id = ? LIMIT 1', [id]);
    if (!actual) return res.status(404).render('partials/error', { title: 'No encontrado', error: 'Documento no encontrado.' });
    if (!isAdmin) {
      if (!userProjectId || Number(actual.proyecto_id || 0) !== Number(userProjectId)) {
        return res.status(403).render('partials/error', {
          title: 'Acceso denegado',
          error: 'Solo puedes editar documentos de tu proyecto asignado.'
        });
      }
    }

    const finalProyectoId = isAdmin ? (proyecto_id || null) : userProjectId;

    const hasNewUrl = !!((url_referencia || '').trim());
    let referenciaFinal = null;

    if (req.file) {
      referenciaFinal = `/uploads/documentos/${req.file.filename}`;
      if (actual.url_referencia && actual.url_referencia.startsWith('/uploads/documentos/')) {
        const oldPath = path.join(__dirname, '..', actual.url_referencia.replace(/^\/+/, ''));
        fs.unlink(oldPath, () => {});
      }
    } else if (hasNewUrl) {
      referenciaFinal = (url_referencia || '').trim();
      if (actual.url_referencia && actual.url_referencia.startsWith('/uploads/documentos/')) {
        const oldPath = path.join(__dirname, '..', actual.url_referencia.replace(/^\/+/, ''));
        fs.unlink(oldPath, () => {});
      }
    } else if (String(mantener_referencia || '1') === '1') {
      referenciaFinal = actual.url_referencia || null;
    }

    await db.query(
      'UPDATE documentos SET proyecto_id = ?, tipo = ?, titulo = ?, responsable = ?, fecha_documento = ?, url_referencia = ? WHERE id = ?',
      [finalProyectoId, tipo, titulo, responsable, fecha_documento, referenciaFinal, id]
    );

    res.redirect('/documentos');
  } catch (error) { next(error); }
});

router.delete('/:id', requireRole('admin', 'usuario'), async (req, res, next) => {
  try {
    const isAdmin = req.session?.user?.role === 'admin';
    const userProjectId = isAdmin ? null : await getCurrentUserProjectId(req.session.user.id);
    const { id } = req.params;
    const [[actual]] = await db.query(`
      SELECT d.id, d.proyecto_id, d.url_referencia, d.created_by_user_id, u_doc.role AS creado_por_role
      FROM documentos d
      LEFT JOIN users u_doc ON u_doc.id = d.created_by_user_id
      WHERE d.id = ?
      LIMIT 1
    `, [id]);
    if (!actual) return res.redirect('/documentos');

    if (!isAdmin) {
      if (!userProjectId || Number(actual.proyecto_id || 0) !== Number(userProjectId)) {
        return res.status(403).render('partials/error', {
          title: 'Acceso denegado',
          error: 'Solo puedes eliminar documentos de tu proyecto asignado.'
        });
      }

      if (!actual.created_by_user_id || actual.creado_por_role === 'admin') {
        return res.status(403).render('partials/error', {
          title: 'Acceso denegado',
          error: 'No puedes eliminar documentos registrados por administradores.'
        });
      }
    }

    if (actual.url_referencia && actual.url_referencia.startsWith('/uploads/documentos/')) {
      const oldPath = path.join(__dirname, '..', actual.url_referencia.replace(/^\/+/, ''));
      fs.unlink(oldPath, () => {});
    }

    await db.query('DELETE FROM documentos WHERE id = ?', [id]);
    res.redirect('/documentos');
  } catch (error) { next(error); }
});

module.exports = router;
