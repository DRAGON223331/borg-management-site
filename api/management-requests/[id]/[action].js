'use strict';

// Explicit route wrapper for /api/management-requests/:id/approve|reject.
const handler = require('../../[...path].js');

module.exports = function managementRequestReview(req, res) {
  const id = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  req.query = { ...(req.query || {}), path: ['management-requests', String(id ?? ''), String(action ?? '')] };
  return handler(req, res);
};
