import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockReplies = vi.hoisted(() => vi.fn());
const mockAuthTest = vi.hoisted(() => vi.fn());

vi.mock('@slack/web-api', () => ({
  WebClient: function() {
    return {
      auth: { test: mockAuthTest },
      conversations: { replies: mockReplies }
    };
  },
}));
vi.mock('@actions/core', () => ({ getInput: vi.fn(() => 'mock-token') }));

import { getBotIdentity, getThreadReplies, isDigest, isOwnMessage } from './slack.mjs';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getThreadReplies', () => {
  it('returns all messages from a single-page thread', async () => {
    mockReplies.mockResolvedValueOnce({
      messages: [{ ts: '1.0' }, { ts: '2.0' }],
      response_metadata: { next_cursor: '' },
    });

    const result = await getThreadReplies('C123', '50.0');

    expect(result).toEqual([{ ts: '1.0' }, { ts: '2.0' }]);
  });

  it('fetches all pages when the thread spans multiple pages', async () => {
    mockReplies
      .mockResolvedValueOnce({
        messages: [{ ts: '1.0' }, { ts: '2.0' }],
        response_metadata: { next_cursor: 'cursor1' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: '3.0' }, { ts: '4.0' }],
        response_metadata: { next_cursor: '' },
      });

    const result = await getThreadReplies('C123', '50.0');

    expect(result).toEqual([{ ts: '1.0' }, { ts: '2.0' }, { ts: '3.0' }, { ts: '4.0' }]);
    expect(mockReplies).toHaveBeenCalledTimes(2);
  });

  it('passes the cursor on subsequent page requests', async () => {
    mockReplies
      .mockResolvedValueOnce({
        messages: [{ ts: '1.0' }],
        response_metadata: { next_cursor: 'cursor1' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: '2.0' }],
        response_metadata: {},
      });

    await getThreadReplies('C123', '50.0');

    expect(mockReplies).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cursor1' }));
  });

  it('returns an empty array when messages is undefined', async () => {
    mockReplies.mockResolvedValueOnce({
      messages: undefined,
      response_metadata: {},
    });

    const result = await getThreadReplies('C123', '50.0');

    expect(result).toEqual([]);
  });
});

describe('isDigest', () => {
  const identity = { userId: 'U123', botId: 'B123' };

  it('returns true for the resolved digest header text from the bot', () => {
    const message = { text: 'All PRs are resolved! :tada:', bot_id: 'B123' };

    expect(isDigest(message, identity)).toBe(true);
  });

  it('returns true for the open digest header text from the bot', () => {
    const message = { text: 'The following PRs are still open :thread:', bot_id: 'B123' };

    expect(isDigest(message, identity)).toBe(true);
  });

  it('returns true for a digest header block from the bot', () => {
    const message = {
      text: 'fallback',
      bot_id: 'B123',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'The following PRs are still open :thread:' }
        }
      ]
    };

    expect(isDigest(message, identity)).toBe(true);
  });

  it('returns false for non-digest messages', () => {
    const message = { text: 'A regular message', blocks: [], bot_id: 'B123' };

    expect(isDigest(message, identity)).toBe(false);
  });

  it('returns false for digest text from another user', () => {
    const message = { text: 'All PRs are resolved! :tada:', user: 'U999' };

    expect(isDigest(message, identity)).toBe(false);
  });
});

describe('getBotIdentity', () => {
  it('returns the authenticated user and bot ids', async () => {
    mockAuthTest.mockResolvedValueOnce({ user_id: 'U123', bot_id: 'B123' });

    const identity = await getBotIdentity();

    expect(identity).toEqual({ userId: 'U123', botId: 'B123' });
    expect(mockAuthTest).toHaveBeenCalledTimes(1);
  });
});

describe('isOwnMessage', () => {
  const identity = { userId: 'U123', botId: 'B123' };

  it('returns true when the message bot_id matches the bot identity', () => {
    const message = { bot_id: 'B123' };

    expect(isOwnMessage(message, identity)).toBe(true);
  });

  it('returns true when the message user matches the user identity', () => {
    const message = { user: 'U123' };

    expect(isOwnMessage(message, identity)).toBe(true);
  });

  it('returns false for messages from other users', () => {
    const message = { bot_id: 'B999', user: 'U999' };

    expect(isOwnMessage(message, identity)).toBe(false);
  });

  it('works when the identity has no botId', () => {
    const message = { bot_id: 'B123', user: 'U123' };
    const identityWithoutBot = { userId: 'U123' };

    expect(isOwnMessage(message, identityWithoutBot)).toBe(true);
  });
});
