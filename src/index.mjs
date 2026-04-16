import { getBooleanInput, getInput, setFailed } from "@actions/core";
import { getConfig, shouldProcess, getAggregateStatus, buildPrMessage, collectMessages, buildDigestThreadMap } from "./workflow.mjs";
import { addReaction, postOpenPrs, markThreadSuperseded } from "./slack.mjs";
import { extractPullRequests } from "./github.mjs";
import { loadState, saveState, getChannelState } from "./state.mjs";

export async function run() {
  try {
    const { reactionConfig, channelConfig } = getConfig();
    const skipDigest = getBooleanInput('skip-digest');
    const stateFile = getInput('state-file');

    const state = loadState(stateFile);

    for (let { channelId, limit, maxPages, trackUnresolved, enableReactionCopying, allowBotMessages } of channelConfig) {
      const channelState = getChannelState(state, channelId);
      const messages = await collectMessages(channelId, channelState, limit, maxPages, trackUnresolved);
      const digestThreadMap = await buildDigestThreadMap(channelId, channelState.lastDigestThreadTimestamp);

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

      let digestThreadTimestamp;
      if (skipDigest) {
        digestThreadTimestamp = channelState.lastDigestThreadTimestamp;
      } else {
        digestThreadTimestamp = await postOpenPrs(channelId, messagesForDigest);
        if (channelState.lastDigestThreadTimestamp) {
          await markThreadSuperseded(channelId, channelState.lastDigestThreadTimestamp, digestThreadTimestamp);
        }
      }

      if (trackUnresolved) {
        state[channelId] = {
          unresolvedMessageTimestamps: unresolvedTimestamps,
          lastDigestThreadTimestamp: digestThreadTimestamp
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
