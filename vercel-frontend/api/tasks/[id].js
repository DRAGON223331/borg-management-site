'use strict';

// Explicit nested route: /api/tasks/:id
// Forward to the shared API handler while passing a stable route path.
const handler = require('../[...path].js');

module.exports = function taskById(req, res) {
  const id = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  req.query = { ...(req.query || {}), path: ['tasks', String(id ?? '')] };
  return handler(req, res);
};
