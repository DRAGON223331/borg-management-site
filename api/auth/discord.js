
'use strict';

const handler = require('../[...path].js');

module.exports = function discordLogin(req, res) {
  req.query = {
    ...(req.query || {}),
    path: ['auth', 'discord']
  };

  return handler(req, res);
};
