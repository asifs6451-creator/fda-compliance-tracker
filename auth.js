function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login.html');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (roles.includes(req.session.user.role)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

/**
 * For data endpoints: filter results to the pharmacist's own warehouse.
 * Admins and managers see everything.
 */
function warehouseFilter(req) {
  const u = req.session?.user;
  if (!u) return null;
  if (u.role === 'pharmacist' && u.warehouse_id) return u.warehouse_id;
  return null; // null = all warehouses
}

module.exports = { requireAuth, requireRole, warehouseFilter };
