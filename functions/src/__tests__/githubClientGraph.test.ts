// Unit tests for fetchCommitGraph (the GraphQL branch-topology fetch) itself.
// Mocks @octokit/rest at the module boundary (testing-guidelines: all GitHub
// access goes through the service layer; the test fakes Octokit, not the wire).
// Covers the 06-05 fixes: query no longer asks for associatedPullRequests, a
// missing GraphQL `data` degrades to an empty result instead of throwing, and a
// transient 5xx is retried once.

const graphqlMock = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: class {
    graphql = graphqlMock;
  },
}));

import { fetchCommitGraph } from '../services/githubClient';

beforeEach(() => {
  graphqlMock.mockReset();
});

describe('fetchCommitGraph', () => {
  it('does not request associatedPullRequests in the bulk query', async () => {
    graphqlMock.mockResolvedValue({ repository: null });

    await fetchCommitGraph('team17', 'gitsync', 'tok');

    const query = graphqlMock.mock.calls[0][0] as string;
    expect(query).not.toContain('associatedPullRequests');
  });

  it('returns an empty result when GraphQL data is undefined (no TypeError)', async () => {
    graphqlMock.mockResolvedValue(undefined);

    await expect(
      fetchCommitGraph('team17', 'gitsync', 'tok'),
    ).resolves.toEqual({
      branches: [],
      defaultBranch: null,
      branchesTruncated: false,
    });
  });

  it('retries once on a transient 502 and returns the second response', async () => {
    jest.useFakeTimers();
    try {
      graphqlMock
        .mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }))
        .mockResolvedValueOnce({ repository: null });

      const promise = fetchCommitGraph('team17', 'gitsync', 'tok');
      // Let the first (rejected) attempt settle, then fast-forward the retry delay.
      await jest.advanceTimersByTimeAsync(500);
      const res = await promise;

      expect(graphqlMock).toHaveBeenCalledTimes(2);
      expect(res).toEqual({
        branches: [],
        defaultBranch: null,
        branchesTruncated: false,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rethrows when both attempts fail with 502', async () => {
    jest.useFakeTimers();
    try {
      graphqlMock.mockRejectedValue(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      );

      const promise = fetchCommitGraph('team17', 'gitsync', 'tok');
      // Attach the assertion before advancing timers so the eventual rejection
      // is observed (no unhandled-rejection warning).
      const assertion = expect(promise).rejects.toMatchObject({ status: 502 });
      await jest.advanceTimersByTimeAsync(500);
      await assertion;
      expect(graphqlMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
