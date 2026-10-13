'use strict';

// One function for every nested API route (keeps the deployment under the Hobby plan's 12-function limit).
// vercel.json rewrites e.g. /api/submissions/:id/:action -> /api/r?p=submissions/:id/:action
const handler = require('./[...path].js');

module.exports = function nestedRoute(req, res) {
  const raw = Array.isArray(req.query?.p) ? req.query.p[0] : req.query?.p;
  const path = String(raw || '').split('/').filter(Boolean);
  req.query = { ...(req.query || {}), path };
  return handler(req, res);
};
