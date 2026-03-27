const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { requireRole } = require('../middleware/auth');

const SUBMODULES = new Set(['base-materiales', 'almacen', 'movimientos']);

function normalizeSubmodule(raw) {
  return SUBMODULES.has(raw) ? raw : 'base-materiales';
}

function toUpperTrim(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned ? cleaned.toUpperCase() : null;
}

async function ensureAlmacenSchema(conn = db) {
  async function hasColumn(table, column) {
    const [rows] = await conn.query(
      `
      SELECT COUNT(*) AS total
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `,
      [table, column]
    );
    return Number(rows?.[0]?.total || 0) > 0;
  }

  async function hasIndex(table, indexName) {
    const [rows] = await conn.query(
      `
      SELECT COUNT(*) AS total
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      `,
      [table, indexName]
    );
    return Number(rows?.[0]?.total || 0) > 0;
  }

  if (!(await hasColumn('materiales', 'familia'))) {
    await conn.query('ALTER TABLE materiales ADD COLUMN familia VARCHAR(80) NULL AFTER nombre');
  }
  if (!(await hasColumn('materiales', 'grupo_material'))) {
    await conn.query('ALTER TABLE materiales ADD COLUMN grupo_material VARCHAR(80) NULL AFTER familia');
  }
  if (!(await hasColumn('materiales', 'subgrupo'))) {
    await conn.query('ALTER TABLE materiales ADD COLUMN subgrupo VARCHAR(80) NULL AFTER grupo_material');
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS almacen_proyecto_materiales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      proyecto_id INT NOT NULL,
      material_id INT NOT NULL,
      cantidad_presupuestada DECIMAL(12,2) NOT NULL DEFAULT 0,
      stock_fisico DECIMAL(12,2) NOT NULL DEFAULT 0,
      cantidad_disponible DECIMAL(12,2) NOT NULL DEFAULT 0,
      precio_unitario DECIMAL(12,2) NOT NULL DEFAULT 0,
      importe DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_proyecto_material (proyecto_id, material_id),
      CONSTRAINT fk_apm_proyecto FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
      CONSTRAINT fk_apm_material FOREIGN KEY (material_id) REFERENCES materiales(id) ON DELETE CASCADE
    )
  `);

  if (!(await hasColumn('almacen_proyecto_materiales', 'cantidad_presupuestada'))) {
    await conn.query('ALTER TABLE almacen_proyecto_materiales ADD COLUMN cantidad_presupuestada DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER material_id');
    await conn.query('UPDATE almacen_proyecto_materiales SET cantidad_presupuestada = cantidad_disponible WHERE cantidad_presupuestada = 0');
  }

  if (!(await hasColumn('almacen_proyecto_materiales', 'stock_fisico'))) {
    await conn.query('ALTER TABLE almacen_proyecto_materiales ADD COLUMN stock_fisico DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER cantidad_presupuestada');
    await conn.query('UPDATE almacen_proyecto_materiales SET stock_fisico = cantidad_disponible WHERE stock_fisico = 0');
  }

  if (!(await hasColumn('movimientos_almacen', 'proyecto_id'))) {
    await conn.query('ALTER TABLE movimientos_almacen ADD COLUMN proyecto_id INT NULL AFTER material_id');
    await conn.query('ALTER TABLE movimientos_almacen ADD CONSTRAINT fk_mov_alm_proyecto FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL');
  }
  if (!(await hasColumn('movimientos_almacen', 'almacen_material_id'))) {
    await conn.query('ALTER TABLE movimientos_almacen ADD COLUMN almacen_material_id INT NULL AFTER proyecto_id');
    await conn.query('ALTER TABLE movimientos_almacen ADD CONSTRAINT fk_mov_alm_asignacion FOREIGN KEY (almacen_material_id) REFERENCES almacen_proyecto_materiales(id) ON DELETE SET NULL');
  }
  if (!(await hasColumn('movimientos_almacen', 'motivo_operacion'))) {
    await conn.query("ALTER TABLE movimientos_almacen ADD COLUMN motivo_operacion VARCHAR(60) NULL AFTER tipo");
  }
  if (!(await hasColumn('movimientos_almacen', 'referencia_documento'))) {
    await conn.query("ALTER TABLE movimientos_almacen ADD COLUMN referencia_documento VARCHAR(80) NULL AFTER motivo_operacion");
  }
  if (!(await hasColumn('movimientos_almacen', 'registrado_por'))) {
    await conn.query("ALTER TABLE movimientos_almacen ADD COLUMN registrado_por VARCHAR(120) NULL AFTER observacion");
  }
  if (!(await hasColumn('movimientos_almacen', 'destino_frente'))) {
    await conn.query("ALTER TABLE movimientos_almacen ADD COLUMN destino_frente VARCHAR(120) NULL AFTER referencia_documento");
  }
  if (!(await hasColumn('movimientos_almacen', 'responsable_movimiento'))) {
    await conn.query("ALTER TABLE movimientos_almacen ADD COLUMN responsable_movimiento VARCHAR(120) NULL AFTER destino_frente");
  }
  if (!(await hasColumn('movimientos_almacen', 'saldo_resultante'))) {
    await conn.query('ALTER TABLE movimientos_almacen ADD COLUMN saldo_resultante DECIMAL(12,2) NULL AFTER cantidad');
  }
  if (!(await hasColumn('movimientos_almacen', 'proveedor_id'))) {
    await conn.query('ALTER TABLE movimientos_almacen ADD COLUMN proveedor_id INT NULL AFTER almacen_material_id');
    await conn.query('ALTER TABLE movimientos_almacen ADD CONSTRAINT fk_mov_alm_proveedor FOREIGN KEY (proveedor_id) REFERENCES proveedores(id) ON DELETE SET NULL');
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS almacen_catalogos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tipo VARCHAR(30) NOT NULL,
      valor VARCHAR(120) NOT NULL,
      parent_tipo VARCHAR(30) NOT NULL DEFAULT '',
      parent_valor VARCHAR(120) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tipo_valor_parent (tipo, valor, parent_tipo, parent_valor)
    )
  `);

  if (!(await hasColumn('almacen_catalogos', 'parent_tipo'))) {
    await conn.query("ALTER TABLE almacen_catalogos ADD COLUMN parent_tipo VARCHAR(30) NOT NULL DEFAULT '' AFTER valor");
  }

  if (!(await hasColumn('almacen_catalogos', 'parent_valor'))) {
    await conn.query("ALTER TABLE almacen_catalogos ADD COLUMN parent_valor VARCHAR(120) NOT NULL DEFAULT '' AFTER parent_tipo");
  }

  if (await hasIndex('almacen_catalogos', 'uq_tipo_valor')) {
    await conn.query('ALTER TABLE almacen_catalogos DROP INDEX uq_tipo_valor');
  }

  if (!(await hasIndex('almacen_catalogos', 'uq_tipo_valor_parent'))) {
    await conn.query('ALTER TABLE almacen_catalogos ADD UNIQUE KEY uq_tipo_valor_parent (tipo, valor, parent_tipo, parent_valor)');
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL,
      contacto VARCHAR(150),
      telefono VARCHAR(20),
      email VARCHAR(100),
      ruc VARCHAR(15),
      direccion VARCHAR(255),
      estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  if (!(await hasColumn('proveedores', 'direccion'))) {
    await conn.query('ALTER TABLE proveedores ADD COLUMN direccion VARCHAR(255) NULL AFTER ruc');
  }
}

async function hasColumn(conn, table, column) {
  const [rows] = await conn.query(
    `
    SELECT COUNT(*) AS total
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `,
    [table, column]
  );
  return Number(rows?.[0]?.total || 0) > 0;
}

async function ensureContabilidadAutoSchema(conn = db) {
  if (!(await hasColumn(conn, 'asientos_contables', 'estado_pago'))) {
    await conn.query("ALTER TABLE asientos_contables ADD COLUMN estado_pago ENUM('Pagado','Pendiente') NOT NULL DEFAULT 'Pagado' AFTER monto");
  }
  if (!(await hasColumn(conn, 'asientos_contables', 'registrado_por'))) {
    await conn.query("ALTER TABLE asientos_contables ADD COLUMN registrado_por VARCHAR(120) NULL AFTER estado_pago");
    await conn.query("UPDATE asientos_contables SET registrado_por = 'SISTEMA' WHERE registrado_por IS NULL OR TRIM(registrado_por) = ''");
  }
}

function formatMaterialCode(seq) {
  return `MAT-${String(seq).padStart(8, '0')}`;
}

async function getNextMaterialCode(conn = db) {
  const [[row]] = await conn.query(`
    SELECT COALESCE(MAX(CAST(SUBSTRING(codigo, 5) AS UNSIGNED)), 0) AS max_seq
    FROM materiales
    WHERE codigo REGEXP '^MAT-[0-9]{8}$'
  `);
  return formatMaterialCode(Number(row?.max_seq || 0) + 1);
}

async function normalizeExistingMaterialCodes(conn) {
  const [rows] = await conn.query('SELECT id, codigo FROM materiales ORDER BY id');
  if (!rows.length) return;

  let requiresNormalization = false;
  rows.forEach((row, index) => {
    if (row.codigo !== formatMaterialCode(index + 1)) {
      requiresNormalization = true;
    }
  });

  if (!requiresNormalization) return;

  for (const row of rows) {
    await conn.query('UPDATE materiales SET codigo = ? WHERE id = ?', [`TMP-${row.id}`, row.id]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    await conn.query('UPDATE materiales SET codigo = ? WHERE id = ?', [formatMaterialCode(index + 1), rows[index].id]);
  }
}

async function syncCatalogosFromMateriales(conn) {
  const [familias] = await conn.query(`
    SELECT DISTINCT UPPER(TRIM(familia)) AS valor
    FROM materiales
    WHERE familia IS NOT NULL AND TRIM(familia) <> ''
  `);

  for (const row of familias) {
    if (!row.valor) continue;
    await conn.query(
      "INSERT IGNORE INTO almacen_catalogos (tipo, valor, parent_tipo, parent_valor) VALUES ('FAMILIA', ?, '', '')",
      [row.valor]
    );
  }

  const [grupos] = await conn.query(`
    SELECT DISTINCT UPPER(TRIM(grupo_material)) AS valor, UPPER(TRIM(COALESCE(familia, categoria, ''))) AS familia
    FROM materiales
    WHERE grupo_material IS NOT NULL AND TRIM(grupo_material) <> ''
  `);

  for (const row of grupos) {
    if (!row.valor) continue;
    await conn.query(
      "INSERT IGNORE INTO almacen_catalogos (tipo, valor, parent_tipo, parent_valor) VALUES ('GRUPO', ?, 'FAMILIA', ?)",
      [row.valor, row.familia || '']
    );
  }

  const [subgrupos] = await conn.query(`
    SELECT DISTINCT UPPER(TRIM(subgrupo)) AS valor, UPPER(TRIM(COALESCE(grupo_material, ''))) AS grupo
    FROM materiales
    WHERE subgrupo IS NOT NULL AND TRIM(subgrupo) <> ''
  `);

  for (const row of subgrupos) {
    if (!row.valor) continue;
    await conn.query(
      "INSERT IGNORE INTO almacen_catalogos (tipo, valor, parent_tipo, parent_valor) VALUES ('SUBGRUPO', ?, 'GRUPO', ?)",
      [row.valor, row.grupo || '']
    );
  }

  const [unidades] = await conn.query(`
    SELECT DISTINCT UPPER(TRIM(unidad)) AS valor
    FROM materiales
    WHERE unidad IS NOT NULL AND TRIM(unidad) <> ''
  `);

  for (const row of unidades) {
    if (!row.valor) continue;
    await conn.query(
      "INSERT IGNORE INTO almacen_catalogos (tipo, valor, parent_tipo, parent_valor) VALUES ('UNIDAD', ?, '', '')",
      [row.valor]
    );
  }
}

async function getCatalogos(conn) {
  const [rows] = await conn.query('SELECT tipo, valor, parent_tipo, parent_valor FROM almacen_catalogos ORDER BY tipo, valor');
  return {
    familias: rows.filter((r) => r.tipo === 'FAMILIA').map((r) => r.valor),
    grupos: rows.filter((r) => r.tipo === 'GRUPO').map((r) => r.valor),
    subgrupos: rows.filter((r) => r.tipo === 'SUBGRUPO').map((r) => r.valor),
    unidades: rows.filter((r) => r.tipo === 'UNIDAD').map((r) => r.valor),
    gruposDet: rows.filter((r) => r.tipo === 'GRUPO').map((r) => ({ valor: r.valor, parentValor: r.parent_valor || '' })),
    subgruposDet: rows.filter((r) => r.tipo === 'SUBGRUPO').map((r) => ({ valor: r.valor, parentValor: r.parent_valor || '' }))
  };
}

async function loadAlmacenData(conn) {
  const [materiales] = await conn.query(`
    SELECT *
    FROM materiales
    ORDER BY nombre
  `);

  const [proyectos] = await conn.query('SELECT id, nombre, estado FROM proyectos ORDER BY nombre');
  const catalogos = await getCatalogos(conn);

  const [asignaciones] = await conn.query(`
    SELECT
      apm.id,
      apm.proyecto_id,
      apm.material_id,
      COALESCE(apm.cantidad_presupuestada, apm.cantidad_disponible, 0) AS cantidad_presupuestada,
      COALESCE(apm.stock_fisico, apm.cantidad_disponible, 0) AS stock_fisico,
      apm.cantidad_disponible,
      apm.precio_unitario,
      apm.importe,
      COALESCE(ms.total_salidas, 0) AS cantidad_consumida,
      GREATEST(COALESCE(apm.cantidad_presupuestada, apm.cantidad_disponible, 0) - COALESCE(apm.stock_fisico, apm.cantidad_disponible, 0), 0) AS saldo_por_comprar,
      p.nombre AS proyecto_nombre,
      p.estado AS proyecto_estado,
      m.codigo,
      m.nombre AS material_nombre,
      m.unidad,
      COALESCE(m.familia, m.categoria, '-') AS familia,
      COALESCE(m.grupo_material, '-') AS grupo_material,
      COALESCE(m.subgrupo, '-') AS subgrupo
    FROM almacen_proyecto_materiales apm
    LEFT JOIN (
      SELECT almacen_material_id, SUM(cantidad) AS total_salidas
      FROM movimientos_almacen
      WHERE tipo = 'Salida'
      GROUP BY almacen_material_id
    ) ms ON ms.almacen_material_id = apm.id
    INNER JOIN proyectos p ON p.id = apm.proyecto_id
    INNER JOIN materiales m ON m.id = apm.material_id
    ORDER BY p.nombre, m.nombre
  `);

  const [movimientos] = await conn.query(`
    SELECT
      mov.id,
      mov.fecha,
      mov.tipo,
      mov.motivo_operacion,
      mov.referencia_documento,
      mov.destino_frente,
      mov.responsable_movimiento,
      mov.cantidad,
      mov.saldo_resultante,
      mov.observacion,
      mov.registrado_por,
      p.nombre AS proyecto,
      mat.nombre AS material,
      mat.unidad,
      apm.id AS asignacion_id,
      apm.cantidad_disponible
    FROM movimientos_almacen mov
    INNER JOIN materiales mat ON mat.id = mov.material_id
    LEFT JOIN proyectos p ON p.id = mov.proyecto_id
    LEFT JOIN almacen_proyecto_materiales apm ON apm.id = mov.almacen_material_id
    ORDER BY mov.fecha DESC, mov.id DESC
    LIMIT 40
  `);

  const tarjetasProyecto = proyectos.map((proyecto) => {
    const items = asignaciones.filter((a) => Number(a.proyecto_id) === Number(proyecto.id));
    const totalImporte = items.reduce((acc, item) => acc + Number(item.importe || 0), 0);
    return {
      ...proyecto,
      items,
      totalImporte
    };
  });

  const metricas = {
    totalMateriales: materiales.length,
    totalProyectos: proyectos.length,
    totalAsignaciones: asignaciones.length,
    valorAlmacen: asignaciones.reduce((acc, item) => acc + Number(item.importe || 0), 0),
    totalMovimientos: movimientos.length
  };

  return {
    materiales,
    proyectos,
    catalogos,
    asignaciones,
    movimientos,
    tarjetasProyecto,
    metricas
  };
}

router.get('/', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    // Si el usuario solicita mod=movimientos, redirige al nuevo dashboard
    if (req.query.mod === 'movimientos') {
      return res.redirect('/almacen/movimientos');
    }

    await ensureAlmacenSchema(conn);
    await conn.beginTransaction();
    await normalizeExistingMaterialCodes(conn);
    await syncCatalogosFromMateriales(conn);
    await conn.commit();

    const activeSubmodule = normalizeSubmodule(req.query.mod);
    const {
      materiales,
      proyectos,
      catalogos,
      asignaciones,
      movimientos,
      tarjetasProyecto,
      metricas
    } = await loadAlmacenData(conn);

    let materialEdit = null;
    const nextCodigo = await getNextMaterialCode(conn);

    if (req.query.edit) {
      const [[mat]] = await conn.query('SELECT * FROM materiales WHERE id = ?', [req.query.edit]);
      materialEdit = mat || null;
    }

    res.render('almacen/index', {
      title: 'Almacen e Inventario',
      activeSubmodule,
      materiales,
      proyectos,
      catalogos,
      asignaciones,
      tarjetasProyecto,
      movimientos,
      metricas,
      materialEdit,
      nextCodigo
    });
  } catch (error) {
    try { await conn.rollback(); } catch (rollbackError) { }
    next(error);
  } finally {
    conn.release();
  }
});

router.get('/proyectos/:id', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);
    const assignEditId = Number(req.query.assignEdit || 0) || null;
    const proyectoId = Number(req.params.id);

    const {
      materiales,
      proyectos,
      asignaciones,
      tarjetasProyecto,
      metricas
    } = await loadAlmacenData(conn);

    const selectedProyecto = proyectos.find((p) => Number(p.id) === proyectoId) || null;
    if (!selectedProyecto) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Proyecto no encontrado.'
      });
    }

    const selectedProyectoItems = asignaciones.filter((a) => Number(a.proyecto_id) === proyectoId);
    const asignacionEdit = assignEditId
      ? asignaciones.find((a) => Number(a.id) === assignEditId) || null
      : null;

    res.render('almacen/proyecto', {
      title: `Almacen del proyecto ${selectedProyecto.nombre}`,
      activeSubmodule: 'almacen',
      materiales,
      proyectos,
      asignaciones,
      tarjetasProyecto,
      metricas,
      selectedProyecto,
      selectedProyectoItems,
      asignacionEdit
    });
  } catch (error) {
    next(error);
  } finally {
    conn.release();
  }
});

router.get('/materiales/:id/editar', requireRole('admin'), (req, res) => {
  res.redirect(`/almacen?mod=base-materiales&edit=${req.params.id}`);
});

router.post('/materiales', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAlmacenSchema();
    const {
      nombre,
      familia,
      grupo_material,
      subgrupo,
      unidad
    } = req.body;
    const codigoFinal = await getNextMaterialCode();

    await db.query(
      `
      INSERT INTO materiales
        (codigo, nombre, familia, grupo_material, subgrupo, categoria, unidad, stock_actual, stock_minimo, costo_unitario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        codigoFinal,
        toUpperTrim(nombre),
        toUpperTrim(familia),
        toUpperTrim(grupo_material),
        toUpperTrim(subgrupo),
        toUpperTrim(familia),
        toUpperTrim(unidad),
        0,
        0,
        0
      ]
    );

    await syncCatalogosFromMateriales(db);

    res.redirect('/almacen?mod=base-materiales');
  } catch (error) { next(error); }
});

router.get('/proveedores/lista', requireRole('admin'), async (req, res, next) => {
  try {
    const [proveedores] = await db.query(
      'SELECT id, nombre, ruc, contacto, telefono, email, direccion, estado FROM proveedores WHERE estado = ? ORDER BY nombre',
      ['Activo']
    );
    res.json({ 
      success: true, 
      proveedores: proveedores || [] 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/proveedores/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const proveedorId = Number(req.params.id);
    const {
      nombre,
      ruc,
      contacto,
      telefono,
      email,
      direccion
    } = req.body;

    const nombreFinal = toUpperTrim(nombre);
    const rucFinal = toUpperTrim(ruc);

    if (!nombreFinal) {
      return res.status(400).json({ success: false, error: 'El nombre del proveedor es obligatorio.' });
    }

    if (!rucFinal) {
      return res.status(400).json({ success: false, error: 'El RUC del proveedor es obligatorio.' });
    }

    const [result] = await db.query(
      `
      UPDATE proveedores
      SET nombre = ?, ruc = ?, contacto = ?, telefono = ?, email = ?, direccion = ?
      WHERE id = ?
      `,
      [
        nombreFinal,
        rucFinal,
        toUpperTrim(contacto),
        toUpperTrim(telefono),
        String(email || '').trim().toLowerCase(),
        toUpperTrim(direccion),
        proveedorId
      ]
    );

    if (result.affectedRows > 0) {
      res.json({ 
        success: true, 
        message: 'Proveedor actualizado',
        id: proveedorId,
        nombre: nombreFinal,
        ruc: rucFinal
      });
    } else {
      res.status(404).json({ success: false, error: 'Proveedor no encontrado' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/proveedores/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const proveedorId = Number(req.params.id);
    const [result] = await db.query('DELETE FROM proveedores WHERE id = ?', [proveedorId]);
    
    if (result.affectedRows > 0) {
      res.json({ success: true, message: 'Proveedor eliminado' });
    } else {
      res.status(404).json({ success: false, error: 'Proveedor no encontrado' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/proveedores', requireRole('admin'), async (req, res, next) => {
  try {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const acceptType = String(req.headers.accept || '').toLowerCase();
      const isJsonRequest = contentType.includes('application/json') || acceptType.includes('application/json');

    await ensureAlmacenSchema();
    const {
      nombre,
      ruc,
      contacto,
      telefono,
      email,
      direccion
    } = req.body;

    const nombreFinal = toUpperTrim(nombre);
    const rucFinal = toUpperTrim(ruc);

    if (!nombreFinal) {
      throw new Error('El nombre del proveedor es obligatorio.');
    }

    if (!rucFinal) {
      throw new Error('El RUC del proveedor es obligatorio.');
    }

    const [result] = await db.query(
      `
      INSERT INTO proveedores
        (nombre, ruc, contacto, telefono, email, direccion, estado)
      VALUES (?, ?, ?, ?, ?, ?, 'Activo')
      `,
      [
        nombreFinal,
        rucFinal,
        toUpperTrim(contacto),
        toUpperTrim(telefono),
        String(email || '').trim().toLowerCase(),
        toUpperTrim(direccion)
      ]
    );

    // Si es una solicitud AJAX, devolver JSON
    if (isJsonRequest) {
      return res.json({
        success: true,
        id: result.insertId,
        nombre: nombreFinal,
        ruc: rucFinal
      });
    }

    // Si es una solicitud de formulario, redirigir
    res.redirect('/almacen?mod=base-materiales');
  } catch (error) { 
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const acceptType = String(req.headers.accept || '').toLowerCase();
    const isJsonRequest = contentType.includes('application/json') || acceptType.includes('application/json');

    if (isJsonRequest) {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error); 
  }
});

router.put('/materiales/:id', requireRole('admin'), async (req, res, next) => {
  try {
    await ensureAlmacenSchema();
    const {
      nombre,
      familia,
      grupo_material,
      subgrupo,
      unidad
    } = req.body;

    const [[materialActual]] = await db.query('SELECT codigo, stock_actual, stock_minimo, costo_unitario FROM materiales WHERE id = ?', [req.params.id]);
    if (!materialActual) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Material no encontrado.'
      });
    }

    const codigoFinal = materialActual.codigo || await getNextMaterialCode();

    const [result] = await db.query(
      `
      UPDATE materiales
      SET codigo = ?, nombre = ?, familia = ?, grupo_material = ?, subgrupo = ?, categoria = ?, unidad = ?, stock_actual = ?, stock_minimo = ?, costo_unitario = ?
      WHERE id = ?
      `,
      [
        codigoFinal,
        toUpperTrim(nombre),
        toUpperTrim(familia),
        toUpperTrim(grupo_material),
        toUpperTrim(subgrupo),
        toUpperTrim(familia),
        toUpperTrim(unidad),
        materialActual.stock_actual || 0,
        materialActual.stock_minimo || 0,
        materialActual.costo_unitario || 0,
        req.params.id
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Material no encontrado.'
      });
    }

    await syncCatalogosFromMateriales(db);

    res.redirect('/almacen?mod=base-materiales');
  } catch (error) { next(error); }
});

async function crearCatalogoRapido(req, res, next, tipoFromParams) {
  try {
    await ensureAlmacenSchema();

    const tipoRaw = String(tipoFromParams || req.body.tipo || '').toUpperCase();
    const tipoMap = {
      FAMILIA: 'FAMILIA',
      GRUPO: 'GRUPO',
      SUBGRUPO: 'SUBGRUPO',
      UNIDAD: 'UNIDAD'
    };
    const tipo = tipoMap[tipoRaw];

    if (!tipo) {
      throw new Error('Tipo de catalogo no valido.');
    }

    const valor = toUpperTrim(req.body.valor);
    if (!valor) {
      throw new Error('Debe ingresar un valor para el catalogo.');
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const acceptType = String(req.headers.accept || '').toLowerCase();
    const isJsonRequest = contentType.includes('application/json') || acceptType.includes('application/json');

    const parentTipoRaw = String(req.body.parent_tipo || '').toUpperCase();
    const parentValor = toUpperTrim(req.body.parent_valor) || '';

    let parentTipo = '';
    if (tipo === 'GRUPO') {
      parentTipo = 'FAMILIA';
      if (!parentValor) {
        throw new Error('Para crear un grupo debe seleccionar una familia.');
      }
    }
    if (tipo === 'SUBGRUPO') {
      parentTipo = 'GRUPO';
      if (!parentValor) {
        throw new Error('Para crear un subgrupo debe seleccionar un grupo.');
      }
    }
    if (tipo === 'FAMILIA' || tipo === 'UNIDAD') {
      parentTipo = '';
    }

    if (parentTipoRaw && parentTipoRaw !== parentTipo) {
      throw new Error('Jerarquia de catalogo invalida para el tipo seleccionado.');
    }

    const [result] = await db.query(
      'INSERT IGNORE INTO almacen_catalogos (tipo, valor, parent_tipo, parent_valor) VALUES (?, ?, ?, ?)',
      [tipo, valor, parentTipo, parentValor]
    );

    if (isJsonRequest) {
      return res.json({
        success: true,
        created: Number(result.affectedRows || 0) > 0,
        tipo,
        valor,
        parent_tipo: parentTipo,
        parent_valor: parentValor
      });
    }

    res.redirect('/almacen?mod=base-materiales');
  } catch (error) {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const acceptType = String(req.headers.accept || '').toLowerCase();
    const isJsonRequest = contentType.includes('application/json') || acceptType.includes('application/json');
    if (isJsonRequest) {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
  }
}

router.post('/catalogos/:tipo', requireRole('admin'), async (req, res, next) => {
  return crearCatalogoRapido(req, res, next, req.params.tipo);
});

router.post('/catalogos', requireRole('admin'), async (req, res, next) => {
  return crearCatalogoRapido(req, res, next, null);
});

router.delete('/materiales/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const [result] = await db.query('DELETE FROM materiales WHERE id = ?', [req.params.id]);

    if (!result.affectedRows) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Material no encontrado.'
      });
    }

    res.redirect('/almacen?mod=base-materiales');
  } catch (error) { next(error); }
});

router.post('/asignaciones', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);
    await conn.beginTransaction();

    const { proyecto_id, material_id, cantidad, precio_unitario } = req.body;
    const proyectoId = Number(proyecto_id);
    const materialId = Number(material_id);
    const qty = Number(cantidad || 0);
    const price = Number(precio_unitario || 0);

    if (!proyectoId || !materialId || qty <= 0) {
      throw new Error('Debe seleccionar proyecto, material y una cantidad mayor a cero.');
    }

    const [[existente]] = await conn.query(
      'SELECT id, cantidad_presupuestada, stock_fisico, cantidad_disponible FROM almacen_proyecto_materiales WHERE proyecto_id = ? AND material_id = ?',
      [proyectoId, materialId]
    );

    if (existente) {
      const nuevoPresupuesto = Number(existente.cantidad_presupuestada || 0) + qty;
      const nuevoImporte = nuevoPresupuesto * price;
      await conn.query(
        'UPDATE almacen_proyecto_materiales SET cantidad_presupuestada = ?, precio_unitario = ?, importe = ? WHERE id = ?',
        [nuevoPresupuesto, price, nuevoImporte, existente.id]
      );
    } else {
      await conn.query(
        'INSERT INTO almacen_proyecto_materiales (proyecto_id, material_id, cantidad_presupuestada, stock_fisico, cantidad_disponible, precio_unitario, importe) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [proyectoId, materialId, qty, 0, 0, price, qty * price]
      );
    }

    await conn.commit();
    res.redirect(`/almacen/proyectos/${proyectoId}`);
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

router.put('/asignaciones/:id', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);
    await conn.beginTransaction();

    const asignacionId = Number(req.params.id);
    const proyectoIdNuevo = Number(req.body.proyecto_id);
    const materialIdNuevo = Number(req.body.material_id);
    const cantidadNueva = Number(req.body.cantidad || 0);
    const precioNuevo = Number(req.body.precio_unitario || 0);

    if (!asignacionId || !proyectoIdNuevo || !materialIdNuevo || cantidadNueva <= 0) {
      throw new Error('Datos invalidos para actualizar la asignacion.');
    }

    const [[actual]] = await conn.query(
      'SELECT id, proyecto_id, material_id, cantidad_presupuestada, stock_fisico, cantidad_disponible, precio_unitario FROM almacen_proyecto_materiales WHERE id = ?',
      [asignacionId]
    );

    if (!actual) {
      throw new Error('No se encontró la asignación seleccionada.');
    }

    const mismaLlave = Number(actual.proyecto_id) === proyectoIdNuevo && Number(actual.material_id) === materialIdNuevo;
    if (!mismaLlave) {
      const [[duplicada]] = await conn.query(
        'SELECT id FROM almacen_proyecto_materiales WHERE proyecto_id = ? AND material_id = ? AND id <> ?',
        [proyectoIdNuevo, materialIdNuevo, asignacionId]
      );
      if (duplicada) {
        throw new Error('Ya existe una asignación para ese material en el proyecto seleccionado.');
      }
    }

    await conn.query(
      'UPDATE almacen_proyecto_materiales SET proyecto_id = ?, material_id = ?, cantidad_presupuestada = ?, precio_unitario = ?, importe = ? WHERE id = ?',
      [proyectoIdNuevo, materialIdNuevo, cantidadNueva, precioNuevo, cantidadNueva * precioNuevo, asignacionId]
    );

    await conn.commit();
    res.redirect(`/almacen/proyectos/${proyectoIdNuevo}`);
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

router.delete('/asignaciones/:id', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);
    await conn.beginTransaction();

    const asignacionId = Number(req.params.id);
    const [[actual]] = await conn.query(
      'SELECT id, proyecto_id, material_id, stock_fisico, cantidad_disponible FROM almacen_proyecto_materiales WHERE id = ?',
      [asignacionId]
    );

    if (!actual) {
      throw new Error('No se encontró la asignación seleccionada.');
    }

    await conn.query('DELETE FROM almacen_proyecto_materiales WHERE id = ?', [asignacionId]);

    await conn.commit();
    res.redirect(`/almacen/proyectos/${Number(actual.proyecto_id)}`);
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

router.post('/movimientos', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);
    await conn.beginTransaction();

    const {
      almacen_material_id,
      material_id,
      proyecto_id,
      tipo,
      motivo_operacion,
      referencia_documento,
      destino_frente,
      responsable_movimiento,
      cantidad,
      observacion
    } = req.body;
    const asignacionId = Number(almacen_material_id || 0);
    const qty = Number(cantidad || 0);
    const sign = tipo === 'Ingreso' ? 1 : -1;
    const motivoOperacion = toUpperTrim(motivo_operacion);
    const referenciaDocumento = toUpperTrim(referencia_documento);
    const destinoFrente = toUpperTrim(destino_frente);
    const responsableMovimiento = toUpperTrim(responsable_movimiento);
    const observacionFinal = toUpperTrim(observacion);
    const registradoPor = toUpperTrim(req.session?.user?.username || req.session?.user?.nombre || 'SISTEMA');

    if (!['Ingreso', 'Salida'].includes(tipo)) {
      throw new Error('Tipo de movimiento no valido.');
    }
    if (!motivoOperacion) {
      throw new Error('Debe seleccionar un motivo operativo del movimiento.');
    }
    if (tipo === 'Ingreso' && !referenciaDocumento) {
      throw new Error('Para ingresos debe registrar una referencia de compra o guia.');
    }
    if (tipo === 'Salida' && (!destinoFrente || !responsableMovimiento)) {
      throw new Error('Para salidas debe registrar destino/frente y responsable.');
    }
    if (qty <= 0) {
      throw new Error('La cantidad debe ser mayor a cero.');
    }

    let materialIdFinal = Number(material_id || 0);
    let proyectoIdFinal = Number(proyecto_id || 0) || null;
    let saldoResultante = null;

    if (asignacionId) {
      const [[asignacion]] = await conn.query(
        'SELECT id, material_id, proyecto_id, stock_fisico, cantidad_disponible, precio_unitario FROM almacen_proyecto_materiales WHERE id = ?',
        [asignacionId]
      );

      if (!asignacion) {
        throw new Error('La asignacion seleccionada no existe.');
      }

      materialIdFinal = Number(asignacion.material_id);
      proyectoIdFinal = Number(asignacion.proyecto_id);

      const saldoActual = Number(asignacion.stock_fisico || asignacion.cantidad_disponible || 0);
      if (sign < 0 && qty > saldoActual) {
        throw new Error('No hay stock suficiente en el proyecto para registrar la salida.');
      }

      const nuevaCantidad = saldoActual + (sign * qty);
      const nuevoImporte = nuevaCantidad * Number(asignacion.precio_unitario || 0);
      saldoResultante = nuevaCantidad;
      await conn.query(
        'UPDATE almacen_proyecto_materiales SET stock_fisico = ?, cantidad_disponible = ?, importe = ? WHERE id = ?',
        [nuevaCantidad, nuevaCantidad, nuevoImporte, asignacionId]
      );
    }

    if (!materialIdFinal) {
      throw new Error('Debe seleccionar un material valido para el movimiento.');
    }

    await conn.query(
      `
      INSERT INTO movimientos_almacen
        (material_id, proyecto_id, almacen_material_id, tipo, motivo_operacion, referencia_documento, destino_frente, responsable_movimiento, cantidad, saldo_resultante, observacion, registrado_por, fecha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `,
      [
        materialIdFinal,
        proyectoIdFinal,
        asignacionId || null,
        tipo,
        motivoOperacion,
        referenciaDocumento,
        destinoFrente,
        responsableMovimiento,
        qty,
        saldoResultante,
        observacionFinal,
        registradoPor
      ]
    );

    await conn.query('UPDATE materiales SET stock_actual = stock_actual + ? WHERE id = ?', [sign * qty, materialIdFinal]);

    await conn.commit();
    res.redirect('/almacen?mod=movimientos');
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// ============ NUEVAS RUTAS PARA MOVIMIENTOS (3 FASES) ============

// FASE 1: Dashboard de Movimientos
router.get('/movimientos', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);

    const [proyectosData] = await conn.query(`
      SELECT
        p.id,
        p.nombre,
        p.ubicacion,
        p.estado,
        COUNT(DISTINCT apm.id) AS materialCount,
        COALESCE(SUM(COALESCE(apm.stock_fisico, apm.cantidad_disponible)), 0) AS totalStockDisponible,
        MAX(mov.fecha) AS ultimaActividad
      FROM proyectos p
      LEFT JOIN almacen_proyecto_materiales apm ON apm.proyecto_id = p.id
      LEFT JOIN movimientos_almacen mov ON mov.proyecto_id = p.id
      WHERE p.estado IN ('Planificado', 'En ejecucion', 'Por iniciar')
      GROUP BY p.id
      ORDER BY p.nombre
    `);

    res.render('almacen/movimientos-dashboard', {
      title: 'Movimientos de Almacén',
      movimientosProyectos: proyectosData || []
    });
  } catch (error) {
    next(error);
  } finally {
    conn.release();
  }
});

// FASE 2A: Vista de Entradas
router.get('/movimientos/:id_proyecto/entradas', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);

    const proyectoId = Number(req.params.id_proyecto);

    const [[selectedProyecto]] = await conn.query('SELECT id, nombre, ubicacion, estado FROM proyectos WHERE id = ?', [proyectoId]);
    if (!selectedProyecto) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Proyecto no encontrado.'
      });
    }

    const [asignaciones] = await conn.query(`
      SELECT
        apm.id,
        apm.proyecto_id,
        apm.material_id,
        COALESCE(apm.stock_fisico, apm.cantidad_disponible, 0) AS cantidad_disponible,
        COALESCE(apm.cantidad_presupuestada, apm.cantidad_disponible, 0) AS cantidad_presupuestada,
        apm.precio_unitario,
        m.codigo,
        m.nombre AS material_nombre,
        m.unidad
      FROM almacen_proyecto_materiales apm
      INNER JOIN materiales m ON m.id = apm.material_id
      WHERE apm.proyecto_id = ?
      ORDER BY m.nombre
    `, [proyectoId]);

    const [proveedores] = await conn.query('SELECT id, nombre, ruc FROM proveedores WHERE estado = ? ORDER BY nombre', ['Activo']);

    const [entradas] = await conn.query(`
      SELECT
        mov.id,
        mov.fecha,
        mov.referencia_documento,
        mov.cantidad,
        mov.saldo_resultante,
        mov.observacion,
        m.nombre AS material,
        m.unidad,
        apm.cantidad_disponible,
        pr.nombre AS proveedor_nombre
      FROM movimientos_almacen mov
      INNER JOIN materiales m ON m.id = mov.material_id
      LEFT JOIN almacen_proyecto_materiales apm ON apm.id = mov.almacen_material_id
      LEFT JOIN proveedores pr ON pr.id = mov.proveedor_id
      WHERE mov.proyecto_id = ? AND mov.tipo = 'Ingreso'
      ORDER BY mov.fecha DESC
      LIMIT 50
    `, [proyectoId]);

    const [reporteMovimientos] = await conn.query(`
      SELECT
        mov.id,
        mov.fecha,
        mov.tipo,
        mov.referencia_documento,
        mov.destino_frente,
        mov.responsable_movimiento,
        mov.cantidad,
        mov.saldo_resultante,
        mov.observacion,
        m.nombre AS material,
        m.unidad,
        pr.nombre AS proveedor_nombre
      FROM movimientos_almacen mov
      INNER JOIN materiales m ON m.id = mov.material_id
      LEFT JOIN proveedores pr ON pr.id = mov.proveedor_id
      WHERE mov.proyecto_id = ?
      ORDER BY mov.fecha DESC, mov.id DESC
      LIMIT 200
    `, [proyectoId]);

    const totalEntradas = reporteMovimientos.filter((item) => item.tipo === 'Ingreso').length;
    const totalSalidas = reporteMovimientos.filter((item) => item.tipo === 'Salida').length;

    res.render('almacen/movimientos-entradas', {
      title: `Notas de Entrada - ${selectedProyecto.nombre}`,
      selectedProyecto,
      asignaciones,
      proveedores,
      entradas,
      reporteMovimientos,
      totalEntradas,
      totalSalidas,
      currentUser: req.session?.user || {}
    });
  } catch (error) {
    next(error);
  } finally {
    conn.release();
  }
});

// FASE 2B: Registrar Entrada
router.post('/movimientos/:id_proyecto/entradas', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);
    await ensureContabilidadAutoSchema(conn);
    await conn.beginTransaction();

    const proyectoId = Number(req.params.id_proyecto);
    const {
      almacen_material_id,
      documento_referencia,
      proveedor_id,
      cantidad,
      observacion
    } = req.body;

    const asignacionId = Number(almacen_material_id || 0);
    const qty = Number(cantidad || 0);
    const docsRef = toUpperTrim(documento_referencia);
    const observacionFinal = toUpperTrim(observacion);
    const registradoPor = toUpperTrim(req.session?.user?.username || req.session?.user?.nombre || 'SISTEMA');
    const proveedorId = Number(proveedor_id || 0);

    if (qty <= 0) {
      throw new Error('La cantidad debe ser mayor a cero.');
    }

    if (!docsRef) {
      throw new Error('El documento de referencia es obligatorio para registrar entradas.');
    }

    if (!asignacionId) {
      throw new Error('Debe seleccionar un material asignado al proyecto.');
    }

    const [[asignacion]] = await conn.query(
      'SELECT id, material_id, proyecto_id, cantidad_presupuestada, stock_fisico, cantidad_disponible, precio_unitario FROM almacen_proyecto_materiales WHERE id = ? AND proyecto_id = ?',
      [asignacionId, proyectoId]
    );

    if (!asignacion) {
      throw new Error('La asignación de material no existe o no pertenece a este proyecto.');
    }

    const saldoActual = Number(asignacion.stock_fisico || asignacion.cantidad_disponible || 0);
    const nuevaCantidad = saldoActual + qty;
    const presupuesto = Number(asignacion.cantidad_presupuestada || 0);

    if (presupuesto > 0 && nuevaCantidad > presupuesto) {
      throw new Error(`Entrada excede el presupuesto del proyecto para este material. Meta: ${presupuesto.toFixed(2)}, Stock resultante: ${nuevaCantidad.toFixed(2)}.`);
    }

    const nuevoImporte = nuevaCantidad * Number(asignacion.precio_unitario || 0);
    const saldoResultante = nuevaCantidad;

    await conn.query(
      'UPDATE almacen_proyecto_materiales SET stock_fisico = ?, cantidad_disponible = ?, importe = ? WHERE id = ?',
      [nuevaCantidad, nuevaCantidad, nuevoImporte, asignacionId]
    );

    await conn.query(
      `
      INSERT INTO movimientos_almacen
        (material_id, proyecto_id, almacen_material_id, tipo, referencia_documento, cantidad, saldo_resultante, observacion, registrado_por, proveedor_id, fecha)
      VALUES (?, ?, ?, 'Ingreso', ?, ?, ?, ?, ?, ?, NOW())
      `,
      [
        asignacion.material_id,
        proyectoId,
        asignacionId,
        docsRef,
        qty,
        saldoResultante,
        observacionFinal,
        registradoPor,
        proveedorId || null
      ]
    );

    const [[material]] = await conn.query('SELECT nombre FROM materiales WHERE id = ?', [asignacion.material_id]);
    const materialNombre = material?.nombre || 'Material';
    const descripcionAsiento = `Autoasiento Entrada Almacen ${docsRef} - ${materialNombre} (${qty.toFixed(2)})`;

    await conn.query(
      `
      INSERT INTO asientos_contables
        (fecha, tipo, categoria, descripcion, monto, estado_pago, registrado_por, proyecto_id)
      VALUES (CURDATE(), 'Egreso', 'Materiales', ?, ?, 'Pendiente', ?, ?)
      `,
      [descripcionAsiento, qty * Number(asignacion.precio_unitario || 0), registradoPor, proyectoId]
    );

    await conn.query('UPDATE materiales SET stock_actual = stock_actual + ? WHERE id = ?', [qty, asignacion.material_id]);

    await conn.commit();
    res.redirect(`/almacen/movimientos/${proyectoId}/entradas`);
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

// FASE 3A: Vista de Salidas
router.get('/movimientos/:id_proyecto/salidas', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);

    const proyectoId = Number(req.params.id_proyecto);

    const [[selectedProyecto]] = await conn.query('SELECT id, nombre, ubicacion, estado FROM proyectos WHERE id = ?', [proyectoId]);
    if (!selectedProyecto) {
      return res.status(404).render('partials/error', {
        title: 'Error',
        error: 'Proyecto no encontrado.'
      });
    }

    const [asignaciones] = await conn.query(`
      SELECT
        apm.id,
        apm.proyecto_id,
        apm.material_id,
        COALESCE(apm.stock_fisico, apm.cantidad_disponible, 0) AS cantidad_disponible,
        COALESCE(apm.cantidad_presupuestada, apm.cantidad_disponible, 0) AS cantidad_presupuestada,
        apm.precio_unitario,
        m.codigo,
        m.nombre AS material_nombre,
        m.unidad
      FROM almacen_proyecto_materiales apm
      INNER JOIN materiales m ON m.id = apm.material_id
      WHERE apm.proyecto_id = ?
      ORDER BY m.nombre
    `, [proyectoId]);

    const [proveedores] = await conn.query('SELECT id, nombre, ruc FROM proveedores WHERE estado = ? ORDER BY nombre', ['Activo']);

    const [salidas] = await conn.query(`
      SELECT
        mov.id,
        mov.fecha,
        mov.destino_frente,
        mov.responsable_movimiento,
        mov.cantidad,
        mov.saldo_resultante,
        mov.observacion,
        m.nombre AS material,
        m.unidad,
        apm.cantidad_disponible
      FROM movimientos_almacen mov
      INNER JOIN materiales m ON m.id = mov.material_id
      LEFT JOIN almacen_proyecto_materiales apm ON apm.id = mov.almacen_material_id
      WHERE mov.proyecto_id = ? AND mov.tipo = 'Salida'
      ORDER BY mov.fecha DESC
      LIMIT 50
    `, [proyectoId]);

    const [reporteMovimientos] = await conn.query(`
      SELECT
        mov.id,
        mov.fecha,
        mov.tipo,
        mov.referencia_documento,
        mov.destino_frente,
        mov.responsable_movimiento,
        mov.cantidad,
        mov.saldo_resultante,
        mov.observacion,
        m.nombre AS material,
        m.unidad,
        pr.nombre AS proveedor_nombre
      FROM movimientos_almacen mov
      INNER JOIN materiales m ON m.id = mov.material_id
      LEFT JOIN proveedores pr ON pr.id = mov.proveedor_id
      WHERE mov.proyecto_id = ?
      ORDER BY mov.fecha DESC, mov.id DESC
      LIMIT 200
    `, [proyectoId]);

    const totalEntradas = reporteMovimientos.filter((item) => item.tipo === 'Ingreso').length;
    const totalSalidas = reporteMovimientos.filter((item) => item.tipo === 'Salida').length;

    res.render('almacen/movimientos-salidas', {
      title: `Notas de Salida - ${selectedProyecto.nombre}`,
      selectedProyecto,
      asignaciones,
      proveedores,
      salidas,
      reporteMovimientos,
      totalEntradas,
      totalSalidas,
      currentUser: req.session?.user || {}
    });
  } catch (error) {
    next(error);
  } finally {
    conn.release();
  }
});

// FASE 3B: Registrar Salida
router.post('/movimientos/:id_proyecto/salidas', requireRole('admin'), async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    await ensureAlmacenSchema(conn);
    await conn.beginTransaction();

    const proyectoId = Number(req.params.id_proyecto);
    const {
      almacen_material_id,
      destino_frente,
      responsable_movimiento,
      cantidad,
      observacion
    } = req.body;

    const asignacionId = Number(almacen_material_id || 0);
    const qty = Number(cantidad || 0);
    const destinoFrente = toUpperTrim(destino_frente);
    const responsableMovimiento = toUpperTrim(responsable_movimiento);
    const observacionFinal = toUpperTrim(observacion);
    const registradoPor = toUpperTrim(req.session?.user?.username || req.session?.user?.nombre || 'SISTEMA');

    if (qty <= 0) {
      throw new Error('La cantidad debe ser mayor a cero.');
    }

    if (!destinoFrente) {
      throw new Error('El frente/partida de trabajo es obligatorio para registrar salidas.');
    }

    if (!responsableMovimiento) {
      throw new Error('El responsable del retiro es obligatorio para registrar salidas.');
    }

    if (!asignacionId) {
      throw new Error('Debe seleccionar un material asignado al proyecto.');
    }

    const [[asignacion]] = await conn.query(
      'SELECT id, material_id, proyecto_id, stock_fisico, cantidad_disponible, precio_unitario FROM almacen_proyecto_materiales WHERE id = ? AND proyecto_id = ?',
      [asignacionId, proyectoId]
    );

    if (!asignacion) {
      throw new Error('La asignación de material no existe o no pertenece a este proyecto.');
    }

    const saldoActual = Number(asignacion.stock_fisico || asignacion.cantidad_disponible || 0);

    if (qty > saldoActual) {
      throw new Error(`Stock insuficiente. Disponible: ${saldoActual.toFixed(2)}, Solicitado: ${qty.toFixed(2)}`);
    }

    const nuevaCantidad = saldoActual - qty;
    const nuevoImporte = nuevaCantidad * Number(asignacion.precio_unitario || 0);
    const saldoResultante = nuevaCantidad;

    await conn.query(
      'UPDATE almacen_proyecto_materiales SET stock_fisico = ?, cantidad_disponible = ?, importe = ? WHERE id = ?',
      [nuevaCantidad, nuevaCantidad, nuevoImporte, asignacionId]
    );

    await conn.query(
      `
      INSERT INTO movimientos_almacen
        (material_id, proyecto_id, almacen_material_id, tipo, destino_frente, responsable_movimiento, cantidad, saldo_resultante, observacion, registrado_por, fecha)
      VALUES (?, ?, ?, 'Salida', ?, ?, ?, ?, ?, ?, NOW())
      `,
      [
        asignacion.material_id,
        proyectoId,
        asignacionId,
        destinoFrente,
        responsableMovimiento,
        qty,
        saldoResultante,
        observacionFinal,
        registradoPor
      ]
    );

    await conn.query('UPDATE materiales SET stock_actual = stock_actual - ? WHERE id = ?', [qty, asignacion.material_id]);

    await conn.commit();
    res.redirect(`/almacen/movimientos/${proyectoId}/salidas`);
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally {
    conn.release();
  }
});

module.exports = router;
