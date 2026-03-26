const express = require('express');
const router = express.Router();
const db = require('../config/db');

router.get('/', async (req, res, next) => {
  try {
    const [[kpi]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM proyectos WHERE estado <> 'Cerrado') AS obras_activas,
        (SELECT COUNT(*) FROM actividades WHERE estado IN ('Pendiente', 'En proceso', 'Observada')) AS tareas_abiertas,
        (SELECT COUNT(*) FROM actividades WHERE estado = 'Completada') AS tareas_completadas,
        (SELECT ROUND(AVG(avance_porcentaje), 2) FROM actividades) AS avance_promedio,
        (SELECT COUNT(*) FROM materiales WHERE stock_actual <= stock_minimo) AS materiales_criticos,
        (SELECT ROUND(SUM(monto), 2) FROM asientos_contables WHERE tipo = 'Egreso') AS egresos,
        (SELECT ROUND(SUM(monto), 2) FROM asientos_contables WHERE tipo = 'Ingreso') AS ingresos,
        (SELECT COUNT(*) FROM empleados WHERE estado = 'Activo') AS personal_activo
    `);

    const [estadoTareas] = await db.query(`
      SELECT estado, COUNT(*) AS total
      FROM actividades
      GROUP BY estado
      ORDER BY total DESC
    `);

    const [cumplidasPorDia] = await db.query(`
      SELECT DATE(fecha_actualizacion) AS fecha, COUNT(*) AS total
      FROM actividades
      WHERE estado = 'Completada'
      GROUP BY DATE(fecha_actualizacion)
      ORDER BY DATE(fecha_actualizacion)
      LIMIT 10
    `);

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
