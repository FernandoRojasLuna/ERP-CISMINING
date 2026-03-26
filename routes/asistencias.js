const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

async function getProyectos() {
  const [rows] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
  return Array.isArray(rows) ? rows : [];
}

async function ensureAsistenciasSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rrhh_asistencias (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empleado_id INT NOT NULL,
      fecha DATE NOT NULL,
      semana_inicio DATE NOT NULL,
      asistio TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_rrhh_asistencia_empleado_fecha (empleado_id, fecha),
      KEY idx_rrhh_asistencia_semana (semana_inicio),
      CONSTRAINT fk_rrhh_asistencia_empleado FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS rrhh_asistencia_ajustes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empleado_id INT NOT NULL,
      semana_inicio DATE NOT NULL,
      bonificacion DECIMAL(12,2) NOT NULL DEFAULT 0,
      adelanto DECIMAL(12,2) NOT NULL DEFAULT 0,
      deudas DECIMAL(12,2) NOT NULL DEFAULT 0,
      otros_descuentos DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_rrhh_ajuste_empleado_semana (empleado_id, semana_inicio),
      CONSTRAINT fk_rrhh_ajuste_empleado FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
}

function toIsoDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(baseDate, amount) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + amount);
  return d;
}

function getMonday(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + delta);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getMonthBounds(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return {
    inicio: toIsoDate(start),
    fin: toIsoDate(end),
    totalDias: end.getDate()
  };
}

function getMonthDays(year, month) {
  const labels = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  const { totalDias } = getMonthBounds(year, month);
  const days = [];
  for (let i = 1; i <= totalDias; i += 1) {
    const d = new Date(year, month - 1, i);
    days.push({
      fecha: toIsoDate(d),
      diaMes: i,
      diaSemana: labels[d.getDay()],
      esDomingo: d.getDay() === 0
    });
  }
  return days;
}

function parsePositiveNumber(value) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
}

function parseAsistenciaFilters(req) {
  const now = new Date();
  const month = Number(req.query.asistencia_mes || (now.getMonth() + 1));
  const year = Number(req.query.asistencia_anio || now.getFullYear());
  const proyectoId = req.query.asistencia_proyecto_id ? Number(req.query.asistencia_proyecto_id) : null;
  return { month, year, proyectoId };
}

function getExportRows(asistencia) {
  const empleados = Array.isArray(asistencia?.empleados) ? asistencia.empleados : [];
  return empleados.map((emp, idx) => ({
    n: idx + 1,
    docNombre: `${emp.docIdentidad || '-'} - ${emp.nombre || '-'}`,
    dias: Number(emp.diasTrabajados || 0),
    salarioDia: Number(emp.salarioDia || 0),
    importe: Number(emp.importe || 0),
    adelanto: Number(emp.adelanto || 0),
    descuentos: Number(emp.descuentos || 0),
    neto: Number(emp.neto || 0)
  }));
}

function money(value) {
  return `S/ ${Number(value || 0).toFixed(2)}`;
}

function getAsistenciaStatsByRows(rows) {
  const values = Array.isArray(rows) ? rows : [];
  const diasLunesSabado = values
    .filter((item) => {
      const d = new Date(item.fecha);
      const day = d.getDay();
      return day >= 1 && day <= 6;
    })
    .reduce((acc, item) => acc + (Number(item.asistio) === 1 ? 1 : 0), 0);

  return { diasLunesSabado };
}

async function syncSundayAutoByDate(empleadoId, fechaIso) {
  const monday = getMonday(fechaIso);
  if (!monday) return null;

  const sundayIso = toIsoDate(addDays(monday, 6));
  const weekStartIso = toIsoDate(monday);
  const weekEndIso = toIsoDate(addDays(monday, 6));

  const [rows] = await db.query(
    'SELECT fecha, asistio FROM rrhh_asistencias WHERE empleado_id = ? AND fecha BETWEEN ? AND ?',
    [empleadoId, weekStartIso, weekEndIso]
  );

  const stats = getAsistenciaStatsByRows(rows);
  const sundayShouldBeOne = stats.diasLunesSabado === 6;

  await db.query(
    `INSERT INTO rrhh_asistencias (empleado_id, fecha, semana_inicio, asistio)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE asistio = VALUES(asistio), semana_inicio = VALUES(semana_inicio), updated_at = CURRENT_TIMESTAMP`,
    [empleadoId, sundayIso, weekStartIso, sundayShouldBeOne ? 1 : 0]
  );

  return {
    sundayFecha: sundayIso,
    sundayAsistio: sundayShouldBeOne ? 1 : 0
  };
}

async function buildAsistenciaData({ proyectoId, year, month }) {
  const monthDays = getMonthDays(year, month);
  const monthBounds = getMonthBounds(year, month);
  const periodoInicio = monthBounds.inicio;

  const filterByProyecto = proyectoId ? ' AND e.proyecto_id = ?' : '';
  const queryParams = proyectoId ? [proyectoId] : [];

  const [empleadosRows] = await db.query(
    `SELECT
       e.id,
       e.nombre,
       e.cargo,
       e.salario,
       p.nombre AS proyecto,
       COALESCE(NULLIF(u.username, ''), CONCAT('EMP-', LPAD(e.id, 5, '0'))) AS doc_identidad
     FROM empleados e
     LEFT JOIN proyectos p ON p.id = e.proyecto_id
     LEFT JOIN users u ON u.empleado_id = e.id
     WHERE e.estado = 'Activo' ${filterByProyecto}
     ORDER BY e.nombre`,
    queryParams
  );

  const empleados = Array.isArray(empleadosRows) ? empleadosRows : [];
  if (!empleados.length) {
    return {
      filtros: { proyectoId: proyectoId || '', year, month },
      monthDays,
      empleados: [],
      resumen: { trabajadores: 0, montoProyectado: 0 },
      periodoInicio,
      periodoFin: monthBounds.fin
    };
  }

  const empleadoIds = empleados.map((e) => e.id);
  const [asistenciaRows] = await db.query(
    `SELECT empleado_id, fecha, asistio
     FROM rrhh_asistencias
     WHERE fecha BETWEEN ? AND ?
       AND empleado_id IN (?)`,
    [monthBounds.inicio, monthBounds.fin, empleadoIds]
  );

  const [ajustesRows] = await db.query(
    `SELECT empleado_id, bonificacion, adelanto, deudas, otros_descuentos
     FROM rrhh_asistencia_ajustes
     WHERE semana_inicio = ?
       AND empleado_id IN (?)`,
    [periodoInicio, empleadoIds]
  );

  const asistenciaMap = new Map();
  (Array.isArray(asistenciaRows) ? asistenciaRows : []).forEach((row) => {
    const fechaIso = toIsoDate(row.fecha);
    asistenciaMap.set(`${row.empleado_id}-${fechaIso}`, Number(row.asistio) === 1 ? 1 : 0);
  });

  const ajustesMap = new Map();
  (Array.isArray(ajustesRows) ? ajustesRows : []).forEach((row) => {
    const descuentos = Number(row.deudas || 0) + Number(row.otros_descuentos || 0);
    ajustesMap.set(Number(row.empleado_id), {
      bonificacion: Number(row.bonificacion || 0),
      adelanto: Number(row.adelanto || 0),
      descuentos
    });
  });

  let montoProyectado = 0;
  const empleadosData = empleados.map((emp) => {
    const salario = Number(emp.salario || 0);
    const salarioDia = salario / 30;
    const ajustes = ajustesMap.get(Number(emp.id)) || {
      bonificacion: 0,
      adelanto: 0,
      descuentos: 0
    };

    const dias = monthDays.map((day) => {
      const key = `${emp.id}-${day.fecha}`;
      const asistio = asistenciaMap.has(key) ? asistenciaMap.get(key) : 0;
      return {
        ...day,
        asistio
      };
    });

    const diasTrabajados = dias.reduce((acc, day) => acc + (day.asistio ? 1 : 0), 0);
    const importe = diasTrabajados * salarioDia;
    const neto = importe + ajustes.bonificacion - ajustes.adelanto - ajustes.descuentos;
    montoProyectado += neto;

    return {
      id: emp.id,
      nombre: emp.nombre,
      cargo: emp.cargo,
      proyecto: emp.proyecto,
      docIdentidad: emp.doc_identidad,
      salario,
      salarioDia,
      dias,
      diasTrabajados,
      importe,
      bonificacion: ajustes.bonificacion,
      adelanto: ajustes.adelanto,
      descuentos: ajustes.descuentos,
      neto
    };
  });

  return {
    filtros: { proyectoId: proyectoId || '', year, month },
    monthDays,
    empleados: empleadosData,
    resumen: {
      trabajadores: empleadosData.length,
      montoProyectado
    },
    periodoInicio,
    periodoFin: monthBounds.fin
  };
}

async function computeMonthlyTotals(empleadoId, year, month, periodoInicio) {
  const bounds = getMonthBounds(year, month);
  const [asistenciaRows] = await db.query(
    'SELECT asistio FROM rrhh_asistencias WHERE empleado_id = ? AND fecha BETWEEN ? AND ?',
    [empleadoId, bounds.inicio, bounds.fin]
  );

  const [empleadoRows] = await db.query('SELECT salario FROM empleados WHERE id = ?', [empleadoId]);
  const salario = Number(empleadoRows?.[0]?.salario || 0);
  const salarioDia = salario / 30;

  const [ajusteRows] = await db.query(
    'SELECT bonificacion, adelanto, deudas, otros_descuentos FROM rrhh_asistencia_ajustes WHERE empleado_id = ? AND semana_inicio = ?',
    [empleadoId, periodoInicio]
  );

  const ajustes = ajusteRows?.[0] || { bonificacion: 0, adelanto: 0, deudas: 0, otros_descuentos: 0 };
  const descuentos = Number(ajustes.deudas || 0) + Number(ajustes.otros_descuentos || 0);
  const diasTrabajados = (Array.isArray(asistenciaRows) ? asistenciaRows : []).reduce((acc, row) => acc + (Number(row.asistio) === 1 ? 1 : 0), 0);
  const importe = diasTrabajados * salarioDia;
  const neto = importe + Number(ajustes.bonificacion || 0) - Number(ajustes.adelanto || 0) - descuentos;

  return { diasTrabajados, importe, neto };
}

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const { month, year, proyectoId } = parseAsistenciaFilters(req);

    const proyectos = await getProyectos();
    const asistencia = await buildAsistenciaData({ proyectoId, year, month });

    res.locals.proyectos = proyectos;
    res.locals.asistencia = asistencia;

    return res.render('asistencias/index', {
      title: 'Asistencias'
    });
  } catch (error) {
    next(error);
  }
});

router.get('/export/pdf', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const { month, year, proyectoId } = parseAsistenciaFilters(req);
    const proyectos = await getProyectos();
    const asistencia = await buildAsistenciaData({ proyectoId, year, month });
    const rows = getExportRows(asistencia);
    const proyectoNombre = proyectoId
      ? (proyectos.find((p) => Number(p.id) === Number(proyectoId))?.nombre || 'Proyecto seleccionado')
      : 'Todos los proyectos';

    const query = new URLSearchParams({
      asistencia_proyecto_id: String(proyectoId || ''),
      asistencia_mes: String(month),
      asistencia_anio: String(year)
    }).toString();

    return res.render('asistencias/export_preview', {
      layout: false,
      title: 'Vista Previa PDF - Asistencias',
      exportType: 'pdf',
      proyectoNombre,
      periodoLabel: `${MONTH_NAMES[month - 1]} ${year}`,
      emitido: new Date().toLocaleDateString('es-PE'),
      rows,
      totalNeto: rows.reduce((acc, row) => acc + Number(row.neto || 0), 0),
      downloadExcelUrl: `/asistencias/export/excel/download?${query}`
    });
  } catch (error) {
    next(error);
  }
});

router.get('/export/excel', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const { month, year, proyectoId } = parseAsistenciaFilters(req);
    const proyectos = await getProyectos();
    const asistencia = await buildAsistenciaData({ proyectoId, year, month });
    const rows = getExportRows(asistencia);
    const proyectoNombre = proyectoId
      ? (proyectos.find((p) => Number(p.id) === Number(proyectoId))?.nombre || 'Proyecto seleccionado')
      : 'Todos los proyectos';

    const query = new URLSearchParams({
      asistencia_proyecto_id: String(proyectoId || ''),
      asistencia_mes: String(month),
      asistencia_anio: String(year)
    }).toString();

    return res.render('asistencias/export_preview', {
      layout: false,
      title: 'Vista Previa Excel - Asistencias',
      exportType: 'excel',
      proyectoNombre,
      periodoLabel: `${MONTH_NAMES[month - 1]} ${year}`,
      emitido: new Date().toLocaleDateString('es-PE'),
      rows,
      totalNeto: rows.reduce((acc, row) => acc + Number(row.neto || 0), 0),
      downloadExcelUrl: `/asistencias/export/excel/download?${query}`
    });
  } catch (error) {
    next(error);
  }
});

router.get('/export/excel/download', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const { month, year, proyectoId } = parseAsistenciaFilters(req);
    const proyectos = await getProyectos();
    const asistencia = await buildAsistenciaData({ proyectoId, year, month });
    const rows = getExportRows(asistencia);
    const proyectoNombre = proyectoId
      ? (proyectos.find((p) => Number(p.id) === Number(proyectoId))?.nombre || 'Proyecto seleccionado')
      : 'Todos los proyectos';

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERP Construccion';
    wb.created = new Date();

    const ws = wb.addWorksheet('Asistencias', {
      views: [{ state: 'frozen', ySplit: 6 }],
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
      }
    });

    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = 'REPORTE OFICIAL DE ASISTENCIAS';
    ws.getCell('A1').font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 26;

    ws.mergeCells('A2:H2');
    ws.getCell('A2').value = `Proyecto: ${proyectoNombre} | Periodo: ${MONTH_NAMES[month - 1]} ${year} | Emitido: ${new Date().toLocaleDateString('es-PE')}`;
    ws.getCell('A2').font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
    ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 20;

    ws.columns = [
      { header: 'N°', key: 'n', width: 6 },
      { header: 'Trabajador (Doc / Nombre)', key: 'docNombre', width: 40 },
      { header: 'Dias', key: 'dias', width: 10 },
      { header: 'S/ Dia', key: 'salarioDia', width: 12 },
      { header: 'Imp.', key: 'importe', width: 13 },
      { header: 'Adel.', key: 'adelanto', width: 13 },
      { header: 'Desc.', key: 'descuentos', width: 13 },
      { header: 'Neto', key: 'neto', width: 14 }
    ];

    ws.spliceRows(3, 1);
    ws.addRow([]);
    ws.addRow(ws.columns.map((c) => c.header));

    const headerRow = ws.getRow(4);
    headerRow.height = 20;
    headerRow.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD6E1F0' } },
        left: { style: 'thin', color: { argb: 'FFD6E1F0' } },
        bottom: { style: 'thin', color: { argb: 'FFD6E1F0' } },
        right: { style: 'thin', color: { argb: 'FFD6E1F0' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    rows.forEach((row) => ws.addRow(row));

    for (let i = 5; i < 5 + rows.length; i += 1) {
      const row = ws.getRow(i);
      row.height = 18;
      row.eachCell((cell, col) => {
        cell.font = { name: 'Calibri', size: 10 };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: i % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF' }
        };

        if (col >= 4) {
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else if (col === 1 || col === 3) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else {
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
        }
      });
    }

    const totalRowIndex = 5 + rows.length;
    ws.getCell(`A${totalRowIndex}`).value = 'TOTAL NETO';
    ws.mergeCells(`A${totalRowIndex}:G${totalRowIndex}`);
    ws.getCell(`A${totalRowIndex}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F172A' } };
    ws.getCell(`A${totalRowIndex}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    ws.getCell(`A${totalRowIndex}`).alignment = { horizontal: 'right', vertical: 'middle' };

    ws.getCell(`H${totalRowIndex}`).value = { formula: `SUM(H5:H${Math.max(totalRowIndex - 1, 5)})` };
    ws.getCell(`H${totalRowIndex}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF047857' } };
    ws.getCell(`H${totalRowIndex}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    ws.getCell(`H${totalRowIndex}`).numFmt = '#,##0.00';
    ws.getCell(`H${totalRowIndex}`).alignment = { horizontal: 'right', vertical: 'middle' };

    const filename = `asistencias_${year}_${String(month).padStart(2, '0')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

router.post('/toggle', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const empleadoId = Number(req.body.empleado_id || 0);
    const fecha = toIsoDate(req.body.fecha);
    const asistio = Number(req.body.asistio) === 1 ? 1 : 0;

    if (!empleadoId || !fecha) {
      return res.status(400).json({ success: false, message: 'Datos incompletos para registrar asistencia.' });
    }

    const targetDate = new Date(fecha);
    const isSunday = targetDate.getDay() === 0;

    const weekStart = toIsoDate(getMonday(fecha));
    await db.query(
      `INSERT INTO rrhh_asistencias (empleado_id, fecha, semana_inicio, asistio)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE asistio = VALUES(asistio), semana_inicio = VALUES(semana_inicio), updated_at = CURRENT_TIMESTAMP`,
      [empleadoId, fecha, weekStart, asistio]
    );

    const sundaySync = isSunday ? null : await syncSundayAutoByDate(empleadoId, fecha);

    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const periodoInicio = toIsoDate(new Date(year, month - 1, 1));
    const totals = await computeMonthlyTotals(empleadoId, year, month, periodoInicio);

    return res.json({
      success: true,
      empleado_id: empleadoId,
      sunday_fecha: sundaySync?.sundayFecha || null,
      domingo_asistio: Number(sundaySync?.sundayAsistio || 0),
      dias_trabajados: totals.diasTrabajados,
      importe: totals.importe,
      neto: totals.neto
    });
  } catch (error) {
    next(error);
  }
});

router.post('/ajustes', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const empleadoId = Number(req.body.empleado_id || 0);
    const periodoInicio = toIsoDate(req.body.periodo_inicio);
    const bonificacion = parsePositiveNumber(req.body.bonificacion);
    const adelantoNuevo = parsePositiveNumber(req.body.adelanto);
    const descuentosNuevo = parsePositiveNumber(req.body.descuentos);

    if (!empleadoId || !periodoInicio) {
      return res.status(400).json({ success: false, message: 'Datos incompletos para ajustes de asistencia.' });
    }

    // Leer valores actuales para acumular (no reemplazar)
    const [existentes] = await db.query(
      'SELECT adelanto, deudas, otros_descuentos FROM rrhh_asistencia_ajustes WHERE empleado_id = ? AND semana_inicio = ?',
      [empleadoId, periodoInicio]
    );
    
    const adelantoActual = Number(existentes?.[0]?.adelanto || 0);
    const deudasActuales = Number(existentes?.[0]?.deudas || 0);
    const otrosDescuentosActuales = Number(existentes?.[0]?.otros_descuentos || 0);
    
    // Acumular: sumar nuevo valor al anterior
    const adelantoFinal = adelantoActual + adelantoNuevo;
    const deudas = deudasActuales + descuentosNuevo;

    await db.query(
      `INSERT INTO rrhh_asistencia_ajustes (empleado_id, semana_inicio, bonificacion, adelanto, deudas, otros_descuentos)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         bonificacion = VALUES(bonificacion),
         adelanto = VALUES(adelanto),
         deudas = VALUES(deudas),
         otros_descuentos = VALUES(otros_descuentos),
         updated_at = CURRENT_TIMESTAMP`,
      [empleadoId, periodoInicio, bonificacion, adelantoFinal, deudas, otrosDescuentosActuales]
    );

    const d = new Date(periodoInicio);
    const totals = await computeMonthlyTotals(empleadoId, d.getFullYear(), d.getMonth() + 1, periodoInicio);

    return res.json({
      success: true,
      empleado_id: empleadoId,
      dias_trabajados: totals.diasTrabajados,
      importe: totals.importe,
      neto: totals.neto
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
