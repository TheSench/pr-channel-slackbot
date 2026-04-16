# README Redesign — Design Spec

**Date:** 2026-04-16  
**Status:** Approved

## Goal

Rewrite the README to be comprehensive yet simple, so that an external GitHub user who has never seen the project can quickly understand what it does and get it running.

## Target Audience

External GitHub users discovering the repo for the first time. They need both the conceptual model (what is this, how do teams use it) and a fast path to getting it working.

## Approved Structure

### 1. Header + Intro
- One-sentence description of what the action does
- Example screenshot (move from mid-page to here, immediately below intro)
- Table of contents for navigation

### 2. Recommended Practices
Keep near the top — this sets the mental model for the team workflow the action is designed around. Minor cleanup only:
- Fix typo: `indiciate` → `indicate`
- Normalize capitalization of "Pull Request"
- Light prose tightening (no content changes)

### 3. Quick Start *(new section)*
A self-contained path to get running in ~5 minutes. Content:

1. **Prerequisites checklist**
   - Slack bot token with required scopes: `channels:history`, `groups:history`, `chat:write`, `reactions:write` (link to Slack's getting-a-token guide)
   - GitHub token with `pull_requests:read` (fine-grained) or `repo` (classic), covering the repos whose PRs will be monitored
   - Note: the action uses **two separate tokens** for different purposes:
     - The workflow job's default `GITHUB_TOKEN` (via `contents: write` permission) → commits the state file back to the workflow repo
     - The `github-token` action input → reads PR statuses from the repos being monitored (different repos)
   - Repo where the Actions actor can push (required because `trackUnresolved` defaults to `true`)

2. **Create your config file**
   - Minimal viable config: just `channels` with one entry, no custom reactions needed (defaults work)
   - Inline tip on how to find the channel ID (right-click → Copy link)

3. **Add a workflow**
   - Minimal workflow YAML (the current "Example Workflow")
   - Inline comments explaining `contents: write` (for state file commits) and `actions/checkout` (required to read config file and write state file)

4. **Store your secrets**
   - One-liner: add `SLACK_TOKEN` and `PR_BOT_GITHUB_TOKEN` to **Settings → Secrets and variables → Actions**

### 4. How it Works
Move below Quick Start (don't block new users). Keep the existing step-by-step description. Fold "Handling Messages with Multiple Pull Requests" into this section. Move the example screenshot to Section 1 (above); no screenshot here.

### 5. Reference
Three subsections:

1. **Token Permissions**
   - Reframe around the dual-token pattern: lead with a one-line summary of which token does what, then the existing detail
   - Keep the `[!WARNING]` about the default `GITHUB_TOKEN` not working for private repos, but add context: it's scoped to the workflow repo, not the target repos
   - Fix typo: `assocaited` → `associated` (in channels section below)

2. **Action Inputs**
   - Keep existing reference table as-is

3. **Configuration File**
   - Keep existing content (reactions + channels options)
   - Fix typo: `assocaited` → `associated`

### 6. Advanced Usage *(new section)*
Consolidate two topics currently buried inside Action Inputs explanations:

1. **Persistent PR Tracking (`trackUnresolved`)**
   - Combine the explanation from the Action Inputs "When to use state-file / trackUnresolved" subsection
   - Include: what it does, when to use it, required workflow permissions, example config snippet

2. **Reaction-Only Mode (`skip-digest`)**
   - Combine the explanation from "When to use skip-digest"
   - Include the advanced workflow YAML (full digest + cleanup-only schedule)

### 7. Migrating from v1
No changes.

### 8. License
No changes.

## Key Decisions

- **Recommended Practices stays near the top** — it's context, not a tutorial. New users need the mental model before setup instructions.
- **Quick Start is self-contained** — users shouldn't need to jump to other sections to get running. Full token setup detail lives in Reference for those who need it.
- **Dual-token pattern made explicit** — the current README warns the default token won't work but doesn't explain why. Both Quick Start and Token Permissions will clarify that the two tokens target different repos.
- **Advanced Usage extracted** — `trackUnresolved` and `skip-digest` are currently buried inside the Action Inputs section. Moving them to a dedicated section makes them discoverable without cluttering the reference table.
- **No code changes** — this is a documentation-only update. The `github-token` input remains required; defaulting to `GITHUB_TOKEN` was considered but rejected because the two tokens target different repos.
- **Screenshot moves to top** — currently mid-page after How it Works. Moving it under the intro gives visitors an immediate visual of the end result.

## Out of Scope
- Changes to action behavior or inputs
- New features or configuration options
- Changes to Migrating from v1 or License sections
