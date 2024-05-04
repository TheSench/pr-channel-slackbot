import { setFailed } from "@actions/core";
import { getConfig, shouldProcess, getAggregateStatus, buildPrMessage } from "./workflow.mjs";
import { getMessages, addReaction, postOpenPrs } from "./slack.mjs";
import { extractPullRequests } from "./github.mjs"

export async function run() {
  try {
    const { reactionConfig, channelConfig } = getConfig();
    for (let { channelId, limit } of channelConfig) {
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

        messagesForChannel.push(
          await buildPrMessage(channelId, message, pullRequests[0], reactionConfig)
        );
      }
      await postOpenPrs(channelId, messagesForChannel);
    }
  } catch (error) {
    console.error(error);
    setFailed(error.message);
  }
}

await run();
