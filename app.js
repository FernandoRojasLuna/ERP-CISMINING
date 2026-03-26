const express = require('express');
const path = require('path');
const morgan = require('morgan');
const methodOverride = require('method-override');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
require('dotenv').config();

const { requireAuth } = require('./middleware/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layouts/main');
app.use(expressLayouts);
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'construction-suite-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

app.use((req, res, next) => {
  res.locals.currentModule = req.path.split('/')[1] || 'dashboard';
  res.locals.currentUser = req.session?.user || null;
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', requireAuth, require('./routes/dashboard'));
app.use('/obras', requireAuth, require('./routes/obras'));
app.use('/actividades', requireAuth, require('./routes/actividades'));
app.use('/ingenieria', requireAuth, require('./routes/ingenieria'));
app.use('/almacen', requireAuth, require('./routes/almacen'));
app.use('/rrhh', requireAuth, require('./routes/rrhh'));
app.use('/asistencias', requireAuth, require('./routes/asistencias'));
app.use('/contabilidad', requireAuth, require('./routes/contabilidad'));
app.use('/documentos', requireAuth, require('./routes/documentos'));
app.use('/reportes', requireAuth, require('./routes/reportes'));
app.use('/gantt', requireAuth, require('./routes/gantt'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('partials/error', {
    title: 'Error',
    error: err.message || 'Error interno del servidor'
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Servidor ejecutandose en http://localhost:${port}`);
});
