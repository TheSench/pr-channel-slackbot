import fs from 'fs';
import { execSync } from 'child_process';

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
 * Write state to disk and commit it to the repo.
 * Skips the commit if the file has not changed.
 * Throws if git operations fail (caller should handle via setFailed).
 * @param {string} stateFile
 * @param {Object.<string, ChannelState>} state
 */
export function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  execSync(`git add "${stateFile}"`);
  try {
    execSync(`git diff --cached --exit-code -- "${stateFile}"`, { stdio: 'ignore' });
    console.info('No changes to state file, skipping commit.');
    return;
  } catch {
    // Staged changes exist — proceed with commit
  }
  execSync(`git commit -m "chore: update PR channel state [skip ci]"`);
  execSync(`git push`);
}
