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
  buildDigestThreadMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('./slack.mjs', () => ({
  addReaction: vi.fn(),
  postOpenPrs: vi.fn().mockResolvedValue('digest-ts'),
  markThreadSuperseded: vi.fn().mockResolvedValue(undefined),
  isDigest: vi.fn(() => false),
  getBotIdentity: vi.fn().mockResolvedValue({ userId: 'U123', botId: 'B123' }),
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

import { run, isNewer } from './index.mjs';
import { getConfig, collectMessages, shouldProcess, getAggregateStatus, buildPrMessage, buildDigestThreadMap } from './workflow.mjs';
import { loadState, saveState, getChannelState } from './state.mjs';
import { postOpenPrs, addReaction, markThreadSuperseded, isDigest } from './slack.mjs';
import { extractPullRequests } from './github.mjs';
import { getBooleanInput, setFailed } from '@actions/core';

beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults: empty channel list so the initial module-load run is a no-op
  getConfig.mockReturnValue({ reactionConfig: { merged: [], closed: [] }, channelConfig: [] });
  loadState.mockReturnValue({});
  postOpenPrs.mockResolvedValue('digest-ts');
  // Reset these explicitly since vi.clearAllMocks() does not reset mockReturnValue
  getBooleanInput.mockReturnValue(false);
  shouldProcess.mockReturnValue(false);
  buildDigestThreadMap.mockResolvedValue(new Map());
});

const BASE_CHANNEL = {
  channelId: 'C123',
  limit: 50,
  maxPages: 1,
  disableReactionCopying: false,
  allowBotMessages: false,
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

      expect(saveState).not.toHaveBeenCalled();
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

  describe('when a message has a resolved PR', () => {
    const PR_MESSAGE = { ts: '123.0', text: 'PR message' };

    beforeEach(() => {
      getConfig.mockReturnValue({
        reactionConfig: { merged: ['white-check-mark'], closed: ['x'], approved: ['approved'], changesRequested: ['changes-requested'] },
        channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: false }],
      });
      collectMessages.mockResolvedValue([PR_MESSAGE]);
      extractPullRequests.mockReturnValue([{ owner: 'org', repo: 'repo', pull_number: '1' }]);
      shouldProcess.mockReturnValue(true);
    });

    it('adds a reaction when the PR is merged', async () => {
      getAggregateStatus.mockResolvedValue('merged');

      await run();

      expect(addReaction).toHaveBeenCalledWith('C123', PR_MESSAGE.ts, 'white-check-mark');
    });

    it('adds a reaction when the PR is closed', async () => {
      getAggregateStatus.mockResolvedValue('closed');

      await run();

      expect(addReaction).toHaveBeenCalledWith('C123', PR_MESSAGE.ts, 'x');
    });

    it('also adds the reaction to the digest thread entry when the message appears in the map', async () => {
      const DIGEST_REPLY_TS = 'digest-reply-ts';
      buildDigestThreadMap.mockResolvedValue(new Map([[PR_MESSAGE.ts, DIGEST_REPLY_TS]]));
      getAggregateStatus.mockResolvedValue('merged');

      await run();

      expect(addReaction).toHaveBeenCalledWith('C123', DIGEST_REPLY_TS, 'white-check-mark');
    });

    it('does not add a second reaction call when the message is not in the digest thread map', async () => {
      getAggregateStatus.mockResolvedValue('merged');

      await run();

      expect(addReaction).toHaveBeenCalledTimes(1);
    });

    it('builds the digest thread map using the newest digest thread timestamp from fetched messages', async () => {
      getConfig.mockReturnValue({
        reactionConfig: { merged: ['merged'], closed: ['closed'] },
        channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: false }],
      });
      getChannelState.mockReturnValue({
        unresolvedMessageTimestamps: [],
        lastDigestThreadTimestamp: '123.0',
      });
      collectMessages.mockResolvedValue([
        { ts: '124.0', text: 'regular message' },
        { ts: '125.0', text: 'digest thread message' }
      ]);
      isDigest.mockImplementation((message) => message.ts === '125.0');
      shouldProcess.mockReturnValue(false);

      await run();

      expect(buildDigestThreadMap).toHaveBeenCalledWith('C123', '125.0');
    });
  });

  describe('when a message has an open PR', () => {
    const PR_MESSAGE = { ts: '123.0', text: 'PR message' };
    const DIGEST_ENTRY = { permalink: 'https://slack.com/link', reactions: ['approved'] };

    beforeEach(() => {
      getConfig.mockReturnValue({
        reactionConfig: { merged: ['merged'], closed: ['closed'], approved: ['approved'], changesRequested: ['changes-requested'] },
        channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: true }],
      });
      collectMessages.mockResolvedValue([PR_MESSAGE]);
      extractPullRequests.mockReturnValue([{}]);
      shouldProcess.mockReturnValue(true);
      getAggregateStatus.mockResolvedValue('open');
      buildPrMessage.mockResolvedValue(DIGEST_ENTRY);
    });

    it('includes the message in the digest', async () => {
      await run();

      expect(postOpenPrs).toHaveBeenCalledWith('C123', [DIGEST_ENTRY]);
    });

    it('records the message timestamp as unresolved in state', async () => {
      await run();

      const [, savedState] = saveState.mock.calls[0];
      expect(savedState['C123'].unresolvedMessageTimestamps).toContain(PR_MESSAGE.ts);
    });
  });

  describe('when skip-digest is true', () => {
    const PREV_DIGEST_TS = 'prev-digest-ts';

    beforeEach(() => {
      getBooleanInput.mockReturnValue(true);
      getConfig.mockReturnValue({
        reactionConfig: { merged: ['merged'], closed: ['closed'] },
        channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: true }],
      });
      getChannelState.mockReturnValue({
        unresolvedMessageTimestamps: [],
        lastDigestThreadTimestamp: PREV_DIGEST_TS,
      });
      collectMessages.mockResolvedValue([]);
    });

    it('does not post a new digest thread', async () => {
      await run();

      expect(postOpenPrs).not.toHaveBeenCalled();
    });

    it('preserves the previous digest thread timestamp in state', async () => {
      await run();

      const [, savedState] = saveState.mock.calls[0];
      expect(savedState['C123'].lastDigestThreadTimestamp).toBe(PREV_DIGEST_TS);
    });

    it('does not mark the previous digest as superseded', async () => {
      await run();

      expect(markThreadSuperseded).not.toHaveBeenCalled();
    });
  });

  describe('when posting a new digest', () => {
    beforeEach(() => {
      getConfig.mockReturnValue({
        reactionConfig: { merged: ['merged'], closed: ['closed'] },
        channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: true }],
      });
      collectMessages.mockResolvedValue([]);
    });

    it('marks the previous digest thread as superseded', async () => {
      const PREV_DIGEST_TS = 'prev-digest-ts';
      const NEW_DIGEST_TS = 'new-digest-ts';
      getChannelState.mockReturnValue({
        unresolvedMessageTimestamps: [],
        lastDigestThreadTimestamp: PREV_DIGEST_TS,
      });
      postOpenPrs.mockResolvedValue(NEW_DIGEST_TS);

      await run();

      expect(markThreadSuperseded).toHaveBeenCalledWith('C123', PREV_DIGEST_TS, NEW_DIGEST_TS);
    });

    it('does not mark any digest as superseded when there is no previous digest', async () => {
      getChannelState.mockReturnValue({
        unresolvedMessageTimestamps: [],
        lastDigestThreadTimestamp: null,
      });

      await run();

      expect(markThreadSuperseded).not.toHaveBeenCalled();
    });
  });

  describe('when an error occurs', () => {
    it('reports the failure without throwing', async () => {
      getConfig.mockImplementation(() => { throw new Error('Config not found'); });

      await run();

      expect(setFailed).toHaveBeenCalledWith('Config not found');
    });
  });

  describe('isNewer', () => {
    it('returns true when there is no previous digest timestamp', () => {
      expect(isNewer('123.0', null)).toBe(true);
    });

    it('returns true when the message timestamp is newer', () => {
      expect(isNewer('124.0', '123.0')).toBe(true);
    });

    it('returns false when the message timestamp is older', () => {
      expect(isNewer('122.0', '123.0')).toBe(false);
    });

    it('returns false when either timestamp is invalid', () => {
      expect(isNewer('not-a-ts', '123.0')).toBe(false);
      expect(isNewer('123.0', 'not-a-ts')).toBe(false);
    });
  });

  it('passes allowBotMessages from channel config to shouldProcess', async () => {
    const PR_MESSAGE = { ts: '1.0', text: 'PR link' };
    getConfig.mockReturnValue({
      reactionConfig: { merged: ['merged'], closed: ['closed'] },
      channelConfig: [{ ...BASE_CHANNEL, trackUnresolved: false, allowBotMessages: true }],
    });
    collectMessages.mockResolvedValue([PR_MESSAGE]);
    extractPullRequests.mockReturnValue([{}]);

    await run();

    expect(shouldProcess).toHaveBeenCalledWith(PR_MESSAGE, [{}], expect.any(Object), true);
  });
});
