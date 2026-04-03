import { getBooleanInput, setFailed } from "@actions/core";
import { getConfig, shouldProcess, getAggregateStatus, buildPrMessage } from "./workflow.mjs";
import { getMessages, addReaction, postOpenPrs } from "./slack.mjs";
import { extractPullRequests } from "./github.mjs"

export async function run() {
  try {
    const { reactionConfig, channelConfig } = getConfig();
    const skipDigest = getBooleanInput('skip-digest');
    for (let { channelId, limit, disableReactionCopying } of channelConfig) {
      const messagesForChannel = [];
      for (let message of await getMessages(channelId, limit)) {
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

        if (!skipDigest) {
          messagesForChannel.push(
            await buildPrMessage(channelId, message, pullRequests[0], reactionConfig, disableReactionCopying)
          );
        }
      }
      if (!skipDigest) {
        await postOpenPrs(channelId, messagesForChannel);
      }
    }
  } catch (error) {
    console.error(error);
    setFailed(error.message);
  }
}

await run();
