CREATE TABLE proyectos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  cliente VARCHAR(150) NOT NULL,
  ubicacion VARCHAR(180) NOT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  presupuesto DECIMAL(14,2) NOT NULL DEFAULT 0,
  estado VARCHAR(30) NOT NULL DEFAULT 'Planificado'
);

CREATE TABLE empleados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  cargo VARCHAR(100) NOT NULL,
  salario DECIMAL(12,2) NOT NULL DEFAULT 0,
  proyecto_id INT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(60) NOT NULL UNIQUE,
  password VARCHAR(120) NOT NULL,
  role ENUM('admin','usuario') NOT NULL DEFAULT 'usuario',
  empleado_id INT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL
);

CREATE TABLE proveedores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(150) NOT NULL,
  contacto VARCHAR(150),
  telefono VARCHAR(20),
  email VARCHAR(100),
  ruc VARCHAR(15),
  estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE actividades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(30) NOT NULL UNIQUE,
  nombre VARCHAR(180) NOT NULL,
  descripcion TEXT,
  proyecto_id INT NOT NULL,
  responsable_id INT NULL,
  partida VARCHAR(120),
  prioridad VARCHAR(20) NOT NULL,
  estado VARCHAR(30) NOT NULL,
  fecha_inicio_programada DATE,
  fecha_fin_programada DATE,
  avance_porcentaje DECIMAL(5,2) NOT NULL DEFAULT 0,
  unidad_meta VARCHAR(20),
  meta_cantidad DECIMAL(12,2) NOT NULL DEFAULT 0,
  fecha_actualizacion DATETIME,
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
  FOREIGN KEY (responsable_id) REFERENCES empleados(id) ON DELETE SET NULL
);

CREATE TABLE gantt_tareas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proyecto_id INT NOT NULL,
  nombre VARCHAR(180) NOT NULL,
  responsable_id INT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  avance DECIMAL(5,2) NOT NULL DEFAULT 0,
  estado VARCHAR(30) NOT NULL DEFAULT 'Programada',
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
  FOREIGN KEY (responsable_id) REFERENCES empleados(id) ON DELETE SET NULL
);

CREATE TABLE partidas_ingenieria (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proyecto_id INT NOT NULL,
  nombre VARCHAR(180) NOT NULL,
  unidad VARCHAR(20),
  metrado DECIMAL(12,2) NOT NULL DEFAULT 0,
  rendimiento_planeado DECIMAL(12,2) NOT NULL DEFAULT 0,
  especialidad VARCHAR(100),
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE
);

CREATE TABLE calculos_materiales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proyecto_id INT NULL,
  tipo_calculo VARCHAR(40) NOT NULL,
  detalle TEXT,
  resultado_json JSON NOT NULL,
  creado_en DATETIME NOT NULL,
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
);

CREATE TABLE materiales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(30) NOT NULL UNIQUE,
  nombre VARCHAR(180) NOT NULL,
  familia VARCHAR(80),
  grupo_material VARCHAR(80),
  subgrupo VARCHAR(80),
  categoria VARCHAR(80),
  unidad VARCHAR(20) NOT NULL,
  stock_actual DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_minimo DECIMAL(12,2) NOT NULL DEFAULT 0,
  costo_unitario DECIMAL(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE almacen_proyecto_materiales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proyecto_id INT NOT NULL,
  material_id INT NOT NULL,
  cantidad_disponible DECIMAL(12,2) NOT NULL DEFAULT 0,
  precio_unitario DECIMAL(12,2) NOT NULL DEFAULT 0,
  importe DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_proyecto_material (proyecto_id, material_id),
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE CASCADE,
  FOREIGN KEY (material_id) REFERENCES materiales(id) ON DELETE CASCADE
);

CREATE TABLE almacen_catalogos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tipo VARCHAR(30) NOT NULL,
  valor VARCHAR(120) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tipo_valor (tipo, valor)
);

CREATE TABLE movimientos_almacen (
  id INT AUTO_INCREMENT PRIMARY KEY,
  material_id INT NOT NULL,
  proyecto_id INT NULL,
  almacen_material_id INT NULL,
  proveedor_id INT NULL,
  tipo VARCHAR(20) NOT NULL,
  motivo_operacion VARCHAR(60),
  referencia_documento VARCHAR(80),
  destino_frente VARCHAR(120),
  responsable_movimiento VARCHAR(120),
  cantidad DECIMAL(12,2) NOT NULL,
  saldo_resultante DECIMAL(12,2),
  observacion VARCHAR(255),
  registrado_por VARCHAR(120),
  fecha DATETIME NOT NULL,
  FOREIGN KEY (material_id) REFERENCES materiales(id) ON DELETE CASCADE,
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL,
  FOREIGN KEY (almacen_material_id) REFERENCES almacen_proyecto_materiales(id) ON DELETE SET NULL,
  FOREIGN KEY (proveedor_id) REFERENCES proveedores(id) ON DELETE SET NULL
);

CREATE TABLE nominas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  empleado_id INT NOT NULL,
  periodo VARCHAR(20) NOT NULL,
  salario_base DECIMAL(12,2) NOT NULL,
  horas_extra DECIMAL(12,2) NOT NULL DEFAULT 0,
  adelanto_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  descuentos_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  descuentos DECIMAL(12,2) NOT NULL DEFAULT 0,
  neto_pagar DECIMAL(12,2) NOT NULL,
  FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
);

CREATE TABLE rrhh_asistencias (
  id INT AUTO_INCREMENT PRIMARY KEY,
  empleado_id INT NOT NULL,
  fecha DATE NOT NULL,
  semana_inicio DATE NOT NULL,
  asistio TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rrhh_asistencia_empleado_fecha (empleado_id, fecha),
  KEY idx_rrhh_asistencia_semana (semana_inicio),
  FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
);

CREATE TABLE rrhh_asistencia_ajustes (
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
  FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE CASCADE
);

CREATE TABLE asientos_contables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fecha DATE NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  categoria VARCHAR(80) NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  monto DECIMAL(14,2) NOT NULL,
  estado_pago ENUM('Pagado','Pendiente') NOT NULL DEFAULT 'Pagado',
  registrado_por VARCHAR(120) NULL,
  proyecto_id INT NULL,
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL
);

CREATE TABLE documentos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proyecto_id INT NULL,
  tipo VARCHAR(80) NOT NULL,
  titulo VARCHAR(180) NOT NULL,
  responsable VARCHAR(120) NOT NULL,
  fecha_documento DATE NOT NULL,
  url_referencia VARCHAR(255),
  created_by_user_id INT NULL,
  FOREIGN KEY (proyecto_id) REFERENCES proyectos(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO proyectos (nombre, cliente, ubicacion, fecha_inicio, fecha_fin, presupuesto, estado) VALUES
('Edificio Mirador Norte', 'Inversiones Andinas', 'Lima', '2026-01-10', '2026-12-20', 1500000, 'En ejecucion'),
('Condominio Santa Clara', 'Grupo Santa Clara', 'Arequipa', '2026-02-01', '2027-01-15', 2250000, 'Planificado');

INSERT INTO empleados (nombre, cargo, salario, proyecto_id, estado) VALUES
('Juan Perez', 'Ingeniero Residente', 6500, 1, 'Activo'),
('Luis Gomez', 'Maestro de Obra', 3500, 1, 'Activo'),
('Maria Torres', 'Asistente Administrativa', 3200, 2, 'Activo'),
('Carlos Rojas', 'Operario', 2200, 1, 'Activo');

INSERT INTO users (username, password, role, empleado_id, activo) VALUES
('admin', 'admin123', 'admin', 1, 1),
('operario', 'worker123', 'usuario', 4, 1);

INSERT INTO proveedores (nombre, contacto, telefono, email, ruc, estado) VALUES
('Cementos Lima S.A.', 'Gerente de Ventas', '+51 987654321', 'ventas@cementoslima.pe', '20123456789', 'Activo'),
('Hierros y Aceros Perú', 'Juan Cortez', '+51 995123456', 'contacto@hierrospy.com', '20987654321', 'Activo'),
('Distribuidora de Áridos', 'Maria López', '+51 991234567', 'info@aridosperu.com', '20654321987', 'Activo'),
('Tuberías y Accesorios HF', 'Carlos Hidalgo', '+51 993456789', 'ventas@tuberiasfh.pe', '20456789123', 'Activo'),
('Pinturas Nacional S.A.', 'Sandra Ruiz', '+51 996789012', 'contacto@pinturanacional.com', '20789123456', 'Activo');

INSERT INTO actividades (codigo, nombre, descripcion, proyecto_id, responsable_id, partida, prioridad, estado, fecha_inicio_programada, fecha_fin_programada, avance_porcentaje, unidad_meta, meta_cantidad, fecha_actualizacion) VALUES
('ACT-001', 'Vaciado de zapatas', 'Concreto estructural para cimentacion', 1, 1, 'Cimentacion', 'Alta', 'En proceso', '2026-03-01', '2026-03-08', 65, 'm3', 40, NOW()),
('ACT-002', 'Armado de acero columnas', 'Habilitado y montaje de acero', 1, 2, 'Estructuras', 'Alta', 'Pendiente', '2026-03-09', '2026-03-14', 15, 'kg', 2800, NOW()),
('ACT-003', 'Tarrajeo exterior torre A', 'Acabado exterior primer bloque', 2, 3, 'Acabados', 'Media', 'Completada', '2026-03-02', '2026-03-05', 100, 'm2', 120, NOW()),
('ACT-004', 'Limpieza de frente de trabajo', 'Habilitacion del area para vaciado', 1, 4, 'Preliminares', 'Media', 'Pendiente', '2026-03-10', '2026-03-12', 0, 'm2', 180, NOW());

INSERT INTO gantt_tareas (proyecto_id, nombre, responsable_id, fecha_inicio, fecha_fin, avance, estado) VALUES
(1, 'Excavacion de zapatas', 2, '2026-03-01', '2026-03-04', 100, 'Completada'),
(1, 'Vaciado de zapatas', 1, '2026-03-05', '2026-03-08', 65, 'En proceso'),
(1, 'Armado de columnas', 2, '2026-03-09', '2026-03-13', 20, 'Programada'),
(1, 'Limpieza y habilitacion', 4, '2026-03-10', '2026-03-12', 0, 'Programada'),
(2, 'Tarrajeo exterior', 3, '2026-03-02', '2026-03-06', 100, 'Completada');

INSERT INTO partidas_ingenieria (proyecto_id, nombre, unidad, metrado, rendimiento_planeado, especialidad) VALUES
(1, 'Concreto f\'c=210 zapatas', 'm3', 40, 12, 'Estructuras'),
(1, 'Acero corrugado columnas', 'kg', 2800, 900, 'Estructuras'),
(2, 'Tarrajeo exterior', 'm2', 120, 55, 'Arquitectura');

INSERT INTO materiales (codigo, nombre, familia, grupo_material, subgrupo, categoria, unidad, stock_actual, stock_minimo, costo_unitario) VALUES
('MAT-00000001', 'CEMENTO TIPO I', 'AGLOMERANTES', 'CEMENTOS', 'PORTLAND', 'AGLOMERANTES', 'BOLSA', 80, 100, 31),
('MAT-00000002', 'ARENA GRUESA', 'AGREGADOS', 'ARIDOS', 'ARENA', 'AGREGADOS', 'M3', 24, 10, 58),
('MAT-00000003', 'PIEDRA CHANCADA', 'AGREGADOS', 'ARIDOS', 'PIEDRA', 'AGREGADOS', 'M3', 16, 8, 72),
('MAT-00000004', 'ACERO 3/8', 'METALES', 'ACERO CORRUGADO', 'REFUERZO', 'ACERO', 'KG', 950, 500, 4.8);

INSERT INTO almacen_catalogos (tipo, valor) VALUES
('FAMILIA', 'AGLOMERANTES'),
('FAMILIA', 'AGREGADOS'),
('FAMILIA', 'METALES'),
('GRUPO', 'CEMENTOS'),
('GRUPO', 'ARIDOS'),
('GRUPO', 'ACERO CORRUGADO'),
('SUBGRUPO', 'PORTLAND'),
('SUBGRUPO', 'ARENA'),
('SUBGRUPO', 'PIEDRA'),
('SUBGRUPO', 'REFUERZO'),
('UNIDAD', 'BOLSA'),
('UNIDAD', 'M3'),
('UNIDAD', 'KG');

INSERT INTO almacen_proyecto_materiales (proyecto_id, material_id, cantidad_disponible, precio_unitario, importe) VALUES
(1, 1, 40, 31, 1240),
(1, 4, 120, 4.8, 576),
(2, 2, 24, 58, 1392);

INSERT INTO movimientos_almacen (material_id, proyecto_id, almacen_material_id, tipo, motivo_operacion, referencia_documento, destino_frente, responsable_movimiento, cantidad, saldo_resultante, observacion, registrado_por, fecha) VALUES
(1, 1, 1, 'Salida', 'CONSUMO OBRA', 'N/SAL-001', 'CIMENTACION', 'CAPATAZ JUAN PEREZ', 40, 0, 'Despacho a cimentacion', 'ADMIN', NOW()),
(2, 2, 3, 'Ingreso', 'COMPRA LOCAL', 'OC-1002', NULL, NULL, 8, 32, 'Compra local', 'ADMIN', NOW()),
(4, 1, 2, 'Salida', 'CONSUMO OBRA', 'N/SAL-002', 'ESTRUCTURA NIVEL 2', 'MAESTRO LUIS GOMEZ', 120, 0, 'Armado de columnas', 'ADMIN', NOW());

INSERT INTO nominas (empleado_id, periodo, salario_base, horas_extra, descuentos, neto_pagar) VALUES
(1, '2026-03', 6500, 250, 100, 6650),
(2, '2026-03', 3500, 120, 0, 3620),
(4, '2026-03', 2200, 80, 10, 2270);

INSERT INTO asientos_contables (fecha, tipo, categoria, descripcion, monto, estado_pago, registrado_por, proyecto_id) VALUES
('2026-03-01', 'Egreso', 'Materiales', 'Compra de cemento y agregados', 12850, 'Pagado', 'ADMIN', 1),
('2026-03-02', 'Egreso', 'Mano de Obra (Tareos)', 'Pago de personal quincena', 8450, 'Pagado', 'ADMIN', 1),
('2026-03-05', 'Ingreso', 'Valorizacion', 'Cobro valorizacion parcial', 42000, 'Pagado', 'ADMIN', 1);

INSERT INTO documentos (proyecto_id, tipo, titulo, responsable, fecha_documento, url_referencia) VALUES
(1, 'Informe diario', 'Informe de produccion semana 10', 'Juan Perez', '2026-03-07', 'https://example.com/informe-semana-10'),
(1, 'Plano', 'Plano cimentacion revision B', 'Oficina tecnica', '2026-03-03', 'https://example.com/plano-cimentacion-b');
