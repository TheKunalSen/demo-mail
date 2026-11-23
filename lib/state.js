'use strict';
// Remembers which mailboxes still have an administrator-issued temporary password.
const fs = require('fs');
const { config } = require('./config');

let state = { mustChange: {} };
try {
  state = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  if (!state.mustChange) state.mustChange = {};
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

function save() {
  const tmp = `${config.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, config.stateFile);
}

module.exports = {
  mustChange: (name) => Boolean(state.mustChange[name]),
  setMustChange(name, value) {
    if (value) state.mustChange[name] = true;
    else delete state.mustChange[name];
    save();
  },
};
