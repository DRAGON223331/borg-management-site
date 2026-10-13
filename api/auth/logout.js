
'use strict';

const handler = require('../[...path].js');

module.exports = function discordLogout(req, res) {
  req.query = {
    ...(req.query || {}),
    path: ['auth', 'logout']
  };

  return handler(req, res);
};
