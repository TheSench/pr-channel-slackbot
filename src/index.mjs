import { getBooleanInput, getInput, setFailed } from "@actions/core";
import { getConfig, shouldProcess, getAggregateStatus, buildPrMessage, collectMessages, buildDigestThreadMap } from "./workflow.mjs";
import { addReaction, postOpenPrs, markThreadSuperseded, isDigest, getBotIdentity } from "./slack.mjs";
import { extractPullRequests } from "./github.mjs";
import { loadState, saveState, getChannelState } from "./state.mjs";

export function isNewer(messageTs, digestThreadTimestamp) {
  if (!digestThreadTimestamp) {
    return true;
  }

  const currentTs = Number(messageTs);
  const previousTs = Number(digestThreadTimestamp);

  return Number.isFinite(currentTs) && Number.isFinite(previousTs) && currentTs > previousTs;
}

export function getLatestDigestThreadTimestamp(channelState, botIdentity, messages) {
  let digestThreadTimestamp = channelState.lastDigestThreadTimestamp;
  for (let message of messages) {
    if (isDigest(message, botIdentity) && isNewer(message.ts, digestThreadTimestamp)) {
      digestThreadTimestamp = message.ts;
    }
  }
  return digestThreadTimestamp;
}

export async function run() {
  try {
    const { reactionConfig, channelConfig } = getConfig();
    const skipDigest = getBooleanInput('skip-digest');
    const stateFile = getInput('state-file');

    const state = loadState(stateFile);
    const botIdentity = await getBotIdentity();

    for (let { channelId, limit, maxPages, trackUnresolved, enableReactionCopying, allowBotMessages } of channelConfig) {
      const channelState = getChannelState(state, channelId);
      const messages = await collectMessages(channelId, channelState, limit, maxPages, trackUnresolved);
      let lastDigestThreadTimestamp = getLatestDigestThreadTimestamp(channelState, botIdentity, messages);
      const digestThreadMap = await buildDigestThreadMap(channelId, lastDigestThreadTimestamp);

      const messagesForDigest = [];
      const unresolvedTimestamps = [];

      for (let message of messages) {
        const pullRequests = extractPullRequests(message.text);

        if (!shouldProcess(message, pullRequests, reactionConfig, allowBotMessages)) {
          continue;
        }

        const status = await getAggregateStatus(pullRequests);
        if (['closed', 'merged'].includes(status)) {
          console.debug(`RESOLVING: ${message.ts} is ${status}`);
          const reaction = reactionConfig[status][0];
          await addReaction(channelId, message.ts, reaction);
          const digestMessageTs = digestThreadMap.get(message.ts);
          if (digestMessageTs) {
            await addReaction(channelId, digestMessageTs, reaction);
          }
          continue;
        }

        unresolvedTimestamps.push(message.ts);

        if (!skipDigest) {
          messagesForDigest.push(
            await buildPrMessage(channelId, message, pullRequests[0], reactionConfig, enableReactionCopying)
          );
        }
      }

      if (!skipDigest) {
        lastDigestThreadTimestamp = await postOpenPrs(channelId, messagesForDigest);
        if (channelState.lastDigestThreadTimestamp) {
          await markThreadSuperseded(channelId, channelState.lastDigestThreadTimestamp, lastDigestThreadTimestamp);
        }
      }

      if (trackUnresolved) {
        state[channelId] = {
          unresolvedMessageTimestamps: unresolvedTimestamps,
          lastDigestThreadTimestamp
        };
      }
    }

    if (channelConfig.some(c => c.trackUnresolved)) {
      saveState(stateFile, state);
    }
  } catch (error) {
    console.error(error);
    setFailed(error.message);
  }
}

await run();
