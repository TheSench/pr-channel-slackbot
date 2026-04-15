import fs from 'fs';
import { spawnSync } from 'child_process';

/**
 * @typedef {Object} ChannelState
 * @property {Array<string>} unresolvedMessageTimestamps
 * @property {string|null} lastDigestThreadTimestamp
 */

/**
 * Run a git command, throwing if it exits non-zero.
 * @param {string[]} args
 */
function git(...args) {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited with status ${result.status}`);
  }
}

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
  git('add', stateFile);
  const diff = spawnSync('git', ['diff', '--cached', '--exit-code', '--', stateFile], { stdio: 'ignore' });
  if (diff.status === 0) {
    console.info('No changes to state file, skipping commit.');
    return;
  }
  git('commit', '-m', 'chore: update PR channel state [skip ci]');
  git('push', 'origin', `HEAD:refs/heads/${process.env.GITHUB_REF_NAME}`);
}
