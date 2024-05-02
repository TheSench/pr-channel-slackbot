import { getInput } from "@actions/core";
import { getOctokit } from "@actions/github";

/** @typedef {import('./workflow.mjs').ReactionConfig} ReactionConfig */

/** @typedef {ReturnType<getOctokit>} OctokitClient */
/**
 * @typedef {Object} PullRequest
 * @property {string} owner
 * @property {string} repo
 * @property {string} pull_number
 */
/** @typedef {'open' | 'closed' | 'merged'} PullRequestStatus */

/** @type {OctokitClient} */
let _octokitClient;
function octokitClient() {
  if (!_octokitClient) {
    _octokitClient = getOctokit(getInput("github-token"));
  }
  return _octokitClient;
}

/**
 * @param {string?} text
 * @returns {PullRequest[]}
 */
export function extractPullRequests(text) {
  const matches = [...text?.matchAll(/https:\/\/github.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+)\/pull\/(?<pull_number>\d+)/g)];

  return matches.map(it => ({
    owner: it.groups.owner,
    repo: it.groups.repo,
    pull_number: it.groups.pull_number,
  }));
}

/** @type {Map<string, PullRequestStatus>} */
const _pullRequestCache = new Map();
/**
 * @param {PullRequest} pullRequest 
 * @returns {Promise<PullRequestStatus>}
 */
export async function getPullRequestStatus(pullRequest) {
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

/** @type {Map<string, Array<string>} */
const _reviewReactionCache = new Map();
/**
 * 
 * @param {PullRequest} pullRequest
 * @param {ReactionConfig} reactionConfig
 * @returns {Promise<Array<string>>}
 */
export async function getReviewReactions(pullRequest, reactionConfig) {
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
