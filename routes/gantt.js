const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

function daysBetween(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

router.get('/', async (req, res, next) => {
  try {
    const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
    const proyectoId = Number(req.query.proyecto_id || proyectos[0]?.id || 0);
    const [tareas] = await db.query(`
      SELECT g.*, p.nombre AS proyecto, e.nombre AS responsable
      FROM gantt_tareas g
      JOIN proyectos p ON p.id = g.proyecto_id
      LEFT JOIN empleados e ON e.id = g.responsable_id
      WHERE (? = 0 OR g.proyecto_id = ?)
      ORDER BY g.fecha_inicio ASC, g.id ASC
    `, [proyectoId, proyectoId]);

    let timelineStart = null;
    let timelineEnd = null;
    for (const tarea of tareas) {
      if (!timelineStart || new Date(tarea.fecha_inicio) < timelineStart) timelineStart = new Date(tarea.fecha_inicio);
      if (!timelineEnd || new Date(tarea.fecha_fin) > timelineEnd) timelineEnd = new Date(tarea.fecha_fin);
    }
    timelineStart = timelineStart || new Date();
    timelineEnd = timelineEnd || new Date();
    const totalDays = daysBetween(timelineStart, timelineEnd);

    const ganttItems = tareas.map((t) => {
      const offset = daysBetween(timelineStart, t.fecha_inicio) - 1;
      const duration = daysBetween(t.fecha_inicio, t.fecha_fin);
      return {
        ...t,
        offsetPct: (offset / totalDays) * 100,
        widthPct: (duration / totalDays) * 100
      };
    });

    const [empleados] = await db.query("SELECT id, nombre FROM empleados WHERE estado='Activo' ORDER BY nombre");
    res.render('gantt/index', {
      title: 'Planeamiento Gantt',
      proyectos,
      empleados,
      ganttItems,
      proyectoId,
      totalDays,
      timelineStart,
      timelineEnd
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { proyecto_id, nombre, responsable_id, fecha_inicio, fecha_fin, avance, estado } = req.body;
    await db.query(`
      INSERT INTO gantt_tareas (proyecto_id, nombre, responsable_id, fecha_inicio, fecha_fin, avance, estado)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [proyecto_id, nombre, responsable_id || null, fecha_inicio, fecha_fin, avance || 0, estado || 'Programada']);
    res.redirect(`/gantt?proyecto_id=${proyecto_id}`);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { proyecto_id, nombre, responsable_id, fecha_inicio, fecha_fin, avance, estado } = req.body;
    const [result] = await db.query(`
      UPDATE gantt_tareas 
      SET proyecto_id = ?, nombre = ?, responsable_id = ?, fecha_inicio = ?, fecha_fin = ?, avance = ?, estado = ?
      WHERE id = ?
    `, [proyecto_id, nombre, responsable_id || null, fecha_inicio, fecha_fin, avance, estado, req.params.id]);

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'La tarea no existe.' });
    }

    res.json({ success: true, message: 'Tarea actualizada correctamente.' });
  } catch (error) { next(error); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const [result] = await db.query('DELETE FROM gantt_tareas WHERE id = ?', [req.params.id]);

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'La tarea no existe.' });
    }

    res.json({ success: true, message: 'Tarea eliminada correctamente.' });
  } catch (error) { next(error); }
});

module.exports = router;
