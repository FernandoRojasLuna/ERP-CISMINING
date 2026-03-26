const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    const [obras] = await db.query(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM actividades a WHERE a.proyecto_id = p.id) AS total_actividades,
        (SELECT ROUND(AVG(a.avance_porcentaje), 2) FROM actividades a WHERE a.proyecto_id = p.id) AS avance_real
      FROM proyectos p
      ORDER BY p.id DESC
    `);
    res.render('obras/index', { title: 'Obras y Proyectos', obras });
  } catch (error) { next(error); }
});

router.get('/nuevo', requireRole('admin'), (req, res) => {
  res.render('obras/form', { title: 'Nueva obra', obra: {} });
});

router.get('/:id/editar', requireRole('admin'), async (req, res, next) => {
  try {
    const [[obra]] = await db.query('SELECT * FROM proyectos WHERE id = ?', [req.params.id]);
    if (!obra) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'La obra no existe.'
      });
    }
    res.render('obras/form', { title: 'Editar obra', obra });
  } catch (error) { next(error); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { nombre, cliente, ubicacion, fecha_inicio, fecha_fin, presupuesto, estado } = req.body;
    await db.query(
      'INSERT INTO proyectos (nombre, cliente, ubicacion, fecha_inicio, fecha_fin, presupuesto, estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nombre, cliente, ubicacion, fecha_inicio, fecha_fin, presupuesto || 0, estado]
    );
    res.redirect('/obras');
  } catch (error) { next(error); }
});

router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { nombre, cliente, ubicacion, fecha_inicio, fecha_fin, presupuesto, estado } = req.body;
    const [result] = await db.query(
      'UPDATE proyectos SET nombre = ?, cliente = ?, ubicacion = ?, fecha_inicio = ?, fecha_fin = ?, presupuesto = ?, estado = ? WHERE id = ?',
      [nombre, cliente, ubicacion, fecha_inicio, fecha_fin, presupuesto || 0, estado, req.params.id]
    );

    if (!result.affectedRows) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'La obra no existe.'
      });
    }

    res.redirect('/obras');
  } catch (error) { next(error); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const [result] = await db.query('DELETE FROM proyectos WHERE id = ?', [req.params.id]);

    if (!result.affectedRows) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'La obra no existe.'
      });
    }

    res.redirect('/obras');
  } catch (error) { next(error); }
});

module.exports = router;
