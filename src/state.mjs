import fs from 'fs';

/**
 * @typedef {Object} ChannelState
 * @property {Array<string>} unresolvedMessageTimestamps
 * @property {string|null} lastDigestThreadTimestamp
 */

/**
 * Load state from the state file.
 * Returns {} if the file does not exist (clean first run).
 * @param {string} stateFile
 * @returns {Object.<string, ChannelState>}
 */
export function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

/**
 * Get the state for a channel with defaults applied.
 * @param {Object.<string, ChannelState>} state
 * @param {string} channelId
 * @returns {ChannelState}
 */
export function getChannelState(state, channelId) {
  return {
    unresolvedMessageTimestamps: [],
    lastDigestThreadTimestamp: null,
    ...(state[channelId] ?? {})
  };
}

/**
 * Write state to disk.
 * @param {string} stateFile
 * @param {Object.<string, ChannelState>} state
 */
export function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
