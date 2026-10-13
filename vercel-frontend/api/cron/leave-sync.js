'use strict';

// Daily job (Vercel Cron, free on Hobby): /api/cron/leave-sync
const handler = require('../[...path].js');

module.exports = function leaveSync(req, res) {
  req.query = { ...(req.query || {}), path: ['cron', 'leave-sync'] };
  return handler(req, res);
};
