
'use strict';

const handler = require('../[...path].js');

module.exports = function discordCallback(req, res) {
  req.query = {
    ...(req.query || {}),
    path: ['auth', 'callback']
  };

  return handler(req, res);
};
