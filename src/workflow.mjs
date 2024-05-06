import { getInput } from '@actions/core';
import fs from 'fs';
import { getPullRequestStatus, getReviewReactions } from './github.mjs';
import { getPermalink } from './slack.mjs';
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
      limit: it.limit ?? 50
    }))
    .filter(it => it.channelId && !it.disabled);

  return {
    reactionConfig,
    channelConfig
  };
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
 * @returns {Promise<PrMessage>}
 */
export async function buildPrMessage(channelId, message, pullRequest, reactionConfig) {
  /** @type {Array<string>} */
  const existingReactions = (message.reactions ?? [])
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
