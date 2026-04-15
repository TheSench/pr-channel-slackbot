import { vi, describe, it, expect, beforeEach } from 'vitest';

// All vi.mock calls are hoisted before imports, so these are in place
// when index.mjs loads and its top-level `await run()` executes.
vi.mock('@actions/core', () => ({
  getBooleanInput: vi.fn(() => false),
  getInput: vi.fn(() => 'state.json'),
  setFailed: vi.fn(),
}));
vi.mock('./workflow.mjs', () => ({
  getConfig: vi.fn(() => ({ reactionConfig: { merged: [], closed: [] }, channelConfig: [] })),
  collectMessages: vi.fn().mockResolvedValue([]),
  shouldProcess: vi.fn(() => false),
  getAggregateStatus: vi.fn(),
  buildPrMessage: vi.fn(),
}));
vi.mock('./slack.mjs', () => ({
  addReaction: vi.fn(),
  postOpenPrs: vi.fn().mockResolvedValue('digest-ts'),
}));
vi.mock('./github.mjs', () => ({
  extractPullRequests: vi.fn(() => []),
}));
vi.mock('./state.mjs', () => ({
  loadState: vi.fn(() => ({})),
  saveState: vi.fn(),
  getChannelState: vi.fn(() => ({
    unresolvedMessageTimestamps: [],
    lastDigestThreadTimestamp: null,
  })),
}));

import { run } from './index.mjs';
import { getConfig, collectMessages } from './workflow.mjs';
import { loadState, saveState, getChannelState } from './state.mjs';
import { postOpenPrs } from './slack.mjs';

beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults: empty channel list so the initial module-load run is a no-op
  getConfig.mockReturnValue({ reactionConfig: { merged: [], closed: [] }, channelConfig: [] });
  loadState.mockReturnValue({});
  postOpenPrs.mockResolvedValue('digest-ts');
});

const BASE_CHANNEL = {
  channelId: 'C123',
  limit: 50,
  maxPages: 1,
  disableReactionCopying: false,
};

describe('run()', () => {
  describe('when trackUnresolved is false', () => {
    it('does not save state for the channel', async () => {
      getConfig.mockReturnValue({
        reactionConfig: { merged: ['merged'], closed: ['closed'] },
        channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: false }],
      });
      getChannelState.mockReturnValue({
        unresolvedMessageTimestamps: [],
        lastDigestThreadTimestamp: 'prev-digest-ts',
      });
      collectMessages.mockResolvedValue([]);

      await run();

      const [, savedState] = saveState.mock.calls[0];
      expect(savedState).not.toHaveProperty('C123');
    });
  });

  describe('when trackUnresolved is true', () => {
    it('saves state for the channel', async () => {
      getConfig.mockReturnValue({
        reactionConfig: { merged: ['merged'], closed: ['closed'] },
        channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: true }],
      });
      getChannelState.mockReturnValue({
        unresolvedMessageTimestamps: [],
        lastDigestThreadTimestamp: 'prev-digest-ts',
      });
      collectMessages.mockResolvedValue([]);

      await run();

      const [, savedState] = saveState.mock.calls[0];
      expect(savedState).toHaveProperty('C123');
    });
  });
});
