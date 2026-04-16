import { getInput } from '@actions/core';
import fs from 'fs';
import { getPullRequestStatus, getReviewReactions } from './github.mjs';
import { getPermalink, getMessagePage, getMessageByTimestamp, getThreadReplies } from './slack.mjs';
import { distinct } from './utils.mjs';

/** @typedef {import('./slack.mjs').SlackMessage} SlackMessage */
/** @typedef {import('./github.mjs').PullRequest} PullRequest */
/** @typedef {import('./github.mjs').PullRequestStatus} PullRequestStatus */

/**
 * @typedef {Object} ReactionConfig
 * @property {Array<string>} approved
 * @property {Array<string>} merged
 * @property {Array<string>} closed
 * @property {Array<string>} changesRequested
 */
/**
 * @typedef {Object} ChannelConfig
 * @property {string} channelId
 * @property {number} limit
 * @property {number} maxPages
 * @property {boolean} trackUnresolved
 * @property {boolean} enableReactionCopying
 * @property {boolean} allowBotMessages
 */
/**
 * @typedef {Object} PrMessage
 * @property {string} permalink
 * @property {Array<string>} reactions
 */

export function getConfig() {
  const configFile = getInput('config-file', { required: true });

  const jsonData = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

  const rawReactionConfig = jsonData.reactions ?? {};
  /** @type {ReactionConfig} */
  const reactionConfig = {
    approved: rawReactionConfig.approved ?? ['approved'],
    merged: rawReactionConfig.merged ?? ['merged'],
    closed: rawReactionConfig.closed ?? ['closed'],
    changesRequested: rawReactionConfig.changesRequested ?? ['changesRequested']
  };

  const rawChannelConfig = jsonData.channels ?? {};
  /** @type {Array<ChannelConfig>} */
  const channelConfig = Object.values(rawChannelConfig)
    .map(it => ({
      ...it,
      limit: it.limit ?? 50,
      maxPages: it.maxPages ?? 1,
      trackUnresolved: it.trackUnresolved ?? true,
      enableReactionCopying: it.enableReactionCopying ?? false,
      allowBotMessages: it.allowBotMessages ?? true
    }))
    .filter(it => it.channelId && !it.disabled);

  return {
    reactionConfig,
    channelConfig
  };
}

/**
 * Paginate channel history back to the last digest thread (or maxPages pages).
 * Returns all fetched messages and the subset posted after the digest anchor.
 *
 * @param {string} channelId
 * @param {number} limit Messages per page
 * @param {number} maxPages Maximum pages to fetch
 * @param {string|null} lastDigestThreadTimestamp Stop paginating when this ts is found
 * @returns {Promise<{allMessages: SlackMessage[], postDigestMessages: SlackMessage[]}>}
 */
async function fetchPagedMessages(channelId, limit, maxPages, lastDigestThreadTimestamp) {
  const allMessages = [];
  let cursor = undefined;
  let digestFound = false;

  for (let page = 0; page < maxPages; page++) {
    const { messages, nextCursor } = await getMessagePage(channelId, limit, cursor);
    allMessages.push(...messages);

    if (lastDigestThreadTimestamp && messages.some(m => m.ts === lastDigestThreadTimestamp)) {
      digestFound = true;
      break;
    }

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  if (lastDigestThreadTimestamp && !digestFound) {
    console.warn(`Reached maxPages (${maxPages}) without finding last digest anchor for channel ${channelId}. Some messages may be missed. Consider increasing maxPages.`);
  }

  console.info(`Fetched ${allMessages.length} messages across pages`);

  const postDigestMessages = lastDigestThreadTimestamp
    ? allMessages.filter(m => parseFloat(m.ts) > parseFloat(lastDigestThreadTimestamp))
    : [...allMessages];

  return { allMessages, postDigestMessages };
}

/**
 * Fetch previously-tracked unresolved messages that are not already in the fetched set.
 * Skips any ts present in alreadyFetchedTs (message already retrieved via pagination).
 * Skips any ts whose message has been deleted.
 *
 * @param {string} channelId
 * @param {Array<string>} trackedTimestamps ts values from prior run state
 * @param {Set<string>} alreadyFetchedTs ts values already retrieved in Source 1
 * @returns {Promise<SlackMessage[]>}
 */
async function fetchTrackedMessages(channelId, trackedTimestamps, alreadyFetchedTs) {
  const messages = [];
  for (const ts of trackedTimestamps) {
    if (alreadyFetchedTs.has(ts)) continue;
    const message = await getMessageByTimestamp(channelId, ts);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

/**
 * Build the unified message set for a channel from two sources:
 * 1. Paginated Slack history back to the last digest thread (or maxPages pages).
 * 2. Individually-fetched messages for previously-tracked unresolved timestamps
 *    not already present in the paginated results (only when trackUnresolved is true).
 *
 * @param {string} channelId
 * @param {import('./state.mjs').ChannelState} channelState
 * @param {number} limit Messages per page
 * @param {number} maxPages Maximum pages to fetch
 * @param {boolean} trackUnresolved Whether to fetch individually-tracked messages
 * @returns {Promise<SlackMessage[]>} Deduplicated messages sorted ascending by ts
 */
export async function collectMessages(channelId, channelState, limit, maxPages, trackUnresolved) {
  const { lastDigestThreadTimestamp, unresolvedMessageTimestamps } = channelState;

  const { allMessages, postDigestMessages } = await fetchPagedMessages(
    channelId, limit, maxPages, trackUnresolved ? lastDigestThreadTimestamp : null
  );

  const trackedMessages = trackUnresolved
    ? await fetchTrackedMessages(channelId, unresolvedMessageTimestamps, new Set(allMessages.map(m => m.ts)))
    : [];

  const result = [...postDigestMessages, ...trackedMessages]
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  console.info(`Processing ${result.length} messages`);
  return result;
}

/**
 * Convert a Slack permalink URL to a message timestamp.
 * Permalink format: https://workspace.slack.com/archives/CHANNEL/pTIMESTAMP
 * where TIMESTAMP is the ts with the decimal removed (10 sec digits + 6 microsecond digits).
 * @param {string} url
 * @returns {string|null}
 */
function parseTsFromPermalink(url) {
  const match = url.match(/\/p(\d{16})/);
  if (!match) return null;
  const digits = match[1];
  return `${digits.slice(0, 10)}.${digits.slice(10)}`;
}

/**
 * Build a map from original message ts to digest thread reply ts by fetching
 * the thread under lastDigestThreadTimestamp and parsing each bot reply's
 * "Original message" link.
 *
 * @param {string} channelId
 * @param {string|null} lastDigestThreadTimestamp
 * @returns {Promise<Map<string, string>>} Map from originalTs to digestThreadReplyTs
 */
export async function buildDigestThreadMap(channelId, lastDigestThreadTimestamp) {
  if (!lastDigestThreadTimestamp) return new Map();

  const threadMessages = await getThreadReplies(channelId, lastDigestThreadTimestamp);
  const map = new Map();

  for (const msg of threadMessages) {
    const match = msg.text?.match(/<([^|>]+)\|Original message>/);
    if (!match) continue;
    const originalTs = parseTsFromPermalink(match[1]);
    if (originalTs) {
      map.set(originalTs, msg.ts);
    }
  }

  return map;
}

export async function getAggregateStatus(pullRequests) {
  /** @type {Array<PullRequestStatus>} */
  const statuses = await Promise.all(pullRequests.map(pr => getPullRequestStatus(pr)))
  const distinctStatuses = distinct(statuses);

  if (distinctStatuses.includes('open')) {
    return 'open';
  } else if (distinctStatuses.includes('merged')) {
    return 'merged';
  } else {
    return 'closed';
  }
}

/**
 * @param {SlackMessage} message
 * @param {Array<PullRequest>} pullRequests
 * @param {ReactionConfig} reactionConfig
 * @param {boolean} allowBotMessages
 */
export function shouldProcess(message, pullRequests, reactionConfig, allowBotMessages = false) {
  if (pullRequests.length === 0) {
    console.debug(`SKIPPING: ${message.ts} has no pull requests`);
    return false;
  } else if (pullRequests.length > 1) {
    console.warn(`WARNING: ${message.ts} has multiple pull requests`);
  }

  if (!allowBotMessages && message.bot_id) {
    console.debug(`SKIPPING: ${message.ts} is a bot message`);
    return false;
  }

  if (isResolved(message, reactionConfig)) {
    console.debug(`SKIPPING: ${message.ts} is already resolved`);
    return false;
  }

  console.debug(`PROCESSING: ${message.ts}`);
  return true;
}

/**
 * @param {SlackMessage} message
 * @param {ReactionConfig} reactionConfig
 */
function isResolved(message, reactionConfig) {
  const resolvedStatuses = [...reactionConfig.merged, ...reactionConfig.closed];

  return message.reactions?.some(reaction => resolvedStatuses.includes(reaction.name));
}

/**
 * @param {string} channelId
 * @param {SlackMessage} message
 * @param {PullRequest} pullRequest
 * @param {ReactionConfig} reactionConfig
 * @param {ChannelConfig} channelConfig
 * @returns {Promise<PrMessage>}
 */
export async function buildPrMessage(channelId, message, pullRequest, reactionConfig, enableReactionCopying) {
  /** @type {Array<string>} */
  const existingReactions = enableReactionCopying
    ? (message.reactions ?? [])
      .map(reaction => reaction.name)
      .filter(it => it)
    : [];
  const reviewReactions = await getReviewReactions(pullRequest, reactionConfig);
  const allReactions = distinct([...existingReactions, ...reviewReactions]);
  const permalink = await getPermalink(channelId, message.ts);

  return {
    permalink,
    reactions: allReactions,
  };
}
