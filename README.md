# PR Channel Slackbot

This GitHub Action checks Slack channels for pull requests that have been posted and ensures they are either merged or closed. It automates the process of monitoring and managing pull requests within your Slack workspace.

## Recommended Practices for Using the PR Channel Slackbot

This action is intended for use with a pull request review workflow that incorporates the following steps:

1. **Create a Dedicated Slack Channel**: Establish a separate Slack channel specifically for pull requests, such as `#pr-reviews` or `#pull-requests`. This dedicated space ensures focused discussions and avoids cluttering general development conversations.

2. **Post pull request Links**: Developers post links to their pull requests needing review in the dedicated pull request channel. This step actively signals that the pull requests are ready for review and invites team members to provide feedback.
    > [!Note]
    > It is recommended that each pull request is posted in its own message.  Messages containing multiple pull requests are supported, but there is no way to indiciate the status of them individually via reactions.

3. **Use Reactions for Review Statuses**: These reactions indicate that a pull request has been reviewed already, so reviewers may want to focus on other pull requests first.
   - **Approval**: Team members can add an "approved" reaction (e.g., ✅) to the corresponding message if they've approved it.
   - **Changes Requested**: Team members can use the "changes requested" reaction (e.g., 🔄) to indicate that modifications are required before the pull request can be approved.

4. **Use Reactions for pull request Closure**: These reactions indicate that a pull request no longer needs a review so that reviewers can focus on other pull requests.
   - **Merge**: Upon merging a pull request, the "merged" reaction (e.g., 🚀) can be added.
   - **Closure**: If a pull request is closed without merging, the "closed" reaction (e.g., ❌).

## How it Works

The PR Channel Slackbot action does the following steps for each configured Slack channel:

1. **Read Chat History**:
   - Scan through the chat history (excluding messages inside threads) to locate messages containing links to pull requests.

2. **Check pull request Status**:
   - For each pull request link found:
     - If the message is already marked with a `closed` or `merged` reaction, it is skipped.
     - Query GitHub for the status of the pull request. If the pull request is merged or closed, the corresponding reaction is added to the message and the action moves on to the next message.
     - If the pull request is still open, the retrieve the review status from GitHub. If changes are requested, the `changesRequested` reaction is added to the message. Otherwise, if there are approvals, the `approved` reaction is added.

3. **Create New Thread**:
   - After processing all relevant messages, the action creates a new thread in the pull request channel.

4. **Add Responses**:
   - The action adds a response within the thread for each message containing a link to an open pull request.

5. **Copy Reactions**:
   - Any reactions present on the original message are copied over to the response within the thread, ensuring continuity and visibility of feedback.

### Handling Messages with Multiple Pull Requests

When a message contains multiple pull request links, the aggregate status of these pull requests is considered to determine whether the message should be marked as `merged`, `closed`, or `approved`. In these cases, the "least common denominator" of the statuses is used:

1. **All Closed-Without-Merge PRs**:
   - If all pull requests are closed (without being merged), the message is treated as "closed."

2. **Mixed Closed Status (Some Closed, Some Merged)**:
   - If all pull requests are closed, and at least some are merged, the message is treated as "merged."

3. **All Approved PRs**:
   - If all pull requests are approved (and none are marked as having changes requested), the message is treated as "approved."

## Usage

To use this GitHub Action in your workflow, follow these steps:

1. **Set Up Slack Integration**: 
    - Obtain a Slack API token from your Slack workspace (see [Slack Token](#slack-token)).

2. **Configure GitHub Token**:
    - Obtain a `github-token` with the necessary permissions (see [GitHub Token](#github-token)).

3. **Create a Configuration File**:
    - Prepare a JSON configuration file with the required settings (see [Configuration File](#configuration-file)).

4. **Create a Workflow**:
    - Add a workflow file (e.g., `.github/workflows/pr_channel_slackbot.yml`) in your repository to run this action with the necessary configuration, including inputs for the Slack API token, GitHub API token, and the path to the configuration file (see [Example Workflow](#example-workflow)).

## Token Permissions

### Slack Token

A valid Slack API bot token is required for this workflow to be able to read and post messages.  This can be a token for an existing internal Slack App, or you can [create a new Slack App](https://api.slack.com/tutorials/tracks/getting-a-token).  All messages will be posted as the app tied to the provided token.  In order to be able to read and post in private channels, the app must be added to those channels in Slack.

In addition, the following scopes must be requested on the bot token:
* `channels:history` (see messages in public channels)
* `groups:history` (see messages in private channels that the app is invited to)
* `chat:write` (post messsages)
* `reactions:write` (add reactions to messages)

### GitHub Token

> [!WARNING]  
> The default `GITHUB_TOKEN` will not work for monitoring channels with pull requests from private repositories. You will need to configure a custom token from an account with read access to all relevant repositories.

The account tied to the `github-token` must have read access to all repositories that you with to manage pull requests for.  If a pull request is posted for a repository that it does not have access to, it will not be able to retrieve its status, limiting functionality.  In these cases, automatic emoji reactions will be disabled, and the workflow will only use the presence of `merged`/`closed` reactions to determine if it should include a pull request in the thread or not.

The following permissions are required for the workflow to be able to check the status of pull requests:
* Fine-grained access tokens: `pull_requests:read`
* Classic access tokens: `repo`

## Example Workflow

The following example workflow 

```yaml
name: PR Channel Slackbot

on:
  workflow_dispatch:
  schedule:
    # At 12:00 and 17:00 (UTC) every weekday
    - cron: '0 12,17 * * 1-5'

jobs:
  pr-channel-slackbot:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: PR Channel Slackbot
        uses: TheSench/pr-channel-slackbot@v1
        with:
          slack-token: ${{ secrets.SLACK_TOKEN }}
          github-token: ${{ secrets.PR_BOT_GITHUB_TOKEN }}
          config-file: '.github/pr_channel_slackbot_config.json'
```

## Configuration File

The configuration file (e.g., `.github/pr_channel_slackbot_config.json`) contains two groups of configurations, one for emojis interpreted by or used by the bot, and one for configuring which channels should be monitored.

Example `pr_channel_slackbot_config.json`:

```json
{
    "reactions": {
        "merged": [
            "merged"
        ],
        "closed": [
            "pr-closed",
            "closed"
        ],
        "changesRequested": [
            "changes-requested"
        ],
        "approved": [
            "approved"
        ]
    },
    "channels": {
        "project-foo-prs": {
            "channelId": "C123456",
            "limit": 100
        },
        "project-bar-prs": {
            "channelId": "C654321"
        },
        "project-baz-prs": {
            "channelId": "C987654",
            "limit": 50,
            "disabled": true
        }
    }
}
```

### Reactions

The `reactions` section contains configuration for each reaction type used by the bot. Each reaction type accepts a list of reaction names that are considered to be part of that type.  If multiple reactions are provided for the same group, all of them will be considered matches when checking existing reactions on messages, but only the first one in the list will be used when the bot adds reactions.

* `merged` - Any messages with a reaction in this group will be considered "resolved" (skipped).  If a pull request is merged in GitHub but not marked in Slack,  the first reaction from this group will be added to the message.
* `merged` - Any messages with a reaction in this group will be considered "resolved" (skipped).  If a pull request is closed (without being merged) in GitHub but not marked in Slack,  the first reaction from this group will be added to the message.
* `changesRequested` - Messages in this group do not impact how the bot processes Slack messages.  If a pull request is not closed, and it has been marked with requested changes, the first reaction from this group will be added to the message.
* `approved` - Messages in this group do not impact how the bot processes Slack messages.  If a pull request is not closed, but has approvals on it (and no changes requested), the first reaction from this group will be added to the message.

### Channels

The `channels` section contains a map of human-readable channel names to channel configurations.  The name of the keys here does not impact processing.  It is recommended that the keys match the name of the assocaited channel for clarity.

Each channel configuration can have the following fields:
1. `channelId` - (required) the ID of the channel.
    > [!NOTE]
    > If you do not know the ID of a channel, you can easily retrieve it from a link to that channel.  Simply right-click on the channel and select `Copy` > `Copy link`.  The last part of the link will be the channel ID.  For example, if your channel's link is `https://mycompany.slack.com/archives/C123456`, then the channel ID is `C123456`.
2. `limit` - (optional - default `50`) this limits how many messages in the channel will be reviewed for pull requests.  Only the last `<limit>` messages will be checked.
    > [!NOTE]
    > It is recommended that you use a channel that is dedicated for pull requests to separate requests for reviews from other development-related conversations.  If your team is consistently reviewing pull requests, a large limit should not be required.
3. `disabled` - (optional - default `false`) if you wish to disable a channel without completely removing it, you can mark it as disabled.

## License

This project is licensed under the [MIT License](LICENSE).