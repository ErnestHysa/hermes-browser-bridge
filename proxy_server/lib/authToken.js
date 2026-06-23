'use strict';

const fs = require('fs');
const { log } = require('./logger');

let _token = null;
let _tokenFile = process.env.HBS_AUTH_TOKEN_FILE || null;
let _tokenEnv = process.env.HBS_AUTH_TOKEN || null;

function _loadFromFile() {
  if (!_tokenFile) return null;
  try {
    const data = fs.readFileSync(_tokenFile, 'utf-8').trim();
    return data || null;
  } catch (e) {
    log('warn', 'authToken: failed to read token file', { file: _tokenFile, err: e.message });
    return null;
  }
}

function load() {
  _token = _loadFromFile() || _tokenEnv || null;
  if (_token) {
    log('info', 'authToken: loaded', { viaFile: !!_tokenFile, viaEnv: !_tokenFile });
  }
}

function getToken() {
  return _token;
}

function reload() {
  if (!_tokenFile) {
    _tokenEnv = process.env.HBS_AUTH_TOKEN || null;
    _token = _tokenEnv || null;
  } else {
    _token = _loadFromFile() || _tokenEnv || null;
  }
  log('info', 'authToken: reloaded', { tokenSet: !!_token });
}

load();

module.exports = { getToken, reload };
