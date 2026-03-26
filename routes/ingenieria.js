const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

const concreteDosages = {
  '175': { cemento: 7.0, arena: 0.56, grava: 0.84, agua: 190 },
  '210': { cemento: 8.5, arena: 0.53, grava: 0.81, agua: 195 },
  '280': { cemento: 10.0, arena: 0.49, grava: 0.78, agua: 200 }
};

router.get('/', async (req, res, next) => {
  try {
    const proyectoId = Number(req.query.proyecto_id || 0);
    const partida = String(req.query.partida || '').trim();
    const editarPartidaId = Number(req.query.editar_partida_id || 0);

    const [proyectos] = await db.query(`
      SELECT DISTINCT x.id, x.nombre
      FROM (
        SELECT p.id, p.nombre
        FROM proyectos p

        UNION

        SELECT i.proyecto_id AS id,
               COALESCE(p2.nombre, CONCAT('Proyecto #', i.proyecto_id)) AS nombre
        FROM partidas_ingenieria i
        LEFT JOIN proyectos p2 ON p2.id = i.proyecto_id
        WHERE i.proyecto_id IS NOT NULL
      ) x
      WHERE x.id IS NOT NULL
      ORDER BY x.nombre ASC
    `);

    const [partidas] = await db.query(`
      SELECT p.nombre AS proyecto, i.*
      FROM partidas_ingenieria i
      LEFT JOIN proyectos p ON p.id = i.proyecto_id
      WHERE (? = 0 OR i.proyecto_id = ?)
        AND (? = '' OR UPPER(i.nombre) LIKE CONCAT('%', UPPER(?), '%'))
      ORDER BY COALESCE(p.nombre, 'ZZZ') ASC, i.id DESC
    `, [proyectoId, proyectoId, partida, partida]);

    let partidaEdit = null;
    if (editarPartidaId) {
      const [[row]] = await db.query('SELECT * FROM partidas_ingenieria WHERE id = ?', [editarPartidaId]);
      partidaEdit = row || null;
    }

    res.render('ingenieria/index', {
      title: 'Ingenieria y Metrados',
      partidas,
      proyectos,
      partidaEdit,
      filtros: {
        proyecto_id: proyectoId,
        partida
      },
      resultado: null
    });
  } catch (error) { next(error); }
});

router.post('/partidas', requireRole('admin'), async (req, res, next) => {
  try {
    const { proyecto_id, nombre, unidad, metrado, rendimiento_planeado, especialidad } = req.body;
    await db.query(
      'INSERT INTO partidas_ingenieria (proyecto_id, nombre, unidad, metrado, rendimiento_planeado, especialidad) VALUES (?, ?, ?, ?, ?, ?)',
      [proyecto_id, nombre, unidad, metrado, rendimiento_planeado, especialidad]
    );
    res.redirect('/ingenieria');
  } catch (error) { next(error); }
});

router.put('/partidas/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { proyecto_id, nombre, unidad, metrado, rendimiento_planeado, especialidad } = req.body;
    const [result] = await db.query(
      `UPDATE partidas_ingenieria
       SET proyecto_id = ?, nombre = ?, unidad = ?, metrado = ?, rendimiento_planeado = ?, especialidad = ?
       WHERE id = ?`,
      [proyecto_id, nombre, unidad, metrado, rendimiento_planeado, especialidad, req.params.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        error: 'La partida no existe.'
      });
    }

    res.json({ success: true, message: 'Partida actualizada correctamente.' });
  } catch (error) { next(error); }
});

router.delete('/partidas/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const [result] = await db.query('DELETE FROM partidas_ingenieria WHERE id = ?', [req.params.id]);

    if (!result.affectedRows) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'La partida no existe.'
      });
    }

    res.redirect('/ingenieria');
  } catch (error) { next(error); }
});

router.get('/calculadora', async (req, res, next) => {
  try {
    const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
    res.render('ingenieria/calculadora', { title: 'Calculadora de Materiales', proyectos, resultado: null, form: {} });
  } catch (error) { next(error); }
});

router.post('/calculadora', async (req, res, next) => {
  try {
    const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
    const { tipo_calculo, resistencia, largo, ancho, alto, espesor, area, proyecto_id, detalle } = req.body;
    let resultado = {};

    if (tipo_calculo === 'concreto') {
      const volumen = Number(largo) * Number(ancho) * Number(alto);
      const ratio = concreteDosages[resistencia] || concreteDosages['210'];
      resultado = {
        tipo: 'Concreto',
        volumen: volumen.toFixed(2),
        cemento: (volumen * ratio.cemento).toFixed(2),
        arena: (volumen * ratio.arena).toFixed(2),
        grava: (volumen * ratio.grava).toFixed(2),
        agua: (volumen * ratio.agua).toFixed(2),
        resistencia
      };
    } else if (tipo_calculo === 'muro') {
      const m2 = Number(area);
      resultado = {
        tipo: 'Muro de ladrillo',
        area: m2.toFixed(2),
        ladrillos: Math.ceil(m2 * 40),
        cemento: (m2 * 0.18).toFixed(2),
        arena: (m2 * 0.08).toFixed(2)
      };
    } else {
      const m2 = Number(area);
      const e = Number(espesor || 1.5) / 100;
      resultado = {
        tipo: 'Tarrajeo',
        area: m2.toFixed(2),
        mortero_m3: (m2 * e).toFixed(2),
        cemento: (m2 * e * 8.5).toFixed(2),
        arena: (m2 * e * 0.9).toFixed(2)
      };
    }

    if (proyecto_id) {
      await db.query(
        'INSERT INTO calculos_materiales (proyecto_id, tipo_calculo, detalle, resultado_json, creado_en) VALUES (?, ?, ?, ?, NOW())',
        [proyecto_id, tipo_calculo, detalle || '', JSON.stringify(resultado)]
      );
    }

    res.render('ingenieria/calculadora', { title: 'Calculadora de Materiales', proyectos, resultado, form: req.body });
  } catch (error) { next(error); }
});

module.exports = router;
