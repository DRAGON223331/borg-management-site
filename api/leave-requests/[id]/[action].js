'use strict';

// Explicit nested route: /api/leave-requests/:id/approve|reject
const handler = require('../../[...path].js');

module.exports = function leaveRequestReview(req, res) {
  const id = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  req.query = { ...(req.query || {}), path: ['leave-requests', String(id ?? ''), String(action ?? '')] };
  return handler(req, res);
};
