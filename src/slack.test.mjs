import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockReplies = vi.hoisted(() => vi.fn());

vi.mock('@slack/web-api', () => ({
  WebClient: function() {
    return { conversations: { replies: mockReplies } };
  },
}));
vi.mock('@actions/core', () => ({ getInput: vi.fn(() => 'mock-token') }));

import { getThreadReplies, isDigest } from './slack.mjs';

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
  it('returns true for the resolved digest header text', () => {
    const message = { text: 'All PRs are resolved! :tada:' };

    expect(isDigest(message)).toBe(true);
  });

  it('returns true for the open digest header text', () => {
    const message = { text: 'The following PRs are still open :thread:' };

    expect(isDigest(message)).toBe(true);
  });

  it('returns true for a digest header block', () => {
    const message = {
      text: 'fallback',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'The following PRs are still open :thread:' }
        }
      ]
    };

    expect(isDigest(message)).toBe(true);
  });

  it('returns false for non-digest messages', () => {
    const message = { text: 'A regular message', blocks: [] };

    expect(isDigest(message)).toBe(false);
  });
});
