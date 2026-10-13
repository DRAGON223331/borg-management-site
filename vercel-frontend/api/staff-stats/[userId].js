'use strict';

// Explicit route wrapper for /api/staff-stats/:userId.
const handler = require('../[...path].js');

module.exports = function staffStatsByUser(req, res) {
  const userId = Array.isArray(req.query?.userId) ? req.query.userId[0] : req.query?.userId;
  req.query = { ...(req.query || {}), path: ['staff-stats', String(userId ?? '')] };
  return handler(req, res);
};
