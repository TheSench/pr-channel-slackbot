import { vi, describe, it, expect } from 'vitest';

vi.mock('@actions/core', () => ({ getInput: vi.fn() }));
vi.mock('@actions/github', () => ({ getOctokit: vi.fn() }));

import { extractPullRequests } from './github.mjs';

describe('extractPullRequests', () => {
  it('returns an empty array when text contains no GitHub PR URLs', () => {
    expect(extractPullRequests('Check out https://example.com for details')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(extractPullRequests('')).toEqual([]);
  });

  it('extracts a single PR URL into owner, repo, and pull_number', () => {
    const text = 'Please review: https://github.com/myorg/myrepo/pull/42';
    expect(extractPullRequests(text)).toEqual([
      { owner: 'myorg', repo: 'myrepo', pull_number: '42' },
    ]);
  });

  it('extracts multiple PR URLs from the same message', () => {
    const text = 'Related PRs: https://github.com/org/repo1/pull/1 and https://github.com/org/repo2/pull/2';
    expect(extractPullRequests(text)).toEqual([
      { owner: 'org', repo: 'repo1', pull_number: '1' },
      { owner: 'org', repo: 'repo2', pull_number: '2' },
    ]);
  });

  it('handles PR URLs embedded within surrounding text', () => {
    const text = 'Review <https://github.com/org/repo/pull/99> before EOD!';
    expect(extractPullRequests(text)).toEqual([
      { owner: 'org', repo: 'repo', pull_number: '99' },
    ]);
  });
});
