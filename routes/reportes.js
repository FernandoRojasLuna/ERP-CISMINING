const express = require('express');
const router = express.Router();
const db = require('../config/db');
const ExcelJS = require('exceljs');
const { requireRole } = require('../middleware/auth');

async function ensureReportesEmisionesSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS reportes_emisiones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario VARCHAR(120) NOT NULL,
      formato VARCHAR(20) NOT NULL,
      filtros_json JSON NULL,
      generado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function logReporteEmision(req, formato, filtros) {
  await ensureReportesEmisionesSchema();
  const usuario = String(req.session?.user?.username || req.session?.user?.nombre || 'SISTEMA').toUpperCase();
  await db.query(
    'INSERT INTO reportes_emisiones (usuario, formato, filtros_json) VALUES (?, ?, ?)',
    [usuario, formato, JSON.stringify(filtros || {})]
  );
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

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftYears(date, years) {
  const copy = new Date(date);
  copy.setFullYear(copy.getFullYear() + years);
  return copy;
}

async function getCostoEgresoTotal({ desde, hasta, proyecto_id }) {
  const where = ["tipo = 'Egreso'"];
  const params = [];
  if (desde) {
    where.push('fecha >= ?');
    params.push(desde);
  }
  if (hasta) {
    where.push('fecha <= ?');
    params.push(hasta);
  }
  if (proyecto_id) {
    where.push('proyecto_id = ?');
    params.push(proyecto_id);
  }

  const [[row]] = await db.query(
    `SELECT ROUND(COALESCE(SUM(monto), 0), 2) AS total FROM asientos_contables WHERE ${where.join(' AND ')}`,
    params
  );
  return Number(row?.total || 0);
}

function calcPctChange(current, previous) {
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
}

async function buildReportData(req) {
  const filtros = {
    periodo: req.query.periodo || 'mes_actual',
    desde: req.query.desde || '',
    hasta: req.query.hasta || '',
    proyecto_id: req.query.proyecto_id || ''
  };

  if (!filtros.desde && !filtros.hasta && filtros.periodo) {
    const rango = getRangoPeriodo(filtros.periodo);
    filtros.desde = rango.desde;
    filtros.hasta = rango.hasta;
  }

  const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');

  const whereAct = [];
  const paramsAct = [];
  if (filtros.desde) {
    whereAct.push('COALESCE(a.fecha_inicio_programada, DATE(a.fecha_actualizacion)) >= ?');
    paramsAct.push(filtros.desde);
  }
  if (filtros.hasta) {
    whereAct.push('COALESCE(a.fecha_fin_programada, a.fecha_inicio_programada, DATE(a.fecha_actualizacion)) <= ?');
    paramsAct.push(filtros.hasta);
  }
  if (filtros.proyecto_id) {
    whereAct.push('p.id = ?');
    paramsAct.push(filtros.proyecto_id);
  }
  const whereActSql = whereAct.length ? `WHERE ${whereAct.join(' AND ')}` : '';

  const [avancePorProyecto] = await db.query(`
    SELECT
      p.id,
      p.nombre,
      ROUND(COALESCE(AVG(a.avance_porcentaje), 0), 2) AS avance_promedio,
      COUNT(a.id) AS actividades
    FROM proyectos p
    LEFT JOIN actividades a ON a.proyecto_id = p.id
    ${whereActSql}
    GROUP BY p.id, p.nombre
    ORDER BY p.nombre
  `, paramsAct);

  const whereCost = ["a.tipo = 'Egreso'"];
  const paramsCost = [];
  if (filtros.desde) {
    whereCost.push('a.fecha >= ?');
    paramsCost.push(filtros.desde);
  }
  if (filtros.hasta) {
    whereCost.push('a.fecha <= ?');
    paramsCost.push(filtros.hasta);
  }
  if (filtros.proyecto_id) {
    whereCost.push('a.proyecto_id = ?');
    paramsCost.push(filtros.proyecto_id);
  }

  const [costosPorCategoria] = await db.query(`
    SELECT
      a.categoria,
      ROUND(COALESCE(SUM(a.monto), 0), 2) AS total
    FROM asientos_contables a
    WHERE ${whereCost.join(' AND ')}
    GROUP BY a.categoria
    ORDER BY total DESC
  `, paramsCost);

  const whereNom = [];
  const paramsNom = [];
  const periodoDesde = filtros.desde ? String(filtros.desde).slice(0, 7) : '';
  const periodoHasta = filtros.hasta ? String(filtros.hasta).slice(0, 7) : '';
  if (periodoDesde) {
    whereNom.push('periodo >= ?');
    paramsNom.push(periodoDesde);
  }
  if (periodoHasta) {
    whereNom.push('periodo <= ?');
    paramsNom.push(periodoHasta);
  }
  const whereNomSql = whereNom.length ? `WHERE ${whereNom.join(' AND ')}` : '';

  const [nominaResumen] = await db.query(`
    SELECT periodo, ROUND(SUM(neto_pagar), 2) AS total_nomina
    FROM nominas
    ${whereNomSql}
    GROUP BY periodo
    ORDER BY periodo DESC
  `, paramsNom);

  const totalProyectos = avancePorProyecto.length;
  const totalActividades = avancePorProyecto.reduce((acc, p) => acc + Number(p.actividades || 0), 0);
  const sumaAvance = avancePorProyecto.reduce((acc, p) => acc + Number(p.avance_promedio || 0), 0);
  const avanceGlobal = totalProyectos ? (sumaAvance / totalProyectos) : 0;

  const costoTotal = costosPorCategoria.reduce((acc, c) => acc + Number(c.total || 0), 0);
  const mayorCategoria = costosPorCategoria[0] || null;

  const nominaActual = Number(nominaResumen[0]?.total_nomina || 0);
  const nominaAnterior = Number(nominaResumen[1]?.total_nomina || 0);
  const variacionNominaPct = nominaAnterior
    ? ((nominaActual - nominaAnterior) / nominaAnterior) * 100
    : 0;

  const alertas = [];
  const proyectosCriticos = avancePorProyecto.filter((p) => Number(p.avance_promedio || 0) < 40 && Number(p.actividades || 0) > 0);
  if (proyectosCriticos.length) {
    alertas.push({
      tipo: 'critico',
      titulo: 'Proyectos en riesgo de avance',
      detalle: `${proyectosCriticos.length} proyecto(s) por debajo del 40% de avance.`
    });
  }

  const categoriaTop = costosPorCategoria[0];
  if (categoriaTop && costoTotal > 0) {
    const participacionTop = (Number(categoriaTop.total || 0) / Number(costoTotal)) * 100;
    if (participacionTop >= 45) {
      alertas.push({
        tipo: 'alerta',
        titulo: 'Concentracion de costos alta',
        detalle: `${categoriaTop.categoria} concentra ${participacionTop.toFixed(1)}% del egreso.`
      });
    }
  }

  if (Number(variacionNominaPct) > 15) {
    alertas.push({
      tipo: 'alerta',
      titulo: 'Nomina con crecimiento acelerado',
      detalle: `Variacion de ${Number(variacionNominaPct).toFixed(2)}% frente al periodo anterior.`
    });
  }

  const resumen = {
    totalProyectos,
    totalActividades,
    avanceGlobal: Number(avanceGlobal.toFixed(2)),
    costoTotal: Number(costoTotal.toFixed(2)),
    mayorCategoria,
    nominaActual: Number(nominaActual.toFixed(2)),
    variacionNominaPct: Number(variacionNominaPct.toFixed(2))
  };

  const dDesde = parseDateOrNull(filtros.desde);
  const dHasta = parseDateOrNull(filtros.hasta);
  if (dDesde && dHasta) {
    const diffDays = Math.max(1, Math.round((dHasta - dDesde) / (1000 * 60 * 60 * 24)) + 1);
    const dPrevHasta = new Date(dDesde);
    dPrevHasta.setDate(dPrevHasta.getDate() - 1);
    const dPrevDesde = new Date(dPrevHasta);
    dPrevDesde.setDate(dPrevDesde.getDate() - diffDays + 1);

    const costoPrevio = await getCostoEgresoTotal({
      desde: formatYmd(dPrevDesde),
      hasta: formatYmd(dPrevHasta),
      proyecto_id: filtros.proyecto_id
    });

    const costoYoY = await getCostoEgresoTotal({
      desde: formatYmd(shiftYears(dDesde, -1)),
      hasta: formatYmd(shiftYears(dHasta, -1)),
      proyecto_id: filtros.proyecto_id
    });

    resumen.variacionCostoMoMPct = Number(calcPctChange(resumen.costoTotal, costoPrevio).toFixed(2));
    resumen.variacionCostoYoYPct = Number(calcPctChange(resumen.costoTotal, costoYoY).toFixed(2));
  } else {
    resumen.variacionCostoMoMPct = 0;
    resumen.variacionCostoYoYPct = 0;
  }

  const periodoNominaActual = nominaResumen[0]?.periodo;
  if (periodoNominaActual && /^\d{4}-\d{2}$/.test(periodoNominaActual)) {
    const [anio, mes] = periodoNominaActual.split('-').map(Number);
    const periodoYoY = `${String(anio - 1)}-${String(mes).padStart(2, '0')}`;
    const [[nomYoYRow]] = await db.query(
      'SELECT ROUND(COALESCE(SUM(neto_pagar), 0), 2) AS total FROM nominas WHERE periodo = ?',
      [periodoYoY]
    );
    const nominaYoY = Number(nomYoYRow?.total || 0);
    resumen.variacionNominaYoYPct = Number(calcPctChange(resumen.nominaActual, nominaYoY).toFixed(2));
  } else {
    resumen.variacionNominaYoYPct = 0;
  }

  const query = new URLSearchParams({
    periodo: filtros.periodo || '',
    desde: filtros.desde || '',
    hasta: filtros.hasta || '',
    proyecto_id: filtros.proyecto_id || ''
  }).toString();

  return {
    filtros,
    proyectos,
    avancePorProyecto,
    costosPorCategoria,
    nominaResumen,
    resumen,
    alertas,
    exportPdfUrl: `/reportes/export/pdf?${query}`,
    exportExcelUrl: `/reportes/export/excel/download?${query}`
  };
}

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const data = await buildReportData(req);
    res.render('reportes/index', {
      title: 'Centro de Reportes',
      ...data
    });
  } catch (error) { next(error); }
});

router.get('/export/pdf', requireRole('admin'), async (req, res, next) => {
  try {
    const data = await buildReportData(req);
    await logReporteEmision(req, 'PDF', data.filtros);
    const emitido = new Date().toLocaleDateString('es-PE');
    const totalCostos = Number(data.resumen?.costoTotal || 0);

    res.render('reportes/export_preview', {
      layout: false,
      title: 'Vista Previa PDF - Centro de Reportes',
      ...data,
      emitido,
      totalCostos
    });
  } catch (error) { next(error); }
});

router.get('/export/excel/download', requireRole('admin'), async (req, res, next) => {
  try {
    const data = await buildReportData(req);
    await logReporteEmision(req, 'EXCEL', data.filtros);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERP Construccion';
    wb.created = new Date();

    const wsResumen = wb.addWorksheet('Resumen Ejecutivo');
    wsResumen.columns = [
      { header: 'Indicador', key: 'indicador', width: 36 },
      { header: 'Valor', key: 'valor', width: 24 }
    ];
    wsResumen.getRow(1).font = { bold: true };
    wsResumen.addRows([
      { indicador: 'Periodo', valor: `${data.filtros.desde || '-'} a ${data.filtros.hasta || '-'}` },
      { indicador: 'Proyecto', valor: data.filtros.proyecto_id ? (data.proyectos.find((p) => String(p.id) === String(data.filtros.proyecto_id))?.nombre || 'Seleccionado') : 'Todos' },
      { indicador: 'Avance global', valor: `${Number(data.resumen.avanceGlobal || 0).toFixed(2)}%` },
      { indicador: 'Actividades evaluadas', valor: Number(data.resumen.totalActividades || 0) },
      { indicador: 'Costo total ejecutado', valor: Number(data.resumen.costoTotal || 0).toFixed(2) },
      { indicador: 'Variacion costo vs mes anterior', valor: `${Number(data.resumen.variacionCostoMoMPct || 0).toFixed(2)}%` },
      { indicador: 'Variacion costo vs año anterior', valor: `${Number(data.resumen.variacionCostoYoYPct || 0).toFixed(2)}%` },
      { indicador: 'Nomina actual', valor: Number(data.resumen.nominaActual || 0).toFixed(2) },
      { indicador: 'Variacion nomina vs mes anterior', valor: `${Number(data.resumen.variacionNominaPct || 0).toFixed(2)}%` },
      { indicador: 'Variacion nomina vs año anterior', valor: `${Number(data.resumen.variacionNominaYoYPct || 0).toFixed(2)}%` }
    ]);

    const wsAvance = wb.addWorksheet('Avance Proyectos');
    wsAvance.columns = [
      { header: 'Proyecto', key: 'nombre', width: 40 },
      { header: 'Actividades', key: 'actividades', width: 14 },
      { header: 'Avance %', key: 'avance_promedio', width: 14 }
    ];
    wsAvance.getRow(1).font = { bold: true };
    wsAvance.addRows((data.avancePorProyecto || []).map((r) => ({
      nombre: r.nombre,
      actividades: Number(r.actividades || 0),
      avance_promedio: Number(r.avance_promedio || 0)
    })));

    const wsCostos = wb.addWorksheet('Costos Categoria');
    wsCostos.columns = [
      { header: 'Categoria', key: 'categoria', width: 36 },
      { header: 'Total S/', key: 'total', width: 18 }
    ];
    wsCostos.getRow(1).font = { bold: true };
    wsCostos.addRows((data.costosPorCategoria || []).map((r) => ({
      categoria: r.categoria,
      total: Number(r.total || 0)
    })));

    const wsNomina = wb.addWorksheet('Nomina');
    wsNomina.columns = [
      { header: 'Periodo', key: 'periodo', width: 16 },
      { header: 'Total S/', key: 'total_nomina', width: 18 }
    ];
    wsNomina.getRow(1).font = { bold: true };
    wsNomina.addRows((data.nominaResumen || []).map((r) => ({
      periodo: r.periodo,
      total_nomina: Number(r.total_nomina || 0)
    })));

    const wsAlertas = wb.addWorksheet('Alertas');
    wsAlertas.columns = [
      { header: 'Nivel', key: 'tipo', width: 14 },
      { header: 'Titulo', key: 'titulo', width: 34 },
      { header: 'Detalle', key: 'detalle', width: 80 }
    ];
    wsAlertas.getRow(1).font = { bold: true };
    wsAlertas.addRows((data.alertas || []).map((a) => ({
      tipo: String(a.tipo || '').toUpperCase(),
      titulo: a.titulo,
      detalle: a.detalle
    })));

    const safeProyecto = data.filtros.proyecto_id
      ? (data.proyectos.find((p) => String(p.id) === String(data.filtros.proyecto_id))?.nombre || 'proyecto')
      : 'consolidado';
    const fileName = `reportes-${safeProyecto.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) { next(error); }
});

module.exports = router;
