const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

let normalizedOnce = false;

function pad(num, size) {
  return String(num).padStart(size, '0');
}

function formatActividadCodigo(seq) {
  return `ACT-${pad(seq, 8)}`;
}

function formatPartida(proyectoId, seq) {
  return `${pad(proyectoId, 3)}-${pad(seq, 8)}`;
}

async function getNextActividadCodigo(conn = db) {
  const [[row]] = await conn.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(codigo, 5) AS UNSIGNED)), 0) AS max_seq
    FROM actividades
    WHERE codigo REGEXP '^ACT-[0-9]{8}$'
  `);
  return formatActividadCodigo(Number(row?.max_seq || 0) + 1);
}

async function getNextPartida(proyectoId, conn = db) {
  const prefijo = pad(proyectoId, 3);
  const [[row]] = await conn.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(partida, 5) AS UNSIGNED)), 0) AS max_seq
    FROM actividades
    WHERE proyecto_id = ?
      AND partida REGEXP '^[0-9]{3}-[0-9]{8}$'
      AND LEFT(partida, 3) = ?
  `, [proyectoId, prefijo]);
  return formatPartida(proyectoId, Number(row?.max_seq || 0) + 1);
}

async function normalizeLegacyActividades() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT id, proyecto_id FROM actividades ORDER BY id ASC');
    if (!rows.length) {
      await conn.commit();
      return;
    }

    // Paso 1: mover temporalmente todos los codigos para evitar choques de UNIQUE.
    for (const row of rows) {
      await conn.query('UPDATE actividades SET codigo = ? WHERE id = ?', [`TMP-${row.id}`, row.id]);
    }

    // Paso 2: asignar codigo correlativo global ACT-00000001, ACT-00000002...
    for (let i = 0; i < rows.length; i += 1) {
      await conn.query('UPDATE actividades SET codigo = ? WHERE id = ?', [formatActividadCodigo(i + 1), rows[i].id]);
    }

    // Paso 3: asignar partida correlativa por proyecto (001-00000001, 001-00000002...)
    const seqPorProyecto = new Map();
    for (const row of rows) {
      const proyectoId = Number(row.proyecto_id || 0);
      const actual = seqPorProyecto.get(proyectoId) || 0;
      const siguiente = actual + 1;
      seqPorProyecto.set(proyectoId, siguiente);
      await conn.query('UPDATE actividades SET partida = ? WHERE id = ?', [formatPartida(proyectoId, siguiente), row.id]);
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function catalogos() {
  const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
  const [empleados] = await db.query("SELECT id, nombre FROM empleados WHERE estado='Activo' ORDER BY nombre");
  return { proyectos, empleados };
}

router.get('/', async (req, res, next) => {
  try {
    if (!normalizedOnce) {
      await normalizeLegacyActividades();
      normalizedOnce = true;
    }

    const esUsuario = req.session.user.role === 'usuario';
    const empleadoId = req.session.user.empleado_id || 0;
    const proyectoId = Number(req.query.proyecto_id || 0);
    const codigo = String(req.query.codigo || '').trim();

    const [proyectos] = await db.query(`
      SELECT DISTINCT x.id, x.nombre
      FROM (
        SELECT p.id, p.nombre
        FROM proyectos p

        UNION

        SELECT a.proyecto_id AS id,
               COALESCE(p2.nombre, CONCAT('Proyecto #', a.proyecto_id)) AS nombre
        FROM actividades a
        LEFT JOIN proyectos p2 ON p2.id = a.proyecto_id
        WHERE a.proyecto_id IS NOT NULL
      ) x
      WHERE x.id IS NOT NULL
      ORDER BY x.nombre ASC
    `);

    const [actividades] = await db.query(`
      SELECT a.*, p.nombre AS proyecto, e.nombre AS responsable
      FROM actividades a
      LEFT JOIN proyectos p ON p.id = a.proyecto_id
      LEFT JOIN empleados e ON e.id = a.responsable_id
      WHERE (? = 0 OR a.responsable_id = ?)
        AND (? = 0 OR a.proyecto_id = ?)
        AND (? = '' OR UPPER(a.codigo) LIKE CONCAT('%', UPPER(?), '%'))
      ORDER BY
        COALESCE(p.nombre, 'ZZZ') ASC,
        a.proyecto_id ASC,
        a.fecha_fin_programada IS NULL ASC,
        a.fecha_fin_programada ASC,
        a.id ASC
    `, [
      esUsuario ? empleadoId : 0,
      esUsuario ? empleadoId : 0,
      proyectoId,
      proyectoId,
      codigo,
      codigo
    ]);

    res.render('actividades/index', {
      title: 'Actividades de Obra',
      actividades,
      proyectos,
      filtros: {
        proyecto_id: proyectoId,
        codigo
      }
    });
  } catch (error) { next(error); }
});

router.get('/nuevo', requireRole('admin'), async (req, res, next) => {
  try {
    const data = await catalogos();
    const actividad = {
      codigo: await getNextActividadCodigo(),
      partida: ''
    };
    res.render('actividades/form', { title: 'Nueva actividad', actividad, ...data });
  } catch (error) { next(error); }
});

router.get('/:id/editar', requireRole('admin'), async (req, res, next) => {
  try {
    const data = await catalogos();
    const [[actividad]] = await db.query('SELECT * FROM actividades WHERE id = ?', [req.params.id]);
    if (!actividad) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'La actividad no existe.'
      });
    }
    res.render('actividades/form', { title: 'Editar actividad', actividad, ...data });
  } catch (error) { next(error); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const {
      codigo, nombre, descripcion, proyecto_id, responsable_id, prioridad, estado,
      fecha_inicio_programada, fecha_fin_programada, avance_porcentaje, partida, unidad_meta, meta_cantidad
    } = req.body;

    const proyectoId = Number(proyecto_id);
    const codigoFinal = (codigo || '').trim() || await getNextActividadCodigo();
    const partidaFinal = (partida || '').trim() || await getNextPartida(proyectoId);

    await db.query(`
      INSERT INTO actividades (
        codigo, nombre, descripcion, proyecto_id, responsable_id, prioridad, estado,
        fecha_inicio_programada, fecha_fin_programada, avance_porcentaje, partida, unidad_meta, meta_cantidad, fecha_actualizacion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [codigoFinal, nombre, descripcion, proyectoId, responsable_id || null, prioridad, estado, fecha_inicio_programada || null, fecha_fin_programada || null, avance_porcentaje || 0, partidaFinal, unidad_meta || null, meta_cantidad || 0]);
    res.redirect('/actividades');
  } catch (error) { next(error); }
});

router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const {
      codigo, nombre, descripcion, proyecto_id, responsable_id, prioridad, estado,
      fecha_inicio_programada, fecha_fin_programada, avance_porcentaje, partida, unidad_meta, meta_cantidad
    } = req.body;

    const proyectoId = Number(proyecto_id);
    const [[actual]] = await db.query('SELECT * FROM actividades WHERE id = ?', [req.params.id]);
    if (!actual) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'La actividad no existe.'
      });
    }

    const codigoFinal = (codigo || '').trim() || actual.codigo || await getNextActividadCodigo();
    const partidaFinal = (partida || '').trim() || actual.partida || await getNextPartida(proyectoId);

    await db.query(`
      UPDATE actividades
      SET codigo = ?, nombre = ?, descripcion = ?, proyecto_id = ?, responsable_id = ?, prioridad = ?, estado = ?,
          fecha_inicio_programada = ?, fecha_fin_programada = ?, avance_porcentaje = ?, partida = ?,
          unidad_meta = ?, meta_cantidad = ?, fecha_actualizacion = NOW()
      WHERE id = ?
    `, [
      codigoFinal,
      nombre,
      descripcion,
      proyectoId,
      responsable_id || null,
      prioridad,
      estado,
      fecha_inicio_programada || null,
      fecha_fin_programada || null,
      avance_porcentaje || 0,
      partidaFinal,
      unidad_meta || null,
      meta_cantidad || 0,
      req.params.id
    ]);

    res.redirect('/actividades');
  } catch (error) { next(error); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const [result] = await db.query('DELETE FROM actividades WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'La actividad no existe.'
      });
    }
    res.redirect('/actividades');
  } catch (error) { next(error); }
});

router.post('/:id/estado', async (req, res, next) => {
  try {
    const { estado, avance_porcentaje } = req.body;
    const esUsuario = req.session.user.role === 'usuario';
    const empleadoId = req.session.user.empleado_id || 0;
    await db.query('UPDATE actividades SET estado=?, avance_porcentaje=?, fecha_actualizacion=NOW() WHERE id=? AND (? = 0 OR responsable_id = ?)', [estado, avance_porcentaje || 0, req.params.id, esUsuario ? empleadoId : 0, esUsuario ? empleadoId : 0]);
    res.redirect('/actividades');
  } catch (error) { next(error); }
});

module.exports = router;
