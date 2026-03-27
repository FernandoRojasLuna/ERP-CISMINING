const express = require('express');
const router = express.Router();
const db = require('../config/db');

const COMPLETED_STATES = ['COMPLETADA', 'COMPLETADO', 'FINALIZADA', 'FINALIZADO', 'TERMINADA', 'TERMINADO'];

function toDateKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildLastDaysSeries(rows, days = 10) {
  const map = new Map();
  rows.forEach((row) => {
    const key = toDateKey(row.fecha);
    if (!key) return;
    map.set(key, Number(row.total || 0));
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = toDateKey(d);
    series.push({
      fecha: key,
      total: map.get(key) || 0
    });
  }

  return series;
}

router.get('/', async (req, res, next) => {
  try {
    const [[kpi]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM proyectos WHERE estado <> 'Cerrado') AS obras_activas,
        (SELECT COUNT(*) FROM actividades WHERE estado IN ('Pendiente', 'En proceso', 'Observada')) AS tareas_abiertas,
        (SELECT COUNT(*) FROM actividades WHERE UPPER(TRIM(COALESCE(estado, ''))) IN (?) OR COALESCE(avance_porcentaje, 0) >= 100) AS tareas_completadas,
        (SELECT ROUND(AVG(avance_porcentaje), 2) FROM actividades) AS avance_promedio,
        (SELECT COUNT(*) FROM materiales WHERE stock_actual <= stock_minimo) AS materiales_criticos,
        (SELECT ROUND(SUM(monto), 2) FROM asientos_contables WHERE tipo = 'Egreso') AS egresos,
        (SELECT ROUND(SUM(monto), 2) FROM asientos_contables WHERE tipo = 'Ingreso') AS ingresos,
        (SELECT COUNT(*) FROM empleados WHERE estado = 'Activo') AS personal_activo
    `, [COMPLETED_STATES]);

    const [estadoTareas] = await db.query(`
      SELECT estado, COUNT(*) AS total
      FROM actividades
      GROUP BY estado
      ORDER BY total DESC
    `);

    const [cumplidasPorDiaRaw] = await db.query(`
      SELECT DATE(COALESCE(fecha_actualizacion, fecha_fin_programada)) AS fecha, COUNT(*) AS total
      FROM actividades
      WHERE (UPPER(TRIM(COALESCE(estado, ''))) IN (?) OR COALESCE(avance_porcentaje, 0) >= 100)
        AND COALESCE(fecha_actualizacion, fecha_fin_programada) IS NOT NULL
      GROUP BY DATE(COALESCE(fecha_actualizacion, fecha_fin_programada))
      ORDER BY DATE(COALESCE(fecha_actualizacion, fecha_fin_programada)) DESC
      LIMIT 10
    `, [COMPLETED_STATES]);

    const cumplidasPorDia = buildLastDaysSeries(cumplidasPorDiaRaw, 10);

    const [stockCritico] = await db.query(`
      SELECT codigo, nombre, unidad, stock_actual, stock_minimo
      FROM materiales
      WHERE stock_actual <= stock_minimo
      ORDER BY stock_actual ASC
      LIMIT 5
    `);

    const [ultimasActividades] = await db.query(`
      SELECT a.id, a.codigo, a.nombre, a.estado, a.avance_porcentaje, p.nombre AS proyecto, e.nombre AS responsable
      FROM actividades a
      LEFT JOIN proyectos p ON p.id = a.proyecto_id
      LEFT JOIN empleados e ON e.id = a.responsable_id
      ORDER BY a.fecha_actualizacion DESC
      LIMIT 8
    `);

    res.render('dashboard/index', {
      title: 'Dashboard Ejecutivo',
      kpi,
      estadoTareas,
      cumplidasPorDia,
      stockCritico,
      ultimasActividades
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
