'use strict';

// The single entry point for the whole API (see vercel.json "builds" + "routes").
// /api/<anything> and /auth/<anything> arrive here as ?p=<anything>.
const handler = require('./[...path].js');

module.exports = function apiEntry(req, res) {
  const raw = Array.isArray(req.query?.p) ? req.query.p[0] : req.query?.p;
  const path = String(raw || '').split('/').filter(Boolean);
  req.query = { ...(req.query || {}), path };
  return handler(req, res);
};
