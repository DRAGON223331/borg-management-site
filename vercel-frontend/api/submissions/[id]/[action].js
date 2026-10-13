'use strict';

// Explicit nested route: /api/submissions/:id/approve|reject
const handler = require('../../[...path].js');

module.exports = function submissionReview(req, res) {
  const id = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
  const action = Array.isArray(req.query?.action) ? req.query.action[0] : req.query?.action;
  req.query = { ...(req.query || {}), path: ['submissions', String(id ?? ''), String(action ?? '')] };
  return handler(req, res);
};
