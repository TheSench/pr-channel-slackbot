import { getInput, setFailed } from "@actions/core";
import { getOctokit } from "@actions/github";
import { WebClient } from "@slack/web-api";
import fs from "fs";

/** @typedef {import('@slack/web-api/dist/types/response/ChannelsHistoryResponse').Message} SlackMessage */
/** @typedef {ReturnType<getOctokit>} OctokitClient */
/** @typedef {WebClient} SlackClient */
/**
 * @typedef {Object} PullRequest
 * @property {string} owner
 * @property {string} repo
 * @property {string} pull_number
 */
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
export async function run() {
  try {
    const { reactionConfig, channelConfig } = getConfig();
    for (let { channelId, limit } of channelConfig) {
      const messagesForChannel = [];
      for (let message of getMessages(channelId, limit)) {
        const pullRequests = getPullRequests(message);

        if (!shouldProcess(message, pullRequests, reactionConfig)) {
          continue;
        }

        const status = await getAggregateStatus(pullRequests);
        if (['closed', 'merged'].includes(status)) {
          console.debug(`RESOLVING: ${message.ts} is ${status}`);
          await addReaction(channelId, message.ts, reactionConfig[status][0]);
          continue;
        }

        messagesForChannel.push(
          await buildPrMessage(channelId, message, pullRequests[0], reactionConfig)
        );
      }
      await postOpenPrs(channelId, messagesForChannel);
    }
  } catch (error) {
    setFailed(error.message);
  }
}

/** @type {SlackClient} */
let _slackClient;
function slackClient() {
  if (!_slackClient) {
    _slackClient = new WebClient(getInput("slack-token"));
  }
  return _slackClient;
}

/** @type {OctokitClient} */
let _octokitClient;
function octokitClient() {
  if (!_octokitClient) {
    _octokitClient = getOctokit(getInput("github-token"));
  }
  return _octokitClient;
}

async function getChannels() {
  const slackChannelConfigFile = getInput('slack-channel-config', { required: true });

  const jsonData = (slackChannelConfigFile && fs.existsSync(slackChannelConfigFile))
    ? JSON.parse(fs.readFileSync(slackChannelConfigFile, 'utf-8'))
    : {};

  return Object.keys(jsonData)
    .map(it => ({
      channelId: it.channelId,
      limit: it.limit ?? 50
    }))
    .filter(it => it.channelId);
}

/**
 * 
 * @param {SlackMessage} message 
 * @returns {PullRequest[]}
 */
function getPullRequests(message) {
  const matches = [...message.text?.matchAll(/https:\/\/github.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)\/pull\/(?<pull_number>\d+)/g)];

  return matches.map(it => ({
    owner: it.groups.owner,
    repo: it.groups.repo,
    pull_number: it.groups.pull_number,
  }));
}

/**
 * @param {SlackMessage} message
 * @param {Array<PullRequest>} pullRequests
 * @param {ReactionConfig} reactionConfig
 */
function shouldProcess(message, pullRequests, reactionConfig) {
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

function isResolved(message, reactionConfig) {
  const resolvedStatuses = [reactionConfig.approved, reactionConfig.merged, reactionConfig.closed];

  return message.reactions?.some(reaction =>
    reactionConfig.merged.includes(reaction.name)) ||
    resolvedStatuses.some(status => message.text?.includes(status));
}

/**
 * Get the last {limit} messages from {channelId} in ascending order.
 * 
 * @param {string} channelId
 * @param {number} limit
 */
async function getMessages(channelId, limit) {
  const history = await slackClient().conversations.history({
    channel: channelId,
    limit
  });
  return (history.messages ?? [])
    .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
}

function getConfig() {
  const configFile = getInput('config-file', { required: true });

  const jsonData = (configFile && fs.existsSync(configFile))
    ? JSON.parse(fs.readFileSync(configFile, 'utf-8'))
    : {};

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
  const channelConfig = Object.keys(rawChannelConfig)
    .map(it => ({
      channelId: it.channelId,
      limit: it.limit ?? 50
    }))
    .filter(it => it.channelId);

  return {
    reactionConfig,
    channelConfig
  };
}

/** @typedef {'open' | 'closed' | 'merged'} PullRequestStatus */
async function getAggregateStatus(pullRequests) {
  /** @type {Array<PullRequestStatus>} */
  const statuses = await Promise.all(pullRequests.map(pr => getStatus(pr)))
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
 * @template T
 * @param {Array<T>} array 
 * @returns {Array<T>}
 */
function distinct(array) {
  return [...new Set(array)];
}

/** @type {Map<string, PullRequestStatus>} */
const _pullRequestCache = new Map();
/**
 * 
 * @param {PullRequest} pullRequest 
 * @returns {Promise<PullRequestStatus>}
 */
async function getStatus(pullRequest) {
  const cacheKey = `${pullRequest.owner}/${pullRequest.repo}/${pullRequest.pull_number}`;
  if (_pullRequestCache.has(cacheKey)) {
    return _pullRequestCache.get(cacheKey);
  }

  return octokitClient().rest.pulls.get(pullRequest)
    .then(({ data }) => {
      switch (data.state) {
        case 'closed':
          return (data.merged) ? 'merged' : 'closed';
        default:
          return 'open';
      }
    })
    .then(status => {
      _pullRequestCache.set(cacheKey, status);
      return status;
    })
    .catch(error => {
      console.error(`Failed to get status for ${cacheKey}: ${error}`);
      return 'open';
    });
}

function addReaction(channelId, messageTs, reaction) {
  return slackClient().reactions.add({
    name: reaction,
    channel: channelId,
    timestamp: messageTs
  });
}

function getPermalink(channelId, messageTs) {
  return slackClient().chat.getPermalink({
    channel: channelId,
    message_ts: messageTs
  }).then(response => response.permalink);
}

/**
 * 
 * @param {SlackMessage} message
 * @param {PullRequest} pullRequest 
 * @returns {Promise<PrMessage>}
 */
async function buildPrMessage(channelId, message, pullRequest, reactionConfig) {
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

/** @type {Map<string, Array<string>} */
const _reviewReactionCache = new Map();
/**
 * 
 * @param {PullRequest} pullRequest
 * @param {ReactionConfig} reactionConfig
 * @returns {Promise<Array<string>>}
 */
async function getReviewReactions(pullRequest, reactionConfig) {
  const cacheKey = `${pullRequest.owner}/${pullRequest.repo}/${pullRequest.pull_number}`;
  if (_reviewReactionCache.has(cacheKey)) {
    return _reviewReactionCache.get(cacheKey);
  }

  return await octokitClient().rest.pulls.listReviews(pullRequest)
    .then(reviews => reviews.data.map(({ data }) => data.map(review => review.state)))
    .then(states => {

      const reviewReactions = [];
      if (states.includes('CHANGES_REQUESTED')) {
        reviewReactions.push(reactionConfig.changesRequested[0]);
      }
      if (states.includes('APPROVED')) {
        reviewReactions.push(reactionConfig.approved[0]);
      }
      return reviewReactions;
    })
    .then(reviewReactions => {
      _reviewReactionCache.set(cacheKey, reviewReactions);
      return reviewReactions;
    })
    .catch(_ => []);
}

async function postOpenPrs(channelId, messages) {
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

await run();