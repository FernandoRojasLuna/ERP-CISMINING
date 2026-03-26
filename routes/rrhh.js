const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

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

async function ensureNominasSchema() {
  const [adelantoCols] = await db.query("SHOW COLUMNS FROM nominas LIKE 'adelanto_total'");
  if (!Array.isArray(adelantoCols) || !adelantoCols.length) {
    await db.query(
      'ALTER TABLE nominas ADD COLUMN adelanto_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER horas_extra'
    );
  }

  const [descuentoCols] = await db.query("SHOW COLUMNS FROM nominas LIKE 'descuentos_total'");
  if (!Array.isArray(descuentoCols) || !descuentoCols.length) {
    await db.query(
      'ALTER TABLE nominas ADD COLUMN descuentos_total DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER adelanto_total'
    );
  }
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

function getWeekDaysFromMonday(mondayDate) {
  const labels = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  return labels.map((label, index) => {
    const current = addDays(mondayDate, index);
    return {
      index,
      label,
      fecha: toIsoDate(current),
      esDomingo: index === 6
    };
  });
}

function getMonthWeeks(year, month) {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const firstMonday = getMonday(firstDay);
  const weeks = [];

  for (let i = 0; i < 7; i += 1) {
    const weekStart = addDays(firstMonday, i * 7);
    const weekEnd = addDays(weekStart, 6);
    if (weekStart > lastDay && weekEnd > lastDay) break;
    if (weekEnd < firstDay) continue;

    const startVisible = weekStart < firstDay ? firstDay : weekStart;
    const endVisible = weekEnd > lastDay ? lastDay : weekEnd;
    weeks.push({
      numero: weeks.length + 1,
      inicio: toIsoDate(weekStart),
      fin: toIsoDate(weekEnd),
      etiqueta: `Semana ${weeks.length + 1} (${toIsoDate(startVisible)} al ${toIsoDate(endVisible)})`
    });
  }

  return weeks;
}

function parsePositiveNumber(value) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
}

function getAsistenciaStatsByRows(rows) {
  const values = Array.isArray(rows) ? rows : [];
  const diasTrabajados = values.reduce((acc, item) => acc + (Number(item.asistio) === 1 ? 1 : 0), 0);
  const diasLunesSabado = values
    .filter((item) => {
      const d = new Date(item.fecha);
      const day = d.getDay();
      return day >= 1 && day <= 6;
    })
    .reduce((acc, item) => acc + (Number(item.asistio) === 1 ? 1 : 0), 0);

  return { diasTrabajados, diasLunesSabado };
}

async function syncSundayAuto(empleadoId, semanaInicioIso) {
  const monday = getMonday(semanaInicioIso);
  if (!monday) return;

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
}

async function buildAsistenciaData({ proyectoId, year, month, semanaNumero }) {
  const weeks = getMonthWeeks(year, month);
  const selectedWeek = weeks.find((w) => Number(w.numero) === Number(semanaNumero)) || weeks[0] || null;

  if (!selectedWeek) {
    return {
      filtros: { proyectoId: proyectoId || '', year, month, semana: 1 },
      semanas: [],
      weekDays: [],
      empleados: [],
      resumen: { trabajadores: 0, montoProyectado: 0 },
      semanaInicio: null,
      semanaFin: null
    };
  }

  const weekDays = getWeekDaysFromMonday(selectedWeek.inicio ? new Date(selectedWeek.inicio) : new Date());
  const weekStart = selectedWeek.inicio;
  const weekEnd = selectedWeek.fin;

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
      filtros: { proyectoId: proyectoId || '', year, month, semana: selectedWeek.numero },
      semanas: weeks,
      weekDays,
      empleados: [],
      resumen: { trabajadores: 0, montoProyectado: 0 },
      semanaInicio: weekStart,
      semanaFin: weekEnd
    };
  }

  const empleadoIds = empleados.map((e) => e.id);
  const [asistenciaRows] = await db.query(
    `SELECT empleado_id, fecha, asistio
     FROM rrhh_asistencias
     WHERE fecha BETWEEN ? AND ?
       AND empleado_id IN (?)`,
    [weekStart, weekEnd, empleadoIds]
  );

  const [ajustesRows] = await db.query(
    `SELECT empleado_id, bonificacion, adelanto, deudas, otros_descuentos
     FROM rrhh_asistencia_ajustes
     WHERE semana_inicio = ?
       AND empleado_id IN (?)`,
    [weekStart, empleadoIds]
  );

  const asistenciaMap = new Map();
  (Array.isArray(asistenciaRows) ? asistenciaRows : []).forEach((row) => {
    const fechaIso = toIsoDate(row.fecha);
    asistenciaMap.set(`${row.empleado_id}-${fechaIso}`, Number(row.asistio) === 1 ? 1 : 0);
  });

  const ajustesMap = new Map();
  (Array.isArray(ajustesRows) ? ajustesRows : []).forEach((row) => {
    ajustesMap.set(Number(row.empleado_id), {
      bonificacion: Number(row.bonificacion || 0),
      adelanto: Number(row.adelanto || 0),
      deudas: Number(row.deudas || 0),
      otros_descuentos: Number(row.otros_descuentos || 0)
    });
  });

  let montoProyectado = 0;
  const empleadosData = empleados.map((emp) => {
    const salario = Number(emp.salario || 0);
    const salarioDia = salario / 30;
    const ajustes = ajustesMap.get(Number(emp.id)) || {
      bonificacion: 0,
      adelanto: 0,
      deudas: 0,
      otros_descuentos: 0
    };

    const dias = weekDays.map((day) => {
      const key = `${emp.id}-${day.fecha}`;
      const asistio = asistenciaMap.has(key) ? asistenciaMap.get(key) : 0;
      return {
        ...day,
        asistio
      };
    });

    const diasTrabajados = dias.reduce((acc, day) => acc + (day.asistio ? 1 : 0), 0);
    const importe = diasTrabajados * salarioDia;
    const neto = importe + ajustes.bonificacion - ajustes.adelanto - ajustes.deudas - ajustes.otros_descuentos;
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
      deudas: ajustes.deudas,
      otrosDescuentos: ajustes.otros_descuentos,
      neto
    };
  });

  return {
    filtros: { proyectoId: proyectoId || '', year, month, semana: selectedWeek.numero },
    semanas: weeks,
    weekDays,
    empleados: empleadosData,
    resumen: {
      trabajadores: empleadosData.length,
      montoProyectado
    },
    semanaInicio: weekStart,
    semanaFin: weekEnd
  };
}

// ============================================================
// SECCIÓN: GESTIÓN DE USUARIOS (CRUD COMPLETO)
// ============================================================

// GET / - Listar usuarios y nómina
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();
    await ensureNominasSchema();

    let usuarios = [];
    let empleados = [];
    let empleadosActivos = [];
    let nomina = [];
    let proyectos = [];
    let asistencia = {
      filtros: {},
      semanas: [],
      weekDays: [],
      empleados: [],
      resumen: { trabajadores: 0, montoProyectado: 0 },
      semanaInicio: null,
      semanaFin: null
    };

    try {
      const [rows] = await db.query(`
        SELECT 
          u.id, 
          u.username, 
          u.role, 
          u.activo,
          u.empleado_id,
          e.nombre AS empleado_nombre,
          e.cargo,
          e.salario,
          p.nombre AS proyecto
        FROM users u
        LEFT JOIN empleados e ON e.id = u.empleado_id
        LEFT JOIN proyectos p ON p.id = e.proyecto_id
        ORDER BY u.id DESC
      `);
      usuarios = Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.error('Error consultando usuarios:', err.message);
      usuarios = [];
    }

    try {
      const [rows] = await db.query(`
        SELECT e.id, e.nombre, e.cargo, e.salario, e.estado, p.nombre AS proyecto
        FROM empleados e
        LEFT JOIN proyectos p ON p.id = e.proyecto_id
        ORDER BY e.nombre
      `);
      empleados = Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.error('Error consultando empleados:', err.message);
      empleados = [];
    }

    try {
      const [rows] = await db.query("SELECT id, nombre FROM empleados WHERE estado='Activo' ORDER BY nombre");
      empleadosActivos = Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.error('Error consultando empleados activos:', err.message);
      empleadosActivos = [];
    }

    try {
      proyectos = await getProyectos();
    } catch (err) {
      console.error('Error consultando proyectos:', err.message);
      proyectos = [];
    }

    try {
      const now = new Date();
      const month = Number(req.query.asistencia_mes || (now.getMonth() + 1));
      const year = Number(req.query.asistencia_anio || now.getFullYear());
      const semana = Number(req.query.asistencia_semana || 1);
      const proyectoId = req.query.asistencia_proyecto_id ? Number(req.query.asistencia_proyecto_id) : null;

      asistencia = await buildAsistenciaData({
        proyectoId,
        year,
        month,
        semanaNumero: semana
      });
    } catch (err) {
      console.error('Error consultando asistencias:', err.message);
    }

    try {
      const [rows] = await db.query(`
        SELECT 
          e.nombre, 
          n.periodo, 
          n.salario_base, 
          n.horas_extra,
          n.adelanto_total,
          n.descuentos_total,
          n.descuentos, 
          n.neto_pagar,
          n.empleado_id,
          n.adelanto_total AS adelanto_detail,
          n.descuentos_total AS descuentos_detail
        FROM nominas n
        JOIN empleados e ON e.id = n.empleado_id
        ORDER BY n.id DESC
        LIMIT 12
      `);
      nomina = Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.error('Error consultando nóminas:', err.message);
      nomina = [];
    }

    res.locals.usuarios = usuarios;
    res.locals.empleados = empleados;
    res.locals.empleadosActivos = empleadosActivos;
    res.locals.proyectos = proyectos;
    res.locals.nomina = nomina;
    res.locals.asistencia = asistencia;
    res.locals.message = req.query.message ? decodeURIComponent(req.query.message) : null;
    res.locals.error = req.query.error ? decodeURIComponent(req.query.error) : null;

    return res.render('rrhh/index', { 
      title: 'Recursos Humanos'
    });

  } catch (error) {
    console.error('Error critico en GET /rrhh:', error);
    return res.render('rrhh/index', { 
      title: 'Recursos Humanos',
      usuarios: [],
      empleados: [],
      nomina: [],
      message: null,
      error: 'Error al cargar datos: ' + error.message
    });
  }
});

// GET /usuarios/nuevo - Mostrar formulario de nuevo usuario
router.get('/usuarios/nuevo', requireRole('admin'), async (req, res, next) => {
  try {
    res.locals.proyectos = await getProyectos();
    res.locals.usuario = null;
    res.locals.errors = [];

    res.render('rrhh/form', { 
      title: 'Nuevo Usuario'
    });
  } catch (error) { 
    console.error('Error en GET /usuarios/nuevo:', error);
    next(error); 
  }
});

// GET /usuarios/:id/editar - Mostrar formulario de edición
router.get('/usuarios/:id/editar', requireRole('admin'), async (req, res, next) => {
  try {
    let usuario = null;

    try {
      const [rows] = await db.query(`
        SELECT 
          u.id,
          u.username,
          u.role,
          u.activo,
          u.empleado_id,
          e.nombre AS empleado_nombre,
          e.cargo AS empleado_cargo,
          e.salario AS empleado_salario,
          e.proyecto_id AS empleado_proyecto_id,
          e.estado AS empleado_estado
        FROM users u
        LEFT JOIN empleados e ON e.id = u.empleado_id
        WHERE u.id = ?
      `, [req.params.id]);
      usuario = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    } catch (dbError) {
      console.error('Error consultando usuario:', dbError);
    }

    if (!usuario) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Usuario no encontrado'
      });
    }

    res.locals.proyectos = await getProyectos();
    res.locals.usuario = usuario;
    res.locals.errors = [];

    res.render('rrhh/form', { 
      title: 'Editar Usuario'
    });
  } catch (error) { 
    console.error('Error en GET /usuarios/:id/editar:', error);
    next(error); 
  }
});

// POST /usuarios - Crear nuevo usuario
router.post('/usuarios', requireRole('admin'), [
  body('username')
    .trim()
    .notEmpty().withMessage('El usuario es requerido')
    .isLength({ min: 3 }).withMessage('El usuario debe tener al menos 3 caracteres')
    .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Solo letras, números, guiones y guiones bajos'),
  body('password')
    .notEmpty().withMessage('La contraseña es requerida')
    .isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres'),
  body('role')
    .isIn(['admin', 'usuario']).withMessage('Rol inválido'),
  body('nombre')
    .trim()
    .notEmpty().withMessage('El nombre del empleado es requerido'),
  body('cargo')
    .trim()
    .notEmpty().withMessage('El cargo es requerido'),
  body('salario')
    .isFloat({ min: 0 }).withMessage('El salario debe ser un número válido'),
  body('proyecto_id')
    .optional({ checkFalsy: true })
    .isInt().withMessage('ID de proyecto inválido'),
  body('estado')
    .isIn(['Activo', 'Inactivo']).withMessage('Estado inválido')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.locals.proyectos = await getProyectos();
      res.locals.usuario = req.body;
      res.locals.errors = errors.array();

      return res.status(400).render('rrhh/form', {
        title: 'Nuevo Usuario'
      });
    }

    const { username, password, role, nombre, cargo, salario, proyecto_id, estado } = req.body;

    // Verificar si el usuario ya existe
    let existingUser = null;
    try {
      const [rows] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
      existingUser = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    } catch (dbError) {
      console.error('Error verificando usuario:', dbError);
    }

    if (existingUser) {
      res.locals.proyectos = await getProyectos();
      res.locals.usuario = req.body;
      res.locals.errors = [{ msg: 'Este usuario ya existe en el sistema' }];

      return res.status(400).render('rrhh/form', {
        title: 'Nuevo Usuario'
      });
    }

    // Hashear contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // Crear empleado y vincularlo al usuario
    const [empleadoResult] = await db.query(
      'INSERT INTO empleados (nombre, cargo, salario, proyecto_id, estado) VALUES (?, ?, ?, ?, ?)',
      [nombre, cargo, Number(salario || 0), proyecto_id || null, estado]
    );
    const empleadoId = empleadoResult.insertId;

    // Insertar nuevo usuario
    await db.query(
      'INSERT INTO users (username, password, role, empleado_id, activo) VALUES (?, ?, ?, ?, 1)',
      [username, hashedPassword, role, empleadoId]
    );

    res.redirect('/rrhh?message=' + encodeURIComponent('✓ Usuario creado exitosamente'));
  } catch (error) { 
    console.error('Error creando usuario:', error);
    next(error); 
  }
});

// PUT /usuarios/:id - Actualizar usuario (sin cambiar contraseña)
router.put('/usuarios/:id', requireRole('admin'), [
  body('role')
    .isIn(['admin', 'usuario']).withMessage('Rol inválido'),
  body('nombre')
    .trim()
    .notEmpty().withMessage('El nombre del empleado es requerido'),
  body('cargo')
    .trim()
    .notEmpty().withMessage('El cargo es requerido'),
  body('salario')
    .isFloat({ min: 0 }).withMessage('El salario debe ser un número válido'),
  body('proyecto_id')
    .optional({ checkFalsy: true })
    .isInt().withMessage('ID de proyecto inválido'),
  body('estado')
    .isIn(['Activo', 'Inactivo']).withMessage('Estado inválido')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      let usuario = null;

      try {
        const [rows] = await db.query(`
          SELECT 
            u.id,
            u.username,
            u.role,
            u.activo,
            u.empleado_id,
            e.nombre AS empleado_nombre,
            e.cargo AS empleado_cargo,
            e.salario AS empleado_salario,
            e.proyecto_id AS empleado_proyecto_id,
            e.estado AS empleado_estado
          FROM users u
          LEFT JOIN empleados e ON e.id = u.empleado_id
          WHERE u.id = ?
        `, [req.params.id]);
        usuario = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      } catch (dbError) {
        console.error('Error consultando usuario:', dbError);
      }

      res.locals.proyectos = await getProyectos();
      res.locals.usuario = usuario ? { ...usuario, ...req.body } : req.body;
      res.locals.errors = errors.array();

      return res.status(400).render('rrhh/form', {
        title: 'Editar Usuario'
      });
    }

    const { role, activo, nombre, cargo, salario, proyecto_id, estado } = req.body;

    const [[currentUser]] = await db.query('SELECT empleado_id FROM users WHERE id = ?', [req.params.id]);
    if (!currentUser) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Usuario no encontrado'
      });
    }

    let empleadoId = currentUser.empleado_id;
    if (empleadoId) {
      await db.query(
        'UPDATE empleados SET nombre = ?, cargo = ?, salario = ?, proyecto_id = ?, estado = ? WHERE id = ?',
        [nombre, cargo, Number(salario || 0), proyecto_id || null, estado, empleadoId]
      );
    } else {
      const [empleadoResult] = await db.query(
        'INSERT INTO empleados (nombre, cargo, salario, proyecto_id, estado) VALUES (?, ?, ?, ?, ?)',
        [nombre, cargo, Number(salario || 0), proyecto_id || null, estado]
      );
      empleadoId = empleadoResult.insertId;
    }

    await db.query(
      'UPDATE users SET role = ?, empleado_id = ?, activo = ? WHERE id = ?',
      [role, empleadoId, activo ? 1 : 0, req.params.id]
    );

    res.redirect('/rrhh?message=' + encodeURIComponent('✓ Usuario actualizado exitosamente'));
  } catch (error) { 
    console.error('Error actualizando usuario:', error);
    next(error); 
  }
});

// PATCH /usuarios/:id/cambiar-contraseña - Cambiar contraseña
router.patch('/usuarios/:id/cambiar-contraseña', requireRole('admin'), [
  body('password')
    .notEmpty().withMessage('La contraseña es requerida')
    .isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.json({ success: false, message: errors.array()[0].msg });
    }

    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);

    res.json({ success: true, message: '✓ Contraseña actualizada exitosamente' });
  } catch (error) { 
    console.error('Error cambiando contraseña:', error);
    next(error); 
  }
});

// DELETE /usuarios/:id - Eliminar usuario
router.delete('/usuarios/:id', requireRole('admin'), async (req, res, next) => {
  try {
    // No permitir eliminar al admin actual
    if (req.session.user.id === parseInt(req.params.id)) {
      return res.json({ 
        success: false, 
        message: 'No puedes eliminar tu propia cuenta' 
      });
    }

    // Verificar si el usuario existe
    let user = null;
    try {
      const result = await db.query('SELECT username FROM users WHERE id = ?', [req.params.id]);
      user = result[0]?.[0] || null;
    } catch (dbError) {
      console.error('Error consultando usuario:', dbError);
    }

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'Usuario no encontrado' 
      });
    }

    // Eliminar usuario (solo cambiar a inactivo es más seguro)
    await db.query('UPDATE users SET activo = 0 WHERE id = ?', [req.params.id]);

    res.json({ 
      success: true, 
      message: '✓ Usuario desactivado exitosamente' 
    });
  } catch (error) { 
    console.error('Error desactivando usuario:', error);
    next(error); 
  }
});

// ============================================================
// SECCIÓN: GESTIÓN DE NÓMINAS (existente)
// ============================================================

router.post('/nomina', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();
    await ensureNominasSchema();

    const empleadoId = Number(req.body.empleado_id || 0);
    const fecha = toIsoDate(req.body.fecha || new Date());
    const adelantoExtra = parsePositiveNumber(req.body.adelanto_extra);
    const descuentosExtra = parsePositiveNumber(req.body.descuentos_extra);

    if (!empleadoId || !fecha) {
      return res.redirect('/rrhh?error=' + encodeURIComponent('Fecha invalida.'));
    }

    const refDate = new Date(fecha);
    const year = refDate.getFullYear();
    const month = refDate.getMonth() + 1;
    const yearStr = String(year);
    const monthStr = String(month).padStart(2, '0');
    const periodoInicio = `${yearStr}-${monthStr}-01`;
    const periodoFin = toIsoDate(new Date(year, month, 0));

    let empleado = null;
    try {
      const result = await db.query('SELECT salario FROM empleados WHERE id=?', [empleadoId]);
      empleado = result[0]?.[0] || null;
    } catch (dbError) {
      console.error('Error consultando empleado:', dbError);
    }

    if (!empleado) {
      return res.redirect('/rrhh?error=' + encodeURIComponent('Empleado no encontrado.'));
    }

    const salario = Number(empleado.salario || 0);
    const salarioDia = salario / 30;

    const [asistenciaRows] = await db.query(
      'SELECT asistio FROM rrhh_asistencias WHERE empleado_id = ? AND fecha BETWEEN ? AND ?',
      [empleadoId, periodoInicio, periodoFin]
    );
    const diasTrabajados = (Array.isArray(asistenciaRows) ? asistenciaRows : []).reduce((acc, row) => acc + (Number(row.asistio) === 1 ? 1 : 0), 0);

    const [ajusteRows] = await db.query(
      'SELECT bonificacion, adelanto, deudas, otros_descuentos FROM rrhh_asistencia_ajustes WHERE empleado_id = ? AND semana_inicio = ?',
      [empleadoId, periodoInicio]
    );
    const ajustes = ajusteRows?.[0] || { bonificacion: 0, adelanto: 0, deudas: 0, otros_descuentos: 0 };

    const bonificacionActual = Number(ajustes.bonificacion || 0);
    const adelantoTotal = Number(ajustes.adelanto || 0) + adelantoExtra;
    const deudasTotal = Number(ajustes.deudas || 0) + descuentosExtra;
    const otrosDescuentosActual = Number(ajustes.otros_descuentos || 0);
    const descuentosTotal = deudasTotal + otrosDescuentosActual;

    // Mantener en asistencias los acumulados de adelantos y descuentos
    await db.query(
      `INSERT INTO rrhh_asistencia_ajustes (empleado_id, semana_inicio, bonificacion, adelanto, deudas, otros_descuentos)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         bonificacion = VALUES(bonificacion),
         adelanto = VALUES(adelanto),
         deudas = VALUES(deudas),
         otros_descuentos = VALUES(otros_descuentos),
         updated_at = CURRENT_TIMESTAMP`,
      [empleadoId, periodoInicio, bonificacionActual, adelantoTotal, deudasTotal, otrosDescuentosActual]
    );

    const base = diasTrabajados * salarioDia;
    const extra = 0;
    const neto = base - adelantoTotal - descuentosTotal;

    await db.query(
      'INSERT INTO nominas (empleado_id, periodo, salario_base, horas_extra, adelanto_total, descuentos_total, descuentos, neto_pagar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [empleadoId, fecha, base, extra, adelantoTotal, descuentosTotal, (adelantoTotal + descuentosTotal), neto]
    );
    res.redirect('/rrhh?message=' + encodeURIComponent('✓ Nómina registrada exitosamente'));
  } catch (error) { 
    console.error('Error creando nómina:', error);
    next(error); 
  }
});

router.post('/asistencias/toggle', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const empleadoId = Number(req.body.empleado_id || 0);
    const fecha = toIsoDate(req.body.fecha);
    const semanaInicio = toIsoDate(req.body.semana_inicio);
    const asistio = Number(req.body.asistio) === 1 ? 1 : 0;

    if (!empleadoId || !fecha || !semanaInicio) {
      return res.status(400).json({ success: false, message: 'Datos incompletos para registrar asistencia.' });
    }

    const targetDate = new Date(fecha);
    const day = targetDate.getDay();
    if (day === 0) {
      return res.status(400).json({ success: false, message: 'El domingo se calcula automaticamente.' });
    }

    const monday = getMonday(semanaInicio);
    if (!monday) {
      return res.status(400).json({ success: false, message: 'Semana invalida.' });
    }

    const weekStart = toIsoDate(monday);
    const weekEnd = toIsoDate(addDays(monday, 6));
    if (fecha < weekStart || fecha > weekEnd) {
      return res.status(400).json({ success: false, message: 'La fecha no corresponde a la semana seleccionada.' });
    }

    await db.query(
      `INSERT INTO rrhh_asistencias (empleado_id, fecha, semana_inicio, asistio)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE asistio = VALUES(asistio), semana_inicio = VALUES(semana_inicio), updated_at = CURRENT_TIMESTAMP`,
      [empleadoId, fecha, weekStart, asistio]
    );

    await syncSundayAuto(empleadoId, weekStart);

    const [asistenciaRows] = await db.query(
      'SELECT fecha, asistio FROM rrhh_asistencias WHERE empleado_id = ? AND fecha BETWEEN ? AND ?',
      [empleadoId, weekStart, weekEnd]
    );

    const [empleadoRows] = await db.query('SELECT salario FROM empleados WHERE id = ?', [empleadoId]);
    const salario = Number(empleadoRows?.[0]?.salario || 0);
    const salarioDia = salario / 30;

    const [ajusteRows] = await db.query(
      'SELECT bonificacion, adelanto, deudas, otros_descuentos FROM rrhh_asistencia_ajustes WHERE empleado_id = ? AND semana_inicio = ?',
      [empleadoId, weekStart]
    );

    const ajustes = ajusteRows?.[0] || { bonificacion: 0, adelanto: 0, deudas: 0, otros_descuentos: 0 };
    const diasTrabajados = (Array.isArray(asistenciaRows) ? asistenciaRows : []).reduce((acc, row) => acc + (Number(row.asistio) === 1 ? 1 : 0), 0);
    const importe = diasTrabajados * salarioDia;
    const neto = importe + Number(ajustes.bonificacion || 0) - Number(ajustes.adelanto || 0) - Number(ajustes.deudas || 0) - Number(ajustes.otros_descuentos || 0);

    const sundayIso = toIsoDate(addDays(monday, 6));
    const sundayRow = (Array.isArray(asistenciaRows) ? asistenciaRows : []).find((row) => toIsoDate(row.fecha) === sundayIso);

    return res.json({
      success: true,
      empleado_id: empleadoId,
      domingo_asistio: Number(sundayRow?.asistio || 0),
      dias_trabajados: diasTrabajados,
      importe,
      neto
    });
  } catch (error) {
    console.error('Error registrando asistencia:', error);
    next(error);
  }
});

router.post('/asistencias/ajustes', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAsistenciasSchema();

    const empleadoId = Number(req.body.empleado_id || 0);
    const semanaInicio = toIsoDate(req.body.semana_inicio);
    const bonificacion = parsePositiveNumber(req.body.bonificacion);
    const adelanto = parsePositiveNumber(req.body.adelanto);
    const deudas = parsePositiveNumber(req.body.deudas);
    const otrosDescuentos = parsePositiveNumber(req.body.otros_descuentos);

    if (!empleadoId || !semanaInicio) {
      return res.status(400).json({ success: false, message: 'Datos incompletos para ajustes de asistencia.' });
    }

    await db.query(
      `INSERT INTO rrhh_asistencia_ajustes (empleado_id, semana_inicio, bonificacion, adelanto, deudas, otros_descuentos)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         bonificacion = VALUES(bonificacion),
         adelanto = VALUES(adelanto),
         deudas = VALUES(deudas),
         otros_descuentos = VALUES(otros_descuentos),
         updated_at = CURRENT_TIMESTAMP`,
      [empleadoId, semanaInicio, bonificacion, adelanto, deudas, otrosDescuentos]
    );

    const monday = getMonday(semanaInicio);
    const weekStart = toIsoDate(monday);
    const weekEnd = toIsoDate(addDays(monday, 6));

    const [asistenciaRows] = await db.query(
      'SELECT asistio FROM rrhh_asistencias WHERE empleado_id = ? AND fecha BETWEEN ? AND ?',
      [empleadoId, weekStart, weekEnd]
    );

    const [empleadoRows] = await db.query('SELECT salario FROM empleados WHERE id = ?', [empleadoId]);
    const salario = Number(empleadoRows?.[0]?.salario || 0);
    const salarioDia = salario / 30;
    const diasTrabajados = (Array.isArray(asistenciaRows) ? asistenciaRows : []).reduce((acc, row) => acc + (Number(row.asistio) === 1 ? 1 : 0), 0);
    const importe = diasTrabajados * salarioDia;
    const neto = importe + bonificacion - adelanto - deudas - otrosDescuentos;

    return res.json({
      success: true,
      empleado_id: empleadoId,
      dias_trabajados: diasTrabajados,
      importe,
      neto
    });
  } catch (error) {
    console.error('Error guardando ajustes de asistencia:', error);
    next(error);
  }
});

module.exports = router;
