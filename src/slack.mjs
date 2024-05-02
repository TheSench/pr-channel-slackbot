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
 * Get the last {limit} messages from {channelId} in ascending order.
 * 
 * @param {string} channelId
 * @param {number} limit
 */
export async function getMessages(channelId, limit) {
  const history = await slackClient().conversations.history({
    channel: channelId,
    limit
  });
  return (history.messages ?? [])
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
}

export function addReaction(channelId, messageTs, reaction) {
  return slackClient().reactions.add({
    name: reaction,
    channel: channelId,
    timestamp: messageTs
  });
}

export function getPermalink(channelId, messageTs) {
  return slackClient().chat.getPermalink({
    channel: channelId,
    message_ts: messageTs
  }).then(response => response.permalink);
}

export async function postOpenPrs(channelId, messages) {
  const headerResponse = await postThreadHeader(channelId, messages.length);
  if (messages.length === 0) return;

  for (let message of messages) {
    const prMessage = await postPrMessage(channelId, headerResponse.ts, message);
    for (let reaction of message.reactions) {
      await addReaction(channelId, prMessage.ts, reaction);
    }
  }
}

async function postThreadHeader(channelId, prCount) {
  const header = (prCount === 0
    ? 'All PRs are resolved! :tada:'
    : 'The following PRs are still open :thread:');
  return slackClient().chat.postMessage({
    channel: channelId,
    thread_ts: message.ts,
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
