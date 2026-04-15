import { getInput } from '@actions/core';
import fs from 'fs';
import { getPullRequestStatus, getReviewReactions } from './github.mjs';
import { getPermalink, getMessagePage, getMessageByTimestamp } from './slack.mjs';
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
 * @property {boolean} disableReactionCopying
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
      trackUnresolved: it.trackUnresolved ?? false,
      disableReactionCopying: it.disableReactionCopying ?? false
    }))
    .filter(it => it.channelId && !it.disabled);

  return {
    reactionConfig,
    channelConfig
  };
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

  // Source 1: paginated history
  const allFetchedMessages = [];
  let cursor = undefined;

  let digestFound = false;
  for (let page = 0; page < maxPages; page++) {
    const { messages, nextCursor } = await getMessagePage(channelId, limit, cursor);
    allFetchedMessages.push(...messages);

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

  console.info(`Fetched ${allFetchedMessages.length} messages across pages`);

  const allFetchedTs = new Set(allFetchedMessages.map(m => m.ts));
  const postDigestMessages = lastDigestThreadTimestamp
    ? allFetchedMessages.filter(m => parseFloat(m.ts) > parseFloat(lastDigestThreadTimestamp))
    : [...allFetchedMessages];

  // Source 2: previously-tracked unresolved messages not seen in Source 1
  const source2Messages = [];
  if (trackUnresolved) {
    for (const ts of unresolvedMessageTimestamps) {
      if (allFetchedTs.has(ts)) continue;
      const message = await getMessageByTimestamp(channelId, ts);
      if (message) {
        source2Messages.push(message);
      }
    }
  }

  // Merge Source 1 post-digest + Source 2, deduplicate by ts, sort ascending
  const merged = [...postDigestMessages, ...source2Messages];
  const deduplicated = [...new Map(merged.map(m => [m.ts, m])).values()];
  deduplicated.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  console.info(`Processing ${deduplicated.length} messages`);
  return deduplicated;
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
 */
export function shouldProcess(message, pullRequests, reactionConfig) {
  if (pullRequests.length === 0) {
    console.debug(`SKIPPING: ${message.ts} has no pull requests`);
    return false;
  } else if (pullRequests.length > 1) {
    console.warn(`WARNING: ${message.ts} has multiple pull requests`);
  }

  if (message.bot_id) {
    console.debug(`SKIPPING: ${message.ts} is a bot message`);
    return false;
  }

  if (isResolved(message, reactionConfig)) {
    console.debug(`SKIPPING: ${message.ts} is already resolved`);
    return false;
  }

  console.debug(`PROCESSING: ${message.ts}`);
  if (pullRequests.length > 1) {
    console.warn(`WARNING: ${message.ts} has multiple pull requests`);
  }

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
export async function buildPrMessage(channelId, message, pullRequest, reactionConfig, disableReactionCopying) {
  /** @type {Array<string>} */
  const existingReactions = disableReactionCopying
    ? []
    : (message.reactions ?? [])
      .map(reaction => reaction.name)
      .filter(it => it);
  const reviewReactions = await getReviewReactions(pullRequest, reactionConfig);
  const allReactions = distinct([...existingReactions, ...reviewReactions]);
  const permalink = await getPermalink(channelId, message.ts);

  return {
    permalink,
    reactions: allReactions,
  };
}
