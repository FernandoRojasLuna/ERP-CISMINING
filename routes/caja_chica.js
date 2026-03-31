const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

const TIPOS_DOCUMENTO = ['Boleta', 'Factura', 'Recibo por Honorarios', 'Vale Provisional'];
const CATEGORIAS_CAJA_CHICA = [
  'Movilidad',
  'Alimentacion',
  'Compras Menores',
  'Peajes',
  'Fletes',
  'Ferreteria Menor',
  'Otros'
];

const uploadDir = path.join(__dirname, '..', 'uploads', 'caja_chica');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path.basename(file.originalname || 'comprobante', ext)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'comprobante';
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    if (allowed.has(file.mimetype)) return cb(null, true);
    cb(new Error('Solo se permiten archivos PDF, JPG, PNG o WEBP.'));
  }
});

function parseMoney(value, fallback = 0) {
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Number(n.toFixed(2));
}

function toUpperClean(value) {
  return String(value || '').trim().toUpperCase();
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

  if (periodo === 'ultimos_3_meses') {
    const desdeDate = new Date(year, month - 2, 1);
    const desde = `${desdeDate.getFullYear()}-${pad(desdeDate.getMonth() + 1)}-01`;
    const hasta = new Date(year, month + 1, 0);
    return { desde, hasta: `${hasta.getFullYear()}-${pad(hasta.getMonth() + 1)}-${pad(hasta.getDate())}` };
  }

  if (periodo === 'ultimos_6_meses') {
    const desdeDate = new Date(year, month - 5, 1);
    const desde = `${desdeDate.getFullYear()}-${pad(desdeDate.getMonth() + 1)}-01`;
    const hasta = new Date(year, month + 1, 0);
    return { desde, hasta: `${hasta.getFullYear()}-${pad(hasta.getMonth() + 1)}-${pad(hasta.getDate())}` };
  }

  if (periodo === 'anio_actual') {
    return { desde: `${year}-01-01`, hasta: `${year}-12-31` };
  }

  return { desde: '', hasta: '' };
}

function buildReturnQuery(body, proyectoIdFallback) {
  const params = new URLSearchParams();
  const proyectoId = Number(body?.proyecto_id || proyectoIdFallback || 0);
  if (proyectoId) params.set('proyecto_id', String(proyectoId));
  if (body?.periodo) params.set('periodo', String(body.periodo));
  if (body?.desde) params.set('desde', String(body.desde));
  if (body?.hasta) params.set('hasta', String(body.hasta));
  return params.toString();
}

function parseFiltrosFromQuery(query) {
  const filtros = {
    periodo: query?.periodo || 'mes_actual',
    desde: query?.desde || '',
    hasta: query?.hasta || ''
  };

  if (!filtros.desde && !filtros.hasta && filtros.periodo) {
    const rango = getRangoPeriodo(filtros.periodo);
    filtros.desde = rango.desde;
    filtros.hasta = rango.hasta;
  }

  return filtros;
}

function toCsvValue(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const escaped = raw.replace(/"/g, '""');
  return `"${escaped}"`;
}

async function hasEstadoPagoColumn() {
  const [rows] = await db.query("SHOW COLUMNS FROM asientos_contables LIKE 'estado_pago'");
  return Array.isArray(rows) && rows.length > 0;
}

async function hasRegistradoPorColumn() {
  const [rows] = await db.query("SHOW COLUMNS FROM asientos_contables LIKE 'registrado_por'");
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureCajaChicaSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS caja_chica_fondos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      proyecto_id INT NOT NULL,
      responsable_user_id INT NULL,
      monto_fijo DECIMAL(12,2) NOT NULL DEFAULT 2000.00,
      limite_gasto_individual DECIMAL(12,2) NOT NULL DEFAULT 300.00,
      umbral_alerta_pct DECIMAL(5,2) NOT NULL DEFAULT 20.00,
      saldo_actual DECIMAL(12,2) NOT NULL DEFAULT 2000.00,
      estado ENUM('Activo','Cerrado') NOT NULL DEFAULT 'Activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_caja_chica_fondo_proyecto_activo (proyecto_id, estado),
      CONSTRAINT fk_caja_chica_fondo_proyecto FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
      CONSTRAINT fk_caja_chica_fondo_responsable FOREIGN KEY (responsable_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS caja_chica_liquidaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fondo_id INT NOT NULL,
      fecha_corte DATE NOT NULL,
      total_gastado DECIMAL(12,2) NOT NULL DEFAULT 0,
      total_vales INT NOT NULL DEFAULT 0,
      estado ENUM('Borrador','Aprobada','Reembolsada') NOT NULL DEFAULT 'Borrador',
      observaciones VARCHAR(255) NULL,
      aprobado_por_user_id INT NULL,
      aprobado_at DATETIME NULL,
      reembolsado_asiento_id INT NULL,
      created_by_user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_caja_chica_liq_fondo FOREIGN KEY (fondo_id) REFERENCES caja_chica_fondos(id) ON DELETE CASCADE,
      CONSTRAINT fk_caja_chica_liq_aprobador FOREIGN KEY (aprobado_por_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_caja_chica_liq_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_caja_chica_liq_asiento FOREIGN KEY (reembolsado_asiento_id) REFERENCES asientos_contables(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS caja_chica_vales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fondo_id INT NOT NULL,
      liquidacion_id INT NULL,
      fecha DATE NOT NULL,
      beneficiario VARCHAR(150) NOT NULL,
      tipo_documento VARCHAR(50) NOT NULL,
      numero_documento VARCHAR(60) NULL,
      categoria VARCHAR(80) NOT NULL,
      descripcion VARCHAR(255) NOT NULL,
      monto DECIMAL(12,2) NOT NULL,
      comprobante_url VARCHAR(255) NULL,
      estado ENUM('Pendiente','Rendido','Vencido','Liquidado') NOT NULL DEFAULT 'Pendiente',
      fecha_vencimiento DATETIME NULL,
      created_by_user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_caja_chica_vales_fondo_fecha (fondo_id, fecha),
      KEY idx_caja_chica_vales_estado (estado),
      CONSTRAINT fk_caja_chica_vale_fondo FOREIGN KEY (fondo_id) REFERENCES caja_chica_fondos(id) ON DELETE CASCADE,
      CONSTRAINT fk_caja_chica_vale_liquidacion FOREIGN KEY (liquidacion_id) REFERENCES caja_chica_liquidaciones(id) ON DELETE SET NULL,
      CONSTRAINT fk_caja_chica_vale_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `);

  if (!(await hasEstadoPagoColumn())) {
    await db.query("ALTER TABLE asientos_contables ADD COLUMN estado_pago ENUM('Pagado','Pendiente') NOT NULL DEFAULT 'Pagado' AFTER monto");
  }

  if (!(await hasRegistradoPorColumn())) {
    await db.query("ALTER TABLE asientos_contables ADD COLUMN registrado_por VARCHAR(120) NULL AFTER estado_pago");
    await db.query("UPDATE asientos_contables SET registrado_por = 'SISTEMA' WHERE registrado_por IS NULL OR TRIM(registrado_por) = ''");
  }
}

async function getOrCreateFondoByProyecto(proyectoId, userId) {
  const [[existing]] = await db.query(
    `SELECT f.*, p.nombre AS proyecto_nombre, u.username AS responsable_username
     FROM caja_chica_fondos f
     JOIN proyectos p ON p.id = f.proyecto_id
     LEFT JOIN users u ON u.id = f.responsable_user_id
     WHERE f.proyecto_id = ? AND f.estado = 'Activo'
     LIMIT 1`,
    [proyectoId]
  );

  if (existing) return existing;

  const [created] = await db.query(
    `INSERT INTO caja_chica_fondos
      (proyecto_id, responsable_user_id, monto_fijo, limite_gasto_individual, umbral_alerta_pct, saldo_actual, estado)
     VALUES (?, ?, 2000.00, 300.00, 20.00, 2000.00, 'Activo')`,
    [proyectoId, userId || null]
  );

  const [[fondo]] = await db.query(
    `SELECT f.*, p.nombre AS proyecto_nombre, u.username AS responsable_username
     FROM caja_chica_fondos f
     JOIN proyectos p ON p.id = f.proyecto_id
     LEFT JOIN users u ON u.id = f.responsable_user_id
     WHERE f.id = ?
     LIMIT 1`,
    [created.insertId]
  );

  return fondo;
}

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();

    await db.query(
      `UPDATE caja_chica_vales
       SET estado = 'Vencido'
       WHERE estado = 'Pendiente'
         AND tipo_documento = 'Vale Provisional'
         AND fecha_vencimiento IS NOT NULL
         AND fecha_vencimiento < NOW()`
    );

    const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
    const proyectosArr = Array.isArray(proyectos) ? proyectos : [];

    const filtros = parseFiltrosFromQuery(req.query);

    const [resumenProyectos] = await db.query(
      `SELECT
         p.id,
         p.nombre,
         f.id AS fondo_id,
         COALESCE(f.monto_fijo, 0) AS monto_fijo,
        COALESCE(f.limite_gasto_individual, 300) AS limite_gasto_individual,
         COALESCE(f.saldo_actual, 0) AS saldo_actual,
         COALESCE(f.umbral_alerta_pct, 20) AS umbral_alerta_pct,
         COALESCE(vp.total_pendiente, 0) AS total_pendiente,
         COALESCE(lr.ultimo_reembolso, 0) AS ultimo_reembolso
       FROM proyectos p
       LEFT JOIN caja_chica_fondos f
         ON f.proyecto_id = p.id AND f.estado = 'Activo'
       LEFT JOIN (
         SELECT v.fondo_id, ROUND(SUM(v.monto), 2) AS total_pendiente
         FROM caja_chica_vales v
         WHERE v.estado IN ('Pendiente', 'Vencido')
         GROUP BY v.fondo_id
       ) vp ON vp.fondo_id = f.id
       LEFT JOIN (
         SELECT l.fondo_id, MAX(l.total_gastado) AS ultimo_reembolso
         FROM caja_chica_liquidaciones l
         WHERE l.estado = 'Reembolsada'
         GROUP BY l.fondo_id
       ) lr ON lr.fondo_id = f.id
       ORDER BY p.nombre`
    );

    const proyectoIdRaw = Number(req.query.proyecto_id || 0);
    const proyectoId = proyectosArr.some((p) => Number(p.id) === proyectoIdRaw) ? proyectoIdRaw : 0;

    if (!proyectosArr.length) {
      return res.render('caja-chica/index', {
        title: 'Caja Chica',
        proyectos: [],
        proyectoId: '',
        fondo: null,
        stats: { saldoPct: 0, gastosPorRendir: 0, ultimoReembolsoMonto: 0, ultimoReembolsoFecha: null },
        valesRecientes: [],
        liquidaciones: [],
        resumenProyectos: [],
        filtros,
        tiposDocumento: TIPOS_DOCUMENTO,
        categorias: CATEGORIAS_CAJA_CHICA,
        panorama: { totalFondo: 0, totalSaldo: 0, totalPendiente: 0, proyectosEnAlerta: 0, proyectosConFondo: 0 },
        reporteResumenGeneral: {},
        message: null,
        error: 'No hay proyectos disponibles para configurar Caja Chica.'
      });
    }

    const panorama = (Array.isArray(resumenProyectos) ? resumenProyectos : []).reduce((acc, r) => {
      const montoFijo = Number(r.monto_fijo || 0);
      const saldoActual = Number(r.saldo_actual || 0);
      const totalPendiente = Number(r.total_pendiente || 0);
      const umbral = Number(r.umbral_alerta_pct || 20);
      const pctSaldo = montoFijo > 0 ? (saldoActual / montoFijo) * 100 : 0;
      const enAlerta = montoFijo > 0 && pctSaldo <= umbral;

      acc.totalFondo += montoFijo;
      acc.totalSaldo += saldoActual;
      acc.totalPendiente += totalPendiente;
      if (montoFijo > 0) acc.proyectosConFondo += 1;
      if (enAlerta) acc.proyectosEnAlerta += 1;
      return acc;
    }, {
      totalFondo: 0,
      totalSaldo: 0,
      totalPendiente: 0,
      proyectosEnAlerta: 0,
      proyectosConFondo: 0
    });

    const paramsGeneral = [];
    const whereGeneral = [];
    if (filtros.desde) {
      whereGeneral.push('v.fecha >= ?');
      paramsGeneral.push(filtros.desde);
    }
    if (filtros.hasta) {
      whereGeneral.push('v.fecha <= ?');
      paramsGeneral.push(filtros.hasta);
    }
    const whereGeneralSql = whereGeneral.length ? `WHERE ${whereGeneral.join(' AND ')}` : '';

    const [[reporteResumenGeneral]] = await db.query(
      `SELECT
         COUNT(*) AS total_vales,
         ROUND(COALESCE(SUM(v.monto), 0), 2) AS monto_total,
         ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Rendido' THEN v.monto ELSE 0 END), 0), 2) AS monto_rendido,
         ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Liquidado' THEN v.monto ELSE 0 END), 0), 2) AS monto_liquidado,
         ROUND(COALESCE(SUM(CASE WHEN v.estado IN ('Pendiente', 'Vencido') THEN v.monto ELSE 0 END), 0), 2) AS monto_por_rendir
       FROM caja_chica_vales v
       ${whereGeneralSql}`,
      paramsGeneral
    );

    if (!proyectoId) {
      return res.render('caja-chica/index', {
        title: 'Caja Chica',
        proyectos: proyectosArr,
        proyectoId: '',
        fondo: null,
        stats: { saldoPct: 0, gastosPorRendir: 0, ultimoReembolsoMonto: 0, ultimoReembolsoFecha: null },
        valesRecientes: [],
        liquidaciones: [],
        resumenProyectos: Array.isArray(resumenProyectos) ? resumenProyectos : [],
        reporteResumen: {},
        reporteCategorias: [],
        reporteDocumentos: [],
        reporteEstados: [],
        reporteMensual: [],
        reporteTopBeneficiarios: [],
        filtros,
        tiposDocumento: TIPOS_DOCUMENTO,
        categorias: CATEGORIAS_CAJA_CHICA,
        panorama,
        reporteResumenGeneral: reporteResumenGeneral || {},
        message: req.query.message ? decodeURIComponent(req.query.message) : null,
        error: req.query.error ? decodeURIComponent(req.query.error) : null
      });
    }

    const fondo = await getOrCreateFondoByProyecto(proyectoId, req.session?.user?.id);

    const paramsPendientes = [fondo.id];
    const wherePendientes = ['fondo_id = ?', "estado IN ('Pendiente', 'Vencido')"];
    if (filtros.desde) {
      wherePendientes.push('fecha >= ?');
      paramsPendientes.push(filtros.desde);
    }
    if (filtros.hasta) {
      wherePendientes.push('fecha <= ?');
      paramsPendientes.push(filtros.hasta);
    }

    const [[gastosPendientesRow]] = await db.query(
      `SELECT ROUND(COALESCE(SUM(monto), 0), 2) AS total
       FROM caja_chica_vales
       WHERE ${wherePendientes.join(' AND ')}`,
      paramsPendientes
    );

    const paramsReembolso = [fondo.id];
    const whereReembolso = ['fondo_id = ?', "estado = 'Reembolsada'"];
    if (filtros.desde) {
      whereReembolso.push('fecha_corte >= ?');
      paramsReembolso.push(filtros.desde);
    }
    if (filtros.hasta) {
      whereReembolso.push('fecha_corte <= ?');
      paramsReembolso.push(filtros.hasta);
    }

    const [[ultimoReembolso]] = await db.query(
      `SELECT total_gastado, fecha_corte
       FROM caja_chica_liquidaciones
       WHERE ${whereReembolso.join(' AND ')}
       ORDER BY id DESC
       LIMIT 1`,
      paramsReembolso
    );

    const paramsVales = [fondo.id];
    let whereVales = 'v.fondo_id = ?';
    if (filtros.desde) {
      whereVales += ' AND v.fecha >= ?';
      paramsVales.push(filtros.desde);
    }
    if (filtros.hasta) {
      whereVales += ' AND v.fecha <= ?';
      paramsVales.push(filtros.hasta);
    }

    const [valesRecientes] = await db.query(
      `SELECT
         v.id,
         v.fecha,
         UPPER(TRIM(v.beneficiario)) AS beneficiario,
         v.tipo_documento,
         v.numero_documento,
         v.categoria,
         v.descripcion,
         v.monto,
         v.comprobante_url,
         v.estado,
         v.fecha_vencimiento,
         l.id AS liquidacion_codigo
       FROM caja_chica_vales v
       LEFT JOIN caja_chica_liquidaciones l ON l.id = v.liquidacion_id
       WHERE ${whereVales}
       ORDER BY v.id DESC
       LIMIT 50`,
      paramsVales
    );

    const paramsLiquidaciones = [fondo.id];
    let whereLiquidaciones = 'l.fondo_id = ?';
    if (filtros.desde) {
      whereLiquidaciones += ' AND l.fecha_corte >= ?';
      paramsLiquidaciones.push(filtros.desde);
    }
    if (filtros.hasta) {
      whereLiquidaciones += ' AND l.fecha_corte <= ?';
      paramsLiquidaciones.push(filtros.hasta);
    }

    const [liquidaciones] = await db.query(
      `SELECT
         l.*,
         a.id AS asiento_id,
         a.fecha AS asiento_fecha,
         a.monto AS asiento_monto
       FROM caja_chica_liquidaciones l
       LEFT JOIN asientos_contables a ON a.id = l.reembolsado_asiento_id
       WHERE ${whereLiquidaciones}
       ORDER BY l.id DESC
       LIMIT 30`,
      paramsLiquidaciones
    );

    const paramsReporteBase = [fondo.id];
    let whereReporteBase = 'v.fondo_id = ?';
    if (filtros.desde) {
      whereReporteBase += ' AND v.fecha >= ?';
      paramsReporteBase.push(filtros.desde);
    }
    if (filtros.hasta) {
      whereReporteBase += ' AND v.fecha <= ?';
      paramsReporteBase.push(filtros.hasta);
    }

    const [[reporteResumen]] = await db.query(
      `SELECT
         COUNT(*) AS total_vales,
         ROUND(COALESCE(SUM(v.monto), 0), 2) AS monto_total,
         ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Rendido' THEN v.monto ELSE 0 END), 0), 2) AS monto_rendido,
         ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Liquidado' THEN v.monto ELSE 0 END), 0), 2) AS monto_liquidado,
         ROUND(COALESCE(SUM(CASE WHEN v.estado IN ('Pendiente', 'Vencido') THEN v.monto ELSE 0 END), 0), 2) AS monto_por_rendir,
         SUM(CASE WHEN v.tipo_documento = 'Vale Provisional' THEN 1 ELSE 0 END) AS vales_provisionales,
         SUM(CASE WHEN v.estado = 'Vencido' THEN 1 ELSE 0 END) AS vales_vencidos
       FROM caja_chica_vales v
       WHERE ${whereReporteBase}`,
      paramsReporteBase
    );

    const [reporteCategorias] = await db.query(
      `SELECT
         v.categoria,
         COUNT(*) AS cantidad,
         ROUND(COALESCE(SUM(v.monto), 0), 2) AS total
       FROM caja_chica_vales v
       WHERE ${whereReporteBase}
       GROUP BY v.categoria
       ORDER BY total DESC`,
      paramsReporteBase
    );

    const [reporteDocumentos] = await db.query(
      `SELECT
         v.tipo_documento,
         COUNT(*) AS cantidad,
         ROUND(COALESCE(SUM(v.monto), 0), 2) AS total
       FROM caja_chica_vales v
       WHERE ${whereReporteBase}
       GROUP BY v.tipo_documento
       ORDER BY total DESC`,
      paramsReporteBase
    );

    const [reporteEstados] = await db.query(
      `SELECT
         v.estado,
         COUNT(*) AS cantidad,
         ROUND(COALESCE(SUM(v.monto), 0), 2) AS total
       FROM caja_chica_vales v
       WHERE ${whereReporteBase}
       GROUP BY v.estado
       ORDER BY total DESC`,
      paramsReporteBase
    );

    const [reporteMensual] = await db.query(
      `SELECT
         DATE_FORMAT(v.fecha, '%Y-%m') AS periodo,
         COUNT(*) AS cantidad,
         ROUND(COALESCE(SUM(v.monto), 0), 2) AS total
       FROM caja_chica_vales v
       WHERE ${whereReporteBase}
       GROUP BY DATE_FORMAT(v.fecha, '%Y-%m')
       ORDER BY periodo`,
      paramsReporteBase
    );

    const [reporteTopBeneficiarios] = await db.query(
      `SELECT
         UPPER(TRIM(v.beneficiario)) AS beneficiario,
         COUNT(*) AS cantidad,
         ROUND(COALESCE(SUM(v.monto), 0), 2) AS total
       FROM caja_chica_vales v
       WHERE ${whereReporteBase}
       GROUP BY UPPER(TRIM(v.beneficiario))
       ORDER BY total DESC
       LIMIT 5`,
      paramsReporteBase
    );

    const saldoPct = Number(fondo.monto_fijo || 0) > 0
      ? (Number(fondo.saldo_actual || 0) / Number(fondo.monto_fijo || 0)) * 100
      : 0;

    return res.render('caja-chica/index', {
      title: 'Caja Chica',
      proyectos: proyectosArr,
      proyectoId,
      fondo,
      stats: {
        saldoPct,
        gastosPorRendir: Number(gastosPendientesRow?.total || 0),
        ultimoReembolsoMonto: Number(ultimoReembolso?.total_gastado || 0),
        ultimoReembolsoFecha: ultimoReembolso?.fecha_corte || null
      },
      valesRecientes: Array.isArray(valesRecientes) ? valesRecientes : [],
      liquidaciones: Array.isArray(liquidaciones) ? liquidaciones : [],
      resumenProyectos: Array.isArray(resumenProyectos) ? resumenProyectos : [],
      reporteResumen: reporteResumen || {},
      reporteCategorias: Array.isArray(reporteCategorias) ? reporteCategorias : [],
      reporteDocumentos: Array.isArray(reporteDocumentos) ? reporteDocumentos : [],
      reporteEstados: Array.isArray(reporteEstados) ? reporteEstados : [],
      reporteMensual: Array.isArray(reporteMensual) ? reporteMensual : [],
      reporteTopBeneficiarios: Array.isArray(reporteTopBeneficiarios) ? reporteTopBeneficiarios : [],
      filtros,
      tiposDocumento: TIPOS_DOCUMENTO,
      categorias: CATEGORIAS_CAJA_CHICA,
      panorama,
      reporteResumenGeneral: reporteResumenGeneral || {},
      message: req.query.message ? decodeURIComponent(req.query.message) : null,
      error: req.query.error ? decodeURIComponent(req.query.error) : null
    });
  } catch (error) {
    next(error);
  }
});

router.get('/reporte.csv', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();

    const filtros = parseFiltrosFromQuery(req.query);
    const proyectoId = Number(req.query.proyecto_id || 0);

    if (!proyectoId) {
      return res.status(400).send('Selecciona un proyecto para exportar reporte.');
    }

    const [[fondo]] = await db.query(
      `SELECT f.id, p.nombre AS proyecto_nombre
       FROM caja_chica_fondos f
       JOIN proyectos p ON p.id = f.proyecto_id
       WHERE f.proyecto_id = ? AND f.estado = 'Activo'
       LIMIT 1`,
      [proyectoId]
    );

    if (!fondo) {
      return res.status(404).send('No existe fondo activo para el proyecto seleccionado.');
    }

    const params = [fondo.id];
    let whereSql = 'v.fondo_id = ?';
    if (filtros.desde) {
      whereSql += ' AND v.fecha >= ?';
      params.push(filtros.desde);
    }
    if (filtros.hasta) {
      whereSql += ' AND v.fecha <= ?';
      params.push(filtros.hasta);
    }

    const [rows] = await db.query(
      `SELECT
         v.fecha,
         UPPER(TRIM(v.beneficiario)) AS beneficiario,
         v.tipo_documento,
         v.numero_documento,
         v.categoria,
         v.descripcion,
         v.estado,
         ROUND(v.monto, 2) AS monto,
         l.id AS liquidacion_id,
         l.estado AS liquidacion_estado
       FROM caja_chica_vales v
       LEFT JOIN caja_chica_liquidaciones l ON l.id = v.liquidacion_id
       WHERE ${whereSql}
       ORDER BY v.fecha DESC, v.id DESC`,
      params
    );

    const headers = [
      'Proyecto',
      'Desde',
      'Hasta',
      'Fecha',
      'Beneficiario',
      'Tipo Documento',
      'Numero Documento',
      'Categoria',
      'Descripcion',
      'Estado Vale',
      'Monto',
      'Liquidacion',
      'Estado Liquidacion'
    ];

    const csvRows = [headers.map(toCsvValue).join(',')];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      csvRows.push([
        fondo.proyecto_nombre,
        filtros.desde || '',
        filtros.hasta || '',
        row.fecha || '',
        row.beneficiario || '',
        row.tipo_documento || '',
        row.numero_documento || '',
        row.categoria || '',
        row.descripcion || '',
        row.estado || '',
        row.monto || 0,
        row.liquidacion_id || '',
        row.liquidacion_estado || ''
      ].map(toCsvValue).join(','));
    });

    const filename = `reporte_caja_chica_${String(fondo.proyecto_nombre || 'proyecto').replace(/\s+/g, '_').toLowerCase()}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvRows.join('\n'));
  } catch (error) {
    next(error);
  }
});

router.post('/fondo', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();
    const returnQuery = buildReturnQuery(req.body);

    const proyectoId = Number(req.body.proyecto_id || 0);
    const montoFijo = parseMoney(req.body.monto_fijo);
    const limite = parseMoney(req.body.limite_gasto_individual);
    const umbral = parseMoney(req.body.umbral_alerta_pct, 20);

    if (!proyectoId || montoFijo <= 0 || limite <= 0) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('Configura montos validos para el fondo fijo.'));
    }

    const [[fondo]] = await db.query(
      `SELECT id, saldo_actual
       FROM caja_chica_fondos
       WHERE proyecto_id = ? AND estado = 'Activo'
       LIMIT 1`,
      [proyectoId]
    );

    if (fondo) {
      const saldoAjustado = Number(fondo.saldo_actual) > montoFijo ? montoFijo : Number(fondo.saldo_actual || 0);
      await db.query(
        `UPDATE caja_chica_fondos
         SET responsable_user_id = ?, monto_fijo = ?, limite_gasto_individual = ?, umbral_alerta_pct = ?, saldo_actual = ?
         WHERE id = ?`,
        [req.session?.user?.id || null, montoFijo, limite, umbral, saldoAjustado, fondo.id]
      );
    } else {
      await db.query(
        `INSERT INTO caja_chica_fondos
          (proyecto_id, responsable_user_id, monto_fijo, limite_gasto_individual, umbral_alerta_pct, saldo_actual, estado)
         VALUES (?, ?, ?, ?, ?, ?, 'Activo')`,
        [proyectoId, req.session?.user?.id || null, montoFijo, limite, umbral, montoFijo]
      );
    }

    return res.redirect('/caja-chica?' + returnQuery + '&message=' + encodeURIComponent('✓ Fondo de Caja Chica actualizado.'));
  } catch (error) {
    next(error);
  }
});

router.post('/vales', requireRole('admin'), upload.single('comprobante'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();
    const returnQuery = buildReturnQuery(req.body);

    const proyectoId = Number(req.body.proyecto_id || 0);
    const fecha = req.body.fecha;
    const beneficiario = toUpperClean(req.body.beneficiario);
    const tipoDocumento = String(req.body.tipo_documento || '').trim();
    const categoria = String(req.body.categoria || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const numeroDocumento = String(req.body.numero_documento || '').trim();
    const monto = parseMoney(req.body.monto);

    const [[fondo]] = await db.query(
      `SELECT id, limite_gasto_individual, saldo_actual, monto_fijo
       FROM caja_chica_fondos
       WHERE proyecto_id = ? AND estado = 'Activo'
       LIMIT 1`,
      [proyectoId]
    );

    if (!fondo) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('No existe fondo activo para este proyecto.'));
    }

    if (!fecha || !beneficiario || !descripcion || monto <= 0 || !TIPOS_DOCUMENTO.includes(tipoDocumento) || !categoria) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('Completa los datos obligatorios del vale.'));
    }

    if (monto > Number(fondo.limite_gasto_individual || 0)) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('El monto supera el limite individual permitido para Caja Chica.'));
    }

    if (monto > Number(fondo.saldo_actual || 0)) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('Saldo insuficiente en Caja Chica para registrar este vale.'));
    }

    if (tipoDocumento !== 'Vale Provisional' && !req.file) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('Adjunta un comprobante para registrar este gasto.'));
    }

    let estado = 'Rendido';
    let fechaVencimiento = null;
    if (tipoDocumento === 'Vale Provisional') {
      estado = 'Pendiente';
      fechaVencimiento = req.body.fecha_vencimiento
        ? `${req.body.fecha_vencimiento} 23:59:59`
        : null;
    }

    const comprobanteUrl = req.file ? `/uploads/caja_chica/${req.file.filename}` : null;

    await db.query(
      `INSERT INTO caja_chica_vales
        (fondo_id, fecha, beneficiario, tipo_documento, numero_documento, categoria, descripcion, monto, comprobante_url, estado, fecha_vencimiento, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fondo.id,
        fecha,
        beneficiario,
        tipoDocumento,
        numeroDocumento || null,
        categoria,
        descripcion,
        monto,
        comprobanteUrl,
        estado,
        fechaVencimiento,
        req.session?.user?.id || null
      ]
    );

    await db.query(
      'UPDATE caja_chica_fondos SET saldo_actual = ROUND(saldo_actual - ?, 2) WHERE id = ?',
      [monto, fondo.id]
    );

    return res.redirect('/caja-chica?' + returnQuery + '&message=' + encodeURIComponent('✓ Vale de Caja Chica registrado.'));
  } catch (error) {
    next(error);
  }
});

router.post('/vales/:id/rendir', requireRole('admin'), upload.single('comprobante_rendir'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();
    const returnQuery = buildReturnQuery(req.body);

    const valeId = Number(req.params.id || 0);
    const proyectoId = Number(req.body.proyecto_id || 0);
    const tipoFinal = String(req.body.tipo_documento_final || 'Boleta');
    const numeroDocumento = String(req.body.numero_documento_final || '').trim();

    if (!valeId || !proyectoId) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('Solicitud invalida para rendir vale.'));
    }

    if (!TIPOS_DOCUMENTO.includes(tipoFinal) || tipoFinal === 'Vale Provisional') {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('Selecciona un documento final valido para rendicion.'));
    }

    if (!req.file) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('Adjunta el comprobante de rendicion.'));
    }

    const [[vale]] = await db.query(
      `SELECT v.id, v.fondo_id, f.proyecto_id
       FROM caja_chica_vales v
       JOIN caja_chica_fondos f ON f.id = v.fondo_id
       WHERE v.id = ?
       LIMIT 1`,
      [valeId]
    );

    if (!vale || Number(vale.proyecto_id) !== proyectoId) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('No se encontro el vale solicitado.'));
    }

    await db.query(
      `UPDATE caja_chica_vales
       SET tipo_documento = ?, numero_documento = ?, comprobante_url = ?, estado = 'Rendido', fecha_vencimiento = NULL
       WHERE id = ?`,
      [tipoFinal, numeroDocumento || null, `/uploads/caja_chica/${req.file.filename}`, valeId]
    );

    return res.redirect('/caja-chica?' + returnQuery + '&message=' + encodeURIComponent('✓ Vale provisional rendido correctamente.'));
  } catch (error) {
    next(error);
  }
});

router.post('/liquidaciones/generar', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();
    const returnQuery = buildReturnQuery(req.body);

    const proyectoId = Number(req.body.proyecto_id || 0);
    const observaciones = String(req.body.observaciones || '').trim();

    const [[fondo]] = await db.query(
      'SELECT id FROM caja_chica_fondos WHERE proyecto_id = ? AND estado = \"Activo\" LIMIT 1',
      [proyectoId]
    );

    if (!fondo) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('No existe fondo activo para este proyecto.'));
    }

    const [vales] = await db.query(
      `SELECT id, monto
       FROM caja_chica_vales
       WHERE fondo_id = ?
         AND estado = 'Rendido'
         AND liquidacion_id IS NULL`,
      [fondo.id]
    );

    if (!Array.isArray(vales) || !vales.length) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('No hay gastos rendidos pendientes para liquidar.'));
    }

    const totalGastado = Number(vales.reduce((acc, row) => acc + Number(row.monto || 0), 0).toFixed(2));

    const [liqResult] = await db.query(
      `INSERT INTO caja_chica_liquidaciones
        (fondo_id, fecha_corte, total_gastado, total_vales, estado, observaciones, aprobado_por_user_id, aprobado_at, created_by_user_id)
       VALUES (?, CURDATE(), ?, ?, 'Aprobada', ?, ?, NOW(), ?)`,
      [fondo.id, totalGastado, vales.length, observaciones || null, req.session?.user?.id || null, req.session?.user?.id || null]
    );

    const ids = vales.map((v) => Number(v.id));
    await db.query(
      `UPDATE caja_chica_vales
       SET estado = 'Liquidado', liquidacion_id = ?
       WHERE id IN (?)`,
      [liqResult.insertId, ids]
    );

    return res.redirect('/caja-chica?' + returnQuery + '&message=' + encodeURIComponent('✓ Liquidacion generada y enviada a reposicion.'));
  } catch (error) {
    next(error);
  }
});

router.post('/liquidaciones/:id/reembolsar', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();
    const returnQuery = buildReturnQuery(req.body);

    const liquidacionId = Number(req.params.id || 0);
    const proyectoId = Number(req.body.proyecto_id || 0);

    const [[liq]] = await db.query(
      `SELECT
         l.id,
         l.fondo_id,
         l.total_gastado,
         l.total_vales,
         l.estado,
         l.reembolsado_asiento_id,
         f.proyecto_id,
         f.monto_fijo,
         f.saldo_actual
       FROM caja_chica_liquidaciones l
       JOIN caja_chica_fondos f ON f.id = l.fondo_id
       WHERE l.id = ?
       LIMIT 1`,
      [liquidacionId]
    );

    if (!liq || Number(liq.proyecto_id) !== proyectoId) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('No se encontro la liquidacion seleccionada.'));
    }

    if (liq.reembolsado_asiento_id) {
      return res.redirect('/caja-chica?' + returnQuery + '&message=' + encodeURIComponent('La liquidacion ya fue reembolsada.'));
    }

    const tipoReposicion = String(req.body.reposicion_tipo || 'completar_fondo').trim();
    const montoPersonalizado = parseMoney(req.body.monto_reposicion, 0);
    const saldoActual = Number(liq.saldo_actual || 0);
    const montoFijo = Number(liq.monto_fijo || 0);
    const montoPendienteParaCompletar = Number(Math.max(0, montoFijo - saldoActual).toFixed(2));

    if (tipoReposicion === 'sin_reposicion') {
      return res.redirect('/caja-chica?' + returnQuery + '&message=' + encodeURIComponent('No se ejecuto la reposicion. La liquidacion permanece pendiente de reembolso.'));
    }

    let montoReposicion = 0;
    if (tipoReposicion === 'igual_liquidacion') {
      montoReposicion = Number(liq.total_gastado || 0);
    } else if (tipoReposicion === 'personalizado') {
      montoReposicion = montoPersonalizado;
    } else {
      montoReposicion = montoPendienteParaCompletar;
    }

    montoReposicion = Number(montoReposicion.toFixed(2));
    if (montoReposicion <= 0) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent('El monto de reposicion debe ser mayor a 0.'));
    }

    if (montoReposicion > montoPendienteParaCompletar) {
      return res.redirect('/caja-chica?' + returnQuery + '&error=' + encodeURIComponent(`El monto excede el faltante para completar el fondo (S/ ${montoPendienteParaCompletar.toFixed(2)}).`));
    }

    const registradoPor = String(req.session?.user?.username || req.session?.user?.nombre || 'SISTEMA').toUpperCase();
    const descripcion = `Reposicion Caja Chica - Liquidacion #${liq.id} (${liq.total_vales} vales)`;

    const [asientoResult] = await db.query(
      `INSERT INTO asientos_contables
        (fecha, tipo, categoria, descripcion, monto, estado_pago, registrado_por, proyecto_id)
       VALUES (CURDATE(), 'Egreso', 'Caja Chica - Reembolso', ?, ?, 'Pagado', ?, ?)`,
      [descripcion, montoReposicion, registradoPor, liq.proyecto_id]
    );

    await db.query(
      `UPDATE caja_chica_liquidaciones
       SET estado = 'Reembolsada', reembolsado_asiento_id = ?, aprobado_por_user_id = COALESCE(aprobado_por_user_id, ?), aprobado_at = COALESCE(aprobado_at, NOW())
       WHERE id = ?`,
      [asientoResult.insertId, req.session?.user?.id || null, liq.id]
    );

    await db.query(
      `UPDATE caja_chica_fondos
       SET saldo_actual = LEAST(monto_fijo, ROUND(saldo_actual + ?, 2))
       WHERE id = ?`,
      [montoReposicion, liq.fondo_id]
    );

    return res.redirect('/caja-chica?' + returnQuery + '&message=' + encodeURIComponent('✓ Reembolso ejecutado segun el monto seleccionado y asiento contable generado.'));
  } catch (error) {
    next(error);
  }
});

// Ruta para generar reporte PDF con estilo corporativo
router.get('/reporte.pdf', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureCajaChicaSchema();

    const [proyectos] = await db.query('SELECT id, nombre FROM proyectos ORDER BY nombre');
    const proyectosArr = Array.isArray(proyectos) ? proyectos : [];

    const filtros = parseFiltrosFromQuery(req.query);
    const proyectoId = req.query.proyecto_id ? Number(req.query.proyecto_id) : null;
    const esConsolidado = !proyectoId || proyectoId === 0;

    let fondoActual = null;
    let reporteResumen = {};
    let reporteCategorias = [];
    let reporteDocumentos = [];
    let reporteTopBeneficiarios = [];
    let datosProyectos = [];
    let valesDetalle = [];

    if (esConsolidado) {
      // Reporte consolidado: información de todos los proyectos
      const [proyectosConFondos] = await db.query(
        `SELECT
           p.id, p.nombre,
           f.id AS fondo_id,
           COALESCE(f.monto_fijo, 0) AS monto_fijo,
           COALESCE(f.saldo_actual, 0) AS saldo_actual,
           COALESCE(vp.total_pendiente, 0) AS total_pendiente,
           COALESCE(lr.ultimo_reembolso, 0) AS ultimo_reembolso
         FROM proyectos p
         LEFT JOIN caja_chica_fondos f ON f.proyecto_id = p.id AND f.estado = 'Activo'
         LEFT JOIN (SELECT v.fondo_id, ROUND(SUM(v.monto), 2) AS total_pendiente FROM caja_chica_vales v WHERE v.estado IN ('Pendiente', 'Vencido') GROUP BY v.fondo_id) vp ON vp.fondo_id = f.id
         LEFT JOIN (SELECT l.fondo_id, MAX(l.total_gastado) AS ultimo_reembolso FROM caja_chica_liquidaciones l WHERE l.estado = 'Reembolsada' GROUP BY l.fondo_id) lr ON lr.fondo_id = f.id
         ORDER BY p.nombre`
      );
      datosProyectos = proyectosConFondos;

      const paramsConsolidado = [];
      let whereConsolidado = '1=1';
      if (filtros.desde) {
        whereConsolidado += ' AND v.fecha >= ?';
        paramsConsolidado.push(filtros.desde);
      }
      if (filtros.hasta) {
        whereConsolidado += ' AND v.fecha <= ?';
        paramsConsolidado.push(filtros.hasta);
      }

      const [[resConsolidado]] = await db.query(
        `SELECT COUNT(*) AS total_vales, ROUND(COALESCE(SUM(v.monto), 0), 2) AS monto_total, ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Rendido' THEN v.monto ELSE 0 END), 0), 2) AS monto_rendido, ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Liquidado' THEN v.monto ELSE 0 END), 0), 2) AS monto_liquidado, ROUND(COALESCE(SUM(CASE WHEN v.estado IN ('Pendiente', 'Vencido') THEN v.monto ELSE 0 END), 0), 2) AS monto_por_rendir FROM caja_chica_vales v WHERE ${whereConsolidado}`,
        paramsConsolidado
      );
      reporteResumen = resConsolidado || {};

      const [catConsolidado] = await db.query(`SELECT v.categoria, COUNT(*) AS cantidad, ROUND(COALESCE(SUM(v.monto), 0), 2) AS total FROM caja_chica_vales v WHERE ${whereConsolidado} GROUP BY v.categoria ORDER BY total DESC`, paramsConsolidado);
      reporteCategorias = catConsolidado;

      const [docConsolidado] = await db.query(`SELECT v.tipo_documento, COUNT(*) AS cantidad, ROUND(COALESCE(SUM(v.monto), 0), 2) AS total FROM caja_chica_vales v WHERE ${whereConsolidado} GROUP BY v.tipo_documento ORDER BY total DESC`, paramsConsolidado);
      reporteDocumentos = docConsolidado;

      const [benConsolidado] = await db.query(`SELECT v.beneficiario, COUNT(*) AS cantidad, ROUND(COALESCE(SUM(v.monto), 0), 2) AS total FROM caja_chica_vales v WHERE ${whereConsolidado} GROUP BY v.beneficiario ORDER BY total DESC LIMIT 8`, paramsConsolidado);
      reporteTopBeneficiarios = benConsolidado;

      const [valesConsolidado] = await db.query(
        `SELECT
           p.nombre AS proyecto_nombre,
           v.fecha,
           v.beneficiario,
           v.categoria,
           v.tipo_documento,
           v.numero_documento,
           v.monto,
           v.estado
         FROM caja_chica_vales v
         JOIN caja_chica_fondos f ON f.id = v.fondo_id
         JOIN proyectos p ON p.id = f.proyecto_id
         WHERE ${whereConsolidado}
         ORDER BY v.fecha DESC, v.id DESC
         LIMIT 80`,
        paramsConsolidado
      );
      valesDetalle = valesConsolidado;
    } else {
      fondoActual = await getOrCreateFondoByProyecto(proyectoId, req.session?.user?.id);

      const paramsProyecto = [fondoActual.id];
      let whereProyecto = 'v.fondo_id = ?';
      if (filtros.desde) {
        whereProyecto += ' AND v.fecha >= ?';
        paramsProyecto.push(filtros.desde);
      }
      if (filtros.hasta) {
        whereProyecto += ' AND v.fecha <= ?';
        paramsProyecto.push(filtros.hasta);
      }

      const [[resProyecto]] = await db.query(`SELECT COUNT(*) AS total_vales, ROUND(COALESCE(SUM(v.monto), 0), 2) AS monto_total, ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Rendido' THEN v.monto ELSE 0 END), 0), 2) AS monto_rendido, ROUND(COALESCE(SUM(CASE WHEN v.estado = 'Liquidado' THEN v.monto ELSE 0 END), 0), 2) AS monto_liquidado, ROUND(COALESCE(SUM(CASE WHEN v.estado IN ('Pendiente', 'Vencido') THEN v.monto ELSE 0 END), 0), 2) AS monto_por_rendir FROM caja_chica_vales v WHERE ${whereProyecto}`, paramsProyecto);
      reporteResumen = resProyecto || {};

      const [catProyecto] = await db.query(`SELECT v.categoria, COUNT(*) AS cantidad, ROUND(COALESCE(SUM(v.monto), 0), 2) AS total FROM caja_chica_vales v WHERE ${whereProyecto} GROUP BY v.categoria ORDER BY total DESC`, paramsProyecto);
      reporteCategorias = catProyecto;

      const [docProyecto] = await db.query(`SELECT v.tipo_documento, COUNT(*) AS cantidad, ROUND(COALESCE(SUM(v.monto), 0), 2) AS total FROM caja_chica_vales v WHERE ${whereProyecto} GROUP BY v.tipo_documento ORDER BY total DESC`, paramsProyecto);
      reporteDocumentos = docProyecto;

      const [benProyecto] = await db.query(`SELECT v.beneficiario, COUNT(*) AS cantidad, ROUND(COALESCE(SUM(v.monto), 0), 2) AS total FROM caja_chica_vales v WHERE ${whereProyecto} GROUP BY v.beneficiario ORDER BY total DESC LIMIT 8`, paramsProyecto);
      reporteTopBeneficiarios = benProyecto;

      const [valesProyecto] = await db.query(
        `SELECT
           NULL AS proyecto_nombre,
           v.fecha,
           v.beneficiario,
           v.categoria,
           v.tipo_documento,
           v.numero_documento,
           v.monto,
           v.estado
         FROM caja_chica_vales v
         WHERE ${whereProyecto}
         ORDER BY v.fecha DESC, v.id DESC
         LIMIT 80`,
        paramsProyecto
      );
      valesDetalle = valesProyecto;
    }

    const emitido = new Date().toLocaleDateString('es-PE');

    res.render('caja-chica/export_preview', {
      layout: false,
      title: esConsolidado ? 'Reporte Consolidado de Caja Chica' : 'Reporte de Caja Chica',
      esConsolidado,
      fondo: fondoActual,
      filtros,
      reporteResumen: reporteResumen || {},
      reporteCategorias: Array.isArray(reporteCategorias) ? reporteCategorias : [],
      reporteDocumentos: Array.isArray(reporteDocumentos) ? reporteDocumentos : [],
      reporteTopBeneficiarios: Array.isArray(reporteTopBeneficiarios) ? reporteTopBeneficiarios : [],
      datosProyectos: Array.isArray(datosProyectos) ? datosProyectos : [],
      valesDetalle: Array.isArray(valesDetalle) ? valesDetalle : [],
      emitido,
      autoPrint: req.query.auto_print !== '0'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
