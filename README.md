# Construction Suite

Sistema web profesional de gestion de obra, con enfoque practico: dashboard, actividades, login por roles, calculadora de materiales, almacen, RRHH, contabilidad, documentos y un Gantt simple.

## Modulos incluidos
- Login con roles: administrador y usuario
- Dashboard ejecutivo con graficos
- Obras y proyectos
- Planeamiento Gantt simple
- Actividades de obra
- Ingenieria y calculadora de materiales
- Almacen e inventario
- RRHH y nomina basica
- Contabilidad resumida
- Documentos e informes
- Centro de reportes

## Credenciales demo
- Admin: `admin` / `admin123`
- Usuario: `operario` / `worker123`

## Tecnologias
- Node.js
- Express
- Express Session
- EJS
- MySQL
- Bootstrap 5
- Chart.js

## Instalacion
1. Crear la base de datos ejecutando `sql/schema.sql` en MySQL.
2. Copiar `.env.example` a `.env`.
3. Ajustar las credenciales de MySQL.
4. Instalar dependencias:
   ```bash
   npm install
   ```
5. Ejecutar:
   ```bash
   npm start
   ```
6. Abrir `http://localhost:3000`.

## Alcance actual
- El administrador puede crear registros y gestionar modulos de oficina.
- El usuario puede iniciar sesion y ver sus actividades y cronograma.
- El Gantt es simple, pensado como base inicial visual.
- Los documentos guardan metadatos y enlaces, no archivos binarios.

## Recomendaciones siguientes
- Hash de contrasenas con bcrypt.
- Exportacion PDF y Excel.
- Carga real de archivos.
- Gantt con dependencias y reprogramacion.
- Evidencias fotograficas en actividades.
