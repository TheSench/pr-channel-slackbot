import { getInput } from "@actions/core";
import { WebClient } from "@slack/web-api";

/** @typedef {WebClient} SlackClient */
/** @typedef {import('@slack/web-api/dist/types/response/ChannelsHistoryResponse').Message} SlackMessage */

/** @type {SlackClient} */
let _slackClient;
function slackClient() {
  if (!_slackClient) {
    _slackClient = new WebClient(getInput("slack-token"));
  }
  return _slackClient;
}

/**
 * Fetch a single page of messages from {channelId}.
 * @param {string} channelId
 * @param {number} limit
 * @param {string} [cursor]
 * @returns {Promise<{messages: SlackMessage[], nextCursor: string|null}>}
 */
export async function getMessagePage(channelId, limit, cursor = undefined) {
  const response = await slackClient().conversations.history({
    channel: channelId,
    limit,
    cursor
  });
  return {
    messages: response.messages ?? [],
    nextCursor: response.response_metadata?.next_cursor || null
  };
}

/**
 * Fetch a single message by its timestamp.
 * Returns null if the message does not exist (deleted).
 * @param {string} channelId
 * @param {string} ts
 * @returns {Promise<SlackMessage|null>}
 */
export async function getMessageByTimestamp(channelId, ts) {
  const response = await slackClient().conversations.history({
    channel: channelId,
    oldest: ts,
    latest: ts,
    inclusive: true,
    limit: 1
  });
  return response.messages?.[0] ?? null;
}

export function addReaction(channelId, messageTs, reaction) {
  return slackClient().reactions.add({
    name: reaction,
    channel: channelId,
    timestamp: messageTs
  });
}

/**
 * Fetch all reply messages in a thread, handling Slack pagination.
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {Promise<SlackMessage[]>}
 */
export async function getThreadReplies(channelId, threadTs) {
  /** @type {SlackMessage[]} */
  const messages = [];
  let cursor = undefined;

  while (true) {
    const response = await slackClient().conversations.replies({
      channel: channelId,
      ts: threadTs,
      cursor
    });

    messages.push(...(response.messages ?? []));

    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  return messages;
}

const DIGEST_HEADER_RESOLVED = 'All PRs are resolved! :tada:';
const DIGEST_HEADER_OPEN = 'The following PRs are still open :thread:';

const DIGEST_HEADER_TEXTS = [
  DIGEST_HEADER_RESOLVED,
  DIGEST_HEADER_OPEN
];

export function getPermalink(channelId, messageTs) {
  return slackClient().chat.getPermalink({
    channel: channelId,
    message_ts: messageTs
  }).then(response => response.permalink);
}

export function isDigest(message, identity) {
  const text = message.text;
  const headerBlockText = message.blocks?.find(block => block.type === 'header')?.text?.text;

  return isOwnMessage(message, identity) && (
    DIGEST_HEADER_TEXTS.includes(text) || DIGEST_HEADER_TEXTS.includes(headerBlockText)
  );
}

export async function getBotIdentity() {
  const response = await slackClient().auth.test();
  return {
    userId: response.user_id,
    botId: response.bot_id
  };
}

export function isOwnMessage(message, identity) {
  return (identity.botId && message.bot_id === identity.botId) || message.user === identity.userId;
}

export async function postOpenPrs(channelId, messages) {
  const headerResponse = await postThreadHeader(channelId, messages.length);
  if (messages.length === 0) return headerResponse.ts;

  for (let message of messages) {
    const prMessage = await postPrMessage(channelId, headerResponse.ts, message);
    for (let reaction of message.reactions) {
      await addReaction(channelId, prMessage.ts, reaction);
    }
  }
  return headerResponse.ts;
}

async function postThreadHeader(channelId, prCount) {
  const header = (prCount === 0
    ? DIGEST_HEADER_RESOLVED
    : DIGEST_HEADER_OPEN);
  return slackClient().chat.postMessage({
    channel: channelId,
    text: header,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: header,
          emoji: true
        }
      }
    ]
  });
}

async function postPrMessage(channelId, threadId, message) {
  return slackClient().chat.postMessage({
    channel: channelId,
    thread_ts: threadId,
    text: `<${message.permalink}|Original message>`,
  });
}

export async function markThreadSuperseded(channelId, oldThreadTs, newThreadTs) {
  const permalink = await getPermalink(channelId, newThreadTs);
  return slackClient().chat.postMessage({
    channel: channelId,
    thread_ts: oldThreadTs,
    text: `A new digest has been posted. <${permalink}|View it here>.`
  });
}
