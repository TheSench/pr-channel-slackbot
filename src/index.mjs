import { getBooleanInput, getInput, setFailed } from "@actions/core";
import { getConfig, shouldProcess, getAggregateStatus, buildPrMessage, collectMessages } from "./workflow.mjs";
import { addReaction, postOpenPrs } from "./slack.mjs";
import { extractPullRequests } from "./github.mjs";
import { loadState, saveState, getChannelState } from "./state.mjs";

export async function run() {
  try {
    const { reactionConfig, channelConfig } = getConfig();
    const skipDigest = getBooleanInput('skip-digest');
    const stateFile = getInput('state-file');

    const state = loadState(stateFile);

    for (let { channelId, limit, maxPages, trackUnresolved, disableReactionCopying } of channelConfig) {
      const channelState = getChannelState(state, channelId);
      const messages = await collectMessages(channelId, channelState, limit, maxPages, trackUnresolved);

      const messagesForDigest = [];
      const unresolvedTimestamps = [];

      for (let message of messages) {
        const pullRequests = extractPullRequests(message.text);

        if (!shouldProcess(message, pullRequests, reactionConfig)) {
          continue;
        }

        const status = await getAggregateStatus(pullRequests);
        if (['closed', 'merged'].includes(status)) {
          console.debug(`RESOLVING: ${message.ts} is ${status}`);
          await addReaction(channelId, message.ts, reactionConfig[status][0]);
          continue;
        }

        unresolvedTimestamps.push(message.ts);

        if (!skipDigest) {
          messagesForDigest.push(
            await buildPrMessage(channelId, message, pullRequests[0], reactionConfig, disableReactionCopying)
          );
        }
      }

      const digestThreadTimestamp = (skipDigest
        ? channelState.lastDigestThreadTimestamp
        : await postOpenPrs(channelId, messagesForDigest));

      state[channelId] = {
        unresolvedMessageTimestamps: unresolvedTimestamps,
        lastDigestThreadTimestamp: digestThreadTimestamp
      };
    }

    saveState(stateFile, state);
  } catch (error) {
    console.error(error);
    setFailed(error.message);
  }
}

await run();
