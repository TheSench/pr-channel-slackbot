import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('./slack.mjs', () => ({
  getMessagePage: vi.fn(),
  getMessageByTimestamp: vi.fn(),
  getPermalink: vi.fn(),
}));
vi.mock('./github.mjs', () => ({
  getPullRequestStatus: vi.fn(),
  getReviewReactions: vi.fn(),
}));
vi.mock('@actions/core', () => ({ getInput: vi.fn() }));
vi.mock('fs', () => ({ default: { readFileSync: vi.fn(), existsSync: vi.fn() } }));

import { collectMessages } from './workflow.mjs';
import { getMessagePage, getMessageByTimestamp } from './slack.mjs';

const OLD_TS = '50.0';
const DIGEST_TS = '100.0';
const NEW_TS = '150.0';

const oldMessage = { ts: OLD_TS, text: 'old PR' };
const newMessage = { ts: NEW_TS, text: 'new PR' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('collectMessages', () => {
  describe('when trackUnresolved is false', () => {
    it('returns all fetched messages even if they predate the last digest', async () => {
      // Slack returns newest-first; both messages are in the first page
      getMessagePage.mockResolvedValueOnce({
        messages: [newMessage, oldMessage],
        nextCursor: null,
      });

      const channelState = {
        lastDigestThreadTimestamp: DIGEST_TS,
        unresolvedMessageTimestamps: [],
      };

      const result = await collectMessages('C123', channelState, 50, 1, false);

      // Both messages should be included — digest timestamp must NOT be used as a filter
      expect(result).toEqual([oldMessage, newMessage]);
    });

    it('does not individually fetch previously-tracked message timestamps', async () => {
      getMessagePage.mockResolvedValueOnce({ messages: [newMessage], nextCursor: null });

      const channelState = {
        lastDigestThreadTimestamp: DIGEST_TS,
        unresolvedMessageTimestamps: [OLD_TS],
      };

      await collectMessages('C123', channelState, 50, 1, false);

      expect(getMessageByTimestamp).not.toHaveBeenCalled();
    });
  });

  describe('when trackUnresolved is true', () => {
    it('returns only post-digest paginated messages plus individually-tracked older messages', async () => {
      const digestMessage = { ts: DIGEST_TS, text: 'digest' };
      const trackedMessage = { ts: '25.0', text: 'tracked old' };

      getMessagePage.mockResolvedValueOnce({
        messages: [newMessage, oldMessage, digestMessage],
        nextCursor: null,
      });
      getMessageByTimestamp.mockResolvedValueOnce(trackedMessage);

      const channelState = {
        lastDigestThreadTimestamp: DIGEST_TS,
        unresolvedMessageTimestamps: ['25.0'],
      };

      const result = await collectMessages('C123', channelState, 50, 1, true);

      // Only post-digest from pagination + individually tracked (sorted ascending)
      expect(result).toEqual([trackedMessage, newMessage]);
    });
  });
});
