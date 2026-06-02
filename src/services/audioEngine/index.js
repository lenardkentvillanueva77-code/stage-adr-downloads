'use strict';

const { AudioEngineClient, resolveEnginePath } = require('./engineClient');

const client = new AudioEngineClient();

module.exports = {
  client,
  resolveEnginePath,
};

