const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

const PLAN_CUENTAS = {
  Ingreso: ['Valorizacion', 'Adelanto'],
  Egreso: [
    'Materiales',
    'Mano de Obra (Tareos)',
    'Alquiler de Maquinaria',
    'Subcontratos',
    'Alquiler de Oficina',
    'Servicios Basicos',
    'Sueldos Administrativos',
    'Utiles de Escritorio'
  ]
};

async function hasEstadoPagoColumn() {
  const [rows] = await db.query("SHOW COLUMNS FROM asientos_contables LIKE 'estado_pago'");
  return rows.length > 0;
}

async function hasRegistradoPorColumn() {
  const [rows] = await db.query("SHOW COLUMNS FROM asientos_contables LIKE 'registrado_por'");
  return rows.length > 0;
}

async function ensureContabilidadSchema() {
  if (!(await hasEstadoPagoColumn())) {
    await db.query("ALTER TABLE asientos_contables ADD COLUMN estado_pago ENUM('Pagado','Pendiente') NOT NULL DEFAULT 'Pagado' AFTER monto");
  }
  if (!(await hasRegistradoPorColumn())) {
    await db.query("ALTER TABLE asientos_contables ADD COLUMN registrado_por VARCHAR(120) NULL AFTER estado_pago");
    await db.query("UPDATE asientos_contables SET registrado_por = 'SISTEMA' WHERE registrado_por IS NULL OR TRIM(registrado_por) = ''");
  }
}

function getRangoPeriodo(periodo) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const pad = (n) => String(n).padStart(2, '0');

  if (periodo === 'mes_actual') {
    const desde = `${year}-${pad(month + 1)}-01`;
    const hasta = new Date(year, month + 1, 0);
    return { desde, hasta: `${hasta.getFullYear()}-${pad(hasta.getMonth() + 1)}-${pad(hasta.getDate())}` };
  }

  if (periodo === 'trimestre_actual') {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    const desde = `${year}-${pad(quarterStartMonth + 1)}-01`;
    const hasta = new Date(year, quarterStartMonth + 3, 0);
    return { desde, hasta: `${hasta.getFullYear()}-${pad(hasta.getMonth() + 1)}-${pad(hasta.getDate())}` };
  }

  if (periodo === 'anio_actual') {
    return { desde: `${year}-01-01`, hasta: `${year}-12-31` };
  }

  return { desde: '', hasta: '' };
}

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureContabilidadSchema();
    const estadoPagoEnabled = await hasEstadoPagoColumn();
    const registradoPorEnabled = await hasRegistradoPorColumn();
    const filtros = {
      centro: req.query.centro || 'consolidado',
      periodo: req.query.periodo || 'mes_actual',
      desde: req.query.desde || '',
      hasta: req.query.hasta || '',
      tipo: req.query.tipo || '',
      categoria: req.query.categoria || '',
      estado_pago: req.query.estado_pago || ''
    };

    if (!filtros.desde && !filtros.hasta && filtros.periodo) {
      const rango = getRangoPeriodo(filtros.periodo);
      filtros.desde = rango.desde;
      filtros.hasta = rango.hasta;
    }

    const where = [];
    const params = [];

    if (filtros.desde) {
      where.push('a.fecha >= ?');
      params.push(filtros.desde);
    }
    if (filtros.hasta) {
      where.push('a.fecha <= ?');
      params.push(filtros.hasta);
    }
    if (filtros.centro === 'admin') {
      where.push('a.proyecto_id IS NULL');
    } else if (filtros.centro && filtros.centro !== 'consolidado') {
      where.push('a.proyecto_id = ?');
      params.push(filtros.centro);
    }
    if (filtros.tipo) {
      where.push('a.tipo = ?');
      params.push(filtros.tipo);
    }
    if (filtros.categoria) {
      where.push('a.categoria = ?');
      params.push(filtros.categoria);
    }
    if (estadoPagoEnabled && filtros.estado_pago) {
      where.push('a.estado_pago = ?');
      params.push(filtros.estado_pago);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseUrlParams = new URLSearchParams();
    baseUrlParams.set('centro', filtros.centro || 'consolidado');
    if (filtros.periodo) baseUrlParams.set('periodo', filtros.periodo);
    if (filtros.desde) baseUrlParams.set('desde', filtros.desde);
    if (filtros.hasta) baseUrlParams.set('hasta', filtros.hasta);

    const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
    const isConsolidado = filtros.centro === 'consolidado';
    let asientos = [];
    let proyectosSummary = [];
    let cuentasPorPagar = [];
    
    if (!isConsolidado) {
      const [rows] = await db.query(`
        SELECT
          a.*,
          p.nombre AS proyecto_nombre,
          ${estadoPagoEnabled ? 'a.estado_pago' : "'Pagado'"} AS estado_pago,
          ${registradoPorEnabled ? 'a.registrado_por' : "'SISTEMA'"} AS registrado_por
        FROM asientos_contables a
        LEFT JOIN proyectos p ON p.id = a.proyecto_id
        ${whereSql}
        ORDER BY a.fecha DESC, a.id DESC
        LIMIT 100
      `, params);
      asientos = rows;
    } else {
      // Resumen por proyecto cuando es consolidado - construir la query de filtros sin la restricción de centro
      const paramsForProjects = [];
      let whereProjects = [];
      
      if (filtros.desde) {
        whereProjects.push('a.fecha >= ?');
        paramsForProjects.push(filtros.desde);
      }
      if (filtros.hasta) {
        whereProjects.push('a.fecha <= ?');
        paramsForProjects.push(filtros.hasta);
      }
      if (filtros.tipo) {
        whereProjects.push('a.tipo = ?');
        paramsForProjects.push(filtros.tipo);
      }
      if (filtros.categoria) {
        whereProjects.push('a.categoria = ?');
        paramsForProjects.push(filtros.categoria);
      }
      if (estadoPagoEnabled && filtros.estado_pago) {
        whereProjects.push('a.estado_pago = ?');
        paramsForProjects.push(filtros.estado_pago);
      }
      
      const whereProjectsSql = whereProjects.length ? `WHERE ${whereProjects.join(' AND ')}` : '';
      
      // Obtener resumen por proyecto
      const [projSummary] = await db.query(`
        SELECT
          COALESCE(p.id, 'admin') AS centro_id,
          COALESCE(p.nombre, 'Oficina Central') AS centro_nombre,
          ROUND(COALESCE(SUM(CASE WHEN a.tipo='Ingreso' THEN a.monto ELSE 0 END), 0), 2) AS ingresos,
          ROUND(COALESCE(SUM(CASE WHEN a.tipo='Egreso' THEN a.monto ELSE 0 END), 0), 2) AS egresos,
          ROUND(COALESCE(SUM(CASE WHEN a.tipo='Ingreso' THEN a.monto ELSE -a.monto END), 0), 2) AS balance
        FROM (SELECT NULL as id, NULL as nombre UNION SELECT id, nombre FROM proyectos) p
        LEFT JOIN asientos_contables a ON (p.id IS NULL AND a.proyecto_id IS NULL) OR (p.id IS NOT NULL AND a.proyecto_id = p.id)
        ${whereProjectsSql}
        GROUP BY p.id, p.nombre
        ORDER BY balance DESC
      `, paramsForProjects);
      
      proyectosSummary = projSummary.map(row => ({
        ...row,
        margen: Number(row.ingresos) > 0 ? (Number(row.balance) / Number(row.ingresos)) * 100 : 0
      }));
    }
    
    const [[resumen]] = await db.query(`
      SELECT
        ROUND(COALESCE(SUM(CASE WHEN a.tipo='Ingreso' THEN a.monto ELSE 0 END), 0), 2) AS ingresos,
        ROUND(COALESCE(SUM(CASE WHEN a.tipo='Egreso' THEN a.monto ELSE 0 END), 0), 2) AS egresos,
        ROUND(COALESCE(SUM(CASE WHEN a.tipo='Ingreso' THEN a.monto ELSE -a.monto END), 0), 2) AS balance
      FROM asientos_contables a
      ${whereSql}
    `, params);

    const margen = Number(resumen.ingresos) > 0
      ? (Number(resumen.balance) / Number(resumen.ingresos)) * 100
      : 0;

    // Calcular resumen separado por estado de pago
    let resumenPorEstado = { pagado: { ingresos: 0, egresos: 0, balance: 0 }, pendiente: { ingresos: 0, egresos: 0, balance: 0 } };
    if (estadoPagoEnabled) {
      const [[pagoSummary]] = await db.query(`
        SELECT
          ROUND(COALESCE(SUM(CASE WHEN a.tipo='Ingreso' AND a.estado_pago='Pagado' THEN a.monto ELSE 0 END), 0), 2) AS ingreso_pagado,
          ROUND(COALESCE(SUM(CASE WHEN a.tipo='Egreso' AND a.estado_pago='Pagado' THEN a.monto ELSE 0 END), 0), 2) AS egreso_pagado,
          ROUND(COALESCE(SUM(CASE WHEN a.estado_pago='Pagado' THEN CASE WHEN a.tipo='Ingreso' THEN a.monto ELSE -a.monto END ELSE 0 END), 0), 2) AS balance_pagado,
          ROUND(COALESCE(SUM(CASE WHEN a.tipo='Ingreso' AND a.estado_pago='Pendiente' THEN a.monto ELSE 0 END), 0), 2) AS ingreso_pendiente,
          ROUND(COALESCE(SUM(CASE WHEN a.tipo='Egreso' AND a.estado_pago='Pendiente' THEN a.monto ELSE 0 END), 0), 2) AS egreso_pendiente,
          ROUND(COALESCE(SUM(CASE WHEN a.estado_pago='Pendiente' THEN CASE WHEN a.tipo='Ingreso' THEN a.monto ELSE -a.monto END ELSE 0 END), 0), 2) AS balance_pendiente
        FROM asientos_contables a
        ${whereSql}
      `, params);
      resumenPorEstado = {
        pagado: { ingresos: pagoSummary.ingreso_pagado, egresos: pagoSummary.egreso_pagado, balance: pagoSummary.balance_pagado },
        pendiente: { ingresos: pagoSummary.ingreso_pendiente, egresos: pagoSummary.egreso_pendiente, balance: pagoSummary.balance_pendiente }
      };

      const whereCxP = ["a.tipo = 'Egreso'", "a.estado_pago = 'Pendiente'"];
      const paramsCxP = [];
      if (filtros.desde) {
        whereCxP.push('a.fecha >= ?');
        paramsCxP.push(filtros.desde);
      }
      if (filtros.hasta) {
        whereCxP.push('a.fecha <= ?');
        paramsCxP.push(filtros.hasta);
      }
      if (filtros.centro === 'admin') {
        whereCxP.push('a.proyecto_id IS NULL');
      } else if (filtros.centro && filtros.centro !== 'consolidado') {
        whereCxP.push('a.proyecto_id = ?');
        paramsCxP.push(filtros.centro);
      }

      const [cXpRows] = await db.query(`
        SELECT
          COALESCE(p.nombre, 'Oficina Central') AS centro_nombre,
          COALESCE(a.descripcion, 'Sin descripcion') AS proveedor_referencia,
          COALESCE(a.categoria, 'Sin categoria') AS categoria,
          ROUND(COALESCE(SUM(a.monto), 0), 2) AS total_pendiente,
          COUNT(*) AS movimientos,
          MAX(a.fecha) AS ultima_fecha
        FROM asientos_contables a
        LEFT JOIN proyectos p ON p.id = a.proyecto_id
        WHERE ${whereCxP.join(' AND ')}
        GROUP BY p.nombre, a.descripcion, a.categoria
        ORDER BY total_pendiente DESC
        LIMIT 100
      `, paramsCxP);
      cuentasPorPagar = cXpRows;
    }

    let centroLabel = 'Consolidado General';
    if (filtros.centro === 'admin') {
      centroLabel = 'Oficina Central';
    } else if (filtros.centro !== 'consolidado') {
      const proyectoSel = proyectos.find((p) => String(p.id) === String(filtros.centro));
      centroLabel = proyectoSel ? proyectoSel.nombre : 'Centro de costo';
    }

    const ctasPorPagarParams = new URLSearchParams(baseUrlParams.toString());
    ctasPorPagarParams.set('tipo', 'Egreso');
    ctasPorPagarParams.set('estado_pago', 'Pendiente');
    const ctasPorPagarHref = `/contabilidad?${ctasPorPagarParams.toString()}#cxp-detalle`;
    const mostrarCxPDetalle = filtros.tipo === 'Egreso' && filtros.estado_pago === 'Pendiente';

    res.render('contabilidad/index', {
      title: 'Contabilidad y Finanzas',
      asientos,
      resumen,
      margen,
      proyectos,
      filtros,
      planCuentas: PLAN_CUENTAS,
      estadoPagoEnabled,
      centroLabel,
      isConsolidado,
      proyectosSummary,
      resumenPorEstado,
      cuentasPorPagar,
      ctasPorPagarHref,
      mostrarCxPDetalle
    });
  } catch (error) { next(error); }
});

router.post('/asientos', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureContabilidadSchema();
    const estadoPagoEnabled = await hasEstadoPagoColumn();
    const registradoPorEnabled = await hasRegistradoPorColumn();
    const { fecha, tipo, categoria, descripcion, monto, proyecto_id, estado_pago, next_centro } = req.body;
    const proyectoNormalizado = proyecto_id === 'admin' ? null : (proyecto_id || null);
    const registradoPor = String(req.session?.user?.username || req.session?.user?.nombre || 'SISTEMA').toUpperCase();

    if (!fecha || !tipo || !categoria || !descripcion || !monto) {
      return res.redirect(`/contabilidad?centro=${encodeURIComponent(next_centro || 'consolidado')}`);
    }

    if (!['Ingreso', 'Egreso'].includes(tipo)) {
      return res.redirect(`/contabilidad?centro=${encodeURIComponent(next_centro || 'consolidado')}`);
    }

    if (!PLAN_CUENTAS[tipo] || !PLAN_CUENTAS[tipo].includes(categoria)) {
      return res.redirect(`/contabilidad?centro=${encodeURIComponent(next_centro || 'consolidado')}`);
    }

    // Validar que el proyecto_id existe si no es admin
    if (proyectoNormalizado !== null) {
      const [projectCheck] = await db.query('SELECT id FROM proyectos WHERE id = ? LIMIT 1', [proyectoNormalizado]);
      if (projectCheck.length === 0) {
        return res.redirect(`/contabilidad?centro=${encodeURIComponent(next_centro || 'consolidado')}`);
      }
    }

    const estadoPago = estado_pago === 'Pendiente' ? 'Pendiente' : 'Pagado';

    if (estadoPagoEnabled && registradoPorEnabled) {
      await db.query(
        'INSERT INTO asientos_contables (fecha, tipo, categoria, descripcion, monto, proyecto_id, estado_pago, registrado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [fecha, tipo, categoria, descripcion, monto, proyectoNormalizado, estadoPago, registradoPor]
      );
    } else if (estadoPagoEnabled) {
      await db.query(
        'INSERT INTO asientos_contables (fecha, tipo, categoria, descripcion, monto, proyecto_id, estado_pago) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [fecha, tipo, categoria, descripcion, monto, proyectoNormalizado, estadoPago]
      );
    } else {
      await db.query(
        'INSERT INTO asientos_contables (fecha, tipo, categoria, descripcion, monto, proyecto_id) VALUES (?, ?, ?, ?, ?, ?)',
        [fecha, tipo, categoria, descripcion, monto, proyectoNormalizado]
      );
    }

    res.redirect(`/contabilidad?centro=${encodeURIComponent(next_centro || 'consolidado')}`);
  } catch (error) { next(error); }
});

module.exports = router;
