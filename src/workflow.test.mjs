import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('./slack.mjs', () => ({
  getMessagePage: vi.fn(),
  getMessageByTimestamp: vi.fn(),
  getPermalink: vi.fn(),
  getThreadReplies: vi.fn(),
}));
vi.mock('./github.mjs', () => ({
  getPullRequestStatus: vi.fn(),
  getReviewReactions: vi.fn(),
}));
vi.mock('@actions/core', () => ({ getInput: vi.fn() }));
vi.mock('fs', () => ({ default: { readFileSync: vi.fn(), existsSync: vi.fn() } }));

import { collectMessages, shouldProcess, getAggregateStatus, buildPrMessage, getConfig, buildDigestThreadMap } from './workflow.mjs';
import { getMessagePage, getMessageByTimestamp, getPermalink, getThreadReplies } from './slack.mjs';
import { getPullRequestStatus, getReviewReactions } from './github.mjs';
import { getInput } from '@actions/core';
import fs from 'fs';

const OLD_TS = '50.0';
const DIGEST_TS = '100.0';
const NEW_TS = '150.0';

const oldMessage = { ts: OLD_TS, text: 'old PR' };
const newMessage = { ts: NEW_TS, text: 'new PR' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getConfig', () => {
  beforeEach(() => {
    getInput.mockReturnValue('config.json');
  });

  it('applies default values to channel config when fields are omitted', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({
      channels: { ch1: { channelId: 'C123' } },
    }));

    const { channelConfig } = getConfig();

    expect(channelConfig[0]).toMatchObject({
      channelId: 'C123',
      limit: 50,
      maxPages: 1,
      trackUnresolved: true,
      enableReactionCopying: false,
    });
  });

  it('applies default emoji values to reaction config when fields are omitted', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ channels: {} }));

    const { reactionConfig } = getConfig();

    expect(reactionConfig).toMatchObject({
      approved: ['approved'],
      merged: ['merged'],
      closed: ['closed'],
      changesRequested: ['changesRequested'],
    });
  });

  it('uses custom emoji values when provided in the config file', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({
      reactions: { approved: ['thumbsup'], merged: ['white_check_mark'] },
      channels: {},
    }));

    const { reactionConfig } = getConfig();

    expect(reactionConfig.approved).toEqual(['thumbsup']);
    expect(reactionConfig.merged).toEqual(['white_check_mark']);
  });

  it('filters out channels that have no channelId', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({
      channels: {
        ch1: { channelId: 'C123' },
        ch2: { limit: 10 },
      },
    }));

    const { channelConfig } = getConfig();

    expect(channelConfig).toHaveLength(1);
    expect(channelConfig[0].channelId).toBe('C123');
  });

  it('filters out channels that are marked as disabled', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({
      channels: {
        ch1: { channelId: 'C123', disabled: true },
        ch2: { channelId: 'C456' },
      },
    }));

    const { channelConfig } = getConfig();

    expect(channelConfig).toHaveLength(1);
    expect(channelConfig[0].channelId).toBe('C456');
  });

  it('defaults allowBotMessages to true when omitted from channel config', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({
      channels: { ch1: { channelId: 'C123' } },
    }));

    const { channelConfig } = getConfig();

    expect(channelConfig[0].allowBotMessages).toBe(true);
  });
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

    it('fetches additional pages until the digest anchor is found', async () => {
      const page1Messages = [{ ts: '200.0' }, { ts: '180.0' }];
      const page2Messages = [{ ts: '120.0' }, { ts: DIGEST_TS }];

      getMessagePage
        .mockResolvedValueOnce({ messages: page1Messages, nextCursor: 'cursor1' })
        .mockResolvedValueOnce({ messages: page2Messages, nextCursor: null });

      const channelState = {
        lastDigestThreadTimestamp: DIGEST_TS,
        unresolvedMessageTimestamps: [],
      };

      const result = await collectMessages('C123', channelState, 50, 2, true);

      // Post-digest messages sorted ascending (ts > DIGEST_TS)
      expect(result).toEqual([{ ts: '120.0' }, { ts: '180.0' }, { ts: '200.0' }]);
    });

    it('stops paginating once the digest anchor is found', async () => {
      getMessagePage.mockResolvedValueOnce({
        messages: [newMessage, { ts: DIGEST_TS }],
        nextCursor: 'cursor1', // cursor exists but should not be followed
      });

      const channelState = {
        lastDigestThreadTimestamp: DIGEST_TS,
        unresolvedMessageTimestamps: [],
      };

      await collectMessages('C123', channelState, 50, 5, true);

      expect(getMessagePage).toHaveBeenCalledTimes(1);
    });

    it('skips individually fetching timestamps already retrieved via pagination', async () => {
      getMessagePage.mockResolvedValueOnce({
        messages: [newMessage, oldMessage, { ts: DIGEST_TS }],
        nextCursor: null,
      });

      const channelState = {
        lastDigestThreadTimestamp: DIGEST_TS,
        unresolvedMessageTimestamps: [OLD_TS], // OLD_TS is already in the paginated results
      };

      await collectMessages('C123', channelState, 50, 1, true);

      expect(getMessageByTimestamp).not.toHaveBeenCalled();
    });

    it('excludes tracked messages that have since been deleted', async () => {
      getMessagePage.mockResolvedValueOnce({
        messages: [newMessage, { ts: DIGEST_TS }],
        nextCursor: null,
      });
      getMessageByTimestamp.mockResolvedValueOnce(null); // message was deleted

      const channelState = {
        lastDigestThreadTimestamp: DIGEST_TS,
        unresolvedMessageTimestamps: ['25.0'],
      };

      const result = await collectMessages('C123', channelState, 50, 1, true);

      expect(result).toEqual([newMessage]);
    });

    it('returns all fetched messages when there is no previous digest', async () => {
      getMessagePage.mockResolvedValueOnce({
        messages: [newMessage, oldMessage],
        nextCursor: null,
      });

      const channelState = {
        lastDigestThreadTimestamp: null,
        unresolvedMessageTimestamps: [],
      };

      const result = await collectMessages('C123', channelState, 50, 1, true);

      expect(result).toEqual([oldMessage, newMessage]);
    });
  });
});

describe('shouldProcess', () => {
  const reactionConfig = {
    approved: ['approved'],
    merged: ['white-check-mark'],
    closed: ['x'],
    changesRequested: ['changes-requested'],
  };

  it('returns false when the message has no pull requests', () => {
    const message = { ts: '1.0', text: 'no PRs here' };
    expect(shouldProcess(message, [], reactionConfig)).toBe(false);
  });

  it('returns false when the message was posted by a bot', () => {
    const message = { ts: '1.0', text: 'PR link', bot_id: 'B123' };
    expect(shouldProcess(message, [{}], reactionConfig)).toBe(false);
  });

  it('returns false when the message already has a merged reaction', () => {
    const message = { ts: '1.0', text: 'PR link', reactions: [{ name: 'white-check-mark' }] };
    expect(shouldProcess(message, [{}], reactionConfig)).toBe(false);
  });

  it('returns false when the message already has a closed reaction', () => {
    const message = { ts: '1.0', text: 'PR link', reactions: [{ name: 'x' }] };
    expect(shouldProcess(message, [{}], reactionConfig)).toBe(false);
  });

  it('returns true for a message with a PR and no resolved reactions', () => {
    const message = { ts: '1.0', text: 'PR link' };
    expect(shouldProcess(message, [{}], reactionConfig)).toBe(true);
  });

  it('returns true when the message only has unrelated reactions', () => {
    const message = { ts: '1.0', text: 'PR link', reactions: [{ name: 'eyes' }] };
    expect(shouldProcess(message, [{}], reactionConfig)).toBe(true);
  });

  it('returns true for a bot message when allowBotMessages is true', () => {
    const message = { ts: '1.0', text: 'PR link', bot_id: 'B123' };
    expect(shouldProcess(message, [{}], reactionConfig, true)).toBe(true);
  });
});

describe('getAggregateStatus', () => {
  it('returns "open" when any PR is open', async () => {
    getPullRequestStatus
      .mockResolvedValueOnce('open')
      .mockResolvedValueOnce('merged');
    expect(await getAggregateStatus([{}, {}])).toBe('open');
  });

  it('returns "merged" when all PRs are merged', async () => {
    getPullRequestStatus.mockResolvedValue('merged');
    expect(await getAggregateStatus([{}])).toBe('merged');
  });

  it('returns "closed" when all PRs are closed', async () => {
    getPullRequestStatus.mockResolvedValue('closed');
    expect(await getAggregateStatus([{}])).toBe('closed');
  });

  it('returns "merged" when some PRs are merged and others are closed', async () => {
    getPullRequestStatus
      .mockResolvedValueOnce('merged')
      .mockResolvedValueOnce('closed');
    expect(await getAggregateStatus([{}, {}])).toBe('merged');
  });
});

describe('buildPrMessage', () => {
  const pr = { owner: 'org', repo: 'repo', pull_number: '1' };
  const reactionConfig = {
    approved: ['approved'],
    changesRequested: ['changes-requested'],
    merged: ['merged'],
    closed: ['closed'],
  };

  beforeEach(() => {
    getPermalink.mockResolvedValue('https://slack.com/archives/C123/p100');
    getReviewReactions.mockResolvedValue([]);
  });

  it('returns the Slack permalink for the message', async () => {
    const message = { ts: '1.0' };
    const result = await buildPrMessage('C123', message, pr, reactionConfig, false);
    expect(result.permalink).toBe('https://slack.com/archives/C123/p100');
  });

  it('includes existing message reactions when enableReactionCopying is true', async () => {
    const message = { ts: '1.0', reactions: [{ name: 'eyes' }, { name: 'rocket' }] };
    const result = await buildPrMessage('C123', message, pr, reactionConfig, true);
    expect(result.reactions).toEqual(expect.arrayContaining(['eyes', 'rocket']));
  });

  it('omits existing message reactions when enableReactionCopying is false', async () => {
    const message = { ts: '1.0', reactions: [{ name: 'eyes' }] };
    const result = await buildPrMessage('C123', message, pr, reactionConfig, false);
    expect(result.reactions).not.toContain('eyes');
  });

  it('includes reactions derived from GitHub reviews', async () => {
    getReviewReactions.mockResolvedValue(['approved']);
    const message = { ts: '1.0' };
    const result = await buildPrMessage('C123', message, pr, reactionConfig, false);
    expect(result.reactions).toContain('approved');
  });

  it('deduplicates reactions that appear in both existing and review sources', async () => {
    getReviewReactions.mockResolvedValue(['approved']);
    const message = { ts: '1.0', reactions: [{ name: 'approved' }] };
    const result = await buildPrMessage('C123', message, pr, reactionConfig, true);
    expect(result.reactions.filter(r => r === 'approved')).toHaveLength(1);
  });

  it('returns an empty reactions list when the message has no reactions and there are no reviews', async () => {
    const message = { ts: '1.0' };
    const result = await buildPrMessage('C123', message, pr, reactionConfig, false);
    expect(result.reactions).toEqual([]);
  });
});

describe('buildDigestThreadMap', () => {
  const DIGEST_TS = '100.0';
  // ts 1700000000.000001 → permalink segment p1700000000000001
  const ORIGINAL_TS = '1700000000.000001';
  const ORIGINAL_PERMALINK = 'https://slack.com/archives/C123/p1700000000000001';
  const REPLY_TS = '200.0';

  it('returns an empty map when lastDigestThreadTimestamp is null', async () => {
    const result = await buildDigestThreadMap('C123', null);

    expect(getThreadReplies).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('maps original message ts to digest thread reply ts', async () => {
    getThreadReplies.mockResolvedValue([
      { ts: REPLY_TS, text: `<${ORIGINAL_PERMALINK}|Original message>` },
    ]);

    const result = await buildDigestThreadMap('C123', DIGEST_TS);

    expect(result.get(ORIGINAL_TS)).toBe(REPLY_TS);
  });

  it('skips messages that do not contain an Original message link', async () => {
    getThreadReplies.mockResolvedValue([
      { ts: REPLY_TS, text: 'The following PRs are still open :thread:' },
    ]);

    const result = await buildDigestThreadMap('C123', DIGEST_TS);

    expect(result.size).toBe(0);
  });

  it('builds entries for all matching replies in the thread', async () => {
    const ORIGINAL_TS_2 = '1700000001.000002';
    const PERMALINK_2 = 'https://slack.com/archives/C123/p1700000001000002';
    const REPLY_TS_2 = '201.0';

    getThreadReplies.mockResolvedValue([
      { ts: REPLY_TS, text: `<${ORIGINAL_PERMALINK}|Original message>` },
      { ts: REPLY_TS_2, text: `<${PERMALINK_2}|Original message>` },
    ]);

    const result = await buildDigestThreadMap('C123', DIGEST_TS);

    expect(result.get(ORIGINAL_TS)).toBe(REPLY_TS);
    expect(result.get(ORIGINAL_TS_2)).toBe(REPLY_TS_2);
  });
});
