function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('partials/error', {
        title: 'Acceso denegado',
        error: 'No tienes permisos para acceder a este modulo.'
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
