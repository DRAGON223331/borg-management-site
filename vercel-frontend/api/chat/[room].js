'use strict';

// Explicit nested route: /api/chat/:room
const handler = require('../[...path].js');

module.exports = function chatByRoom(req, res) {
  const room = Array.isArray(req.query?.room) ? req.query.room[0] : req.query?.room;
  req.query = { ...(req.query || {}), path: ['chat', String(room ?? '')] };
  return handler(req, res);
};
