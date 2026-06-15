// Unit tests for getCommitDiff (the per-file patch fetch with truncation).
// Mocks @octokit/rest at the module boundary (testing-guidelines: all GitHub
// access goes through the service layer; the test fakes Octokit, not the wire).

const getCommitMock = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: class {
    repos = { getCommit: getCommitMock };
  },
}));

import { getCommitDiff } from '../services/githubClient';

beforeEach(() => {
  getCommitMock.mockReset();
});

describe('getCommitDiff', () => {
  it('returns per-file patches when under the char budget', async () => {
    getCommitMock.mockResolvedValue({
      data: {
        sha: 'abc123',
        commit: { message: 'feat: thing' },
        files: [
          { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ a @@' },
          { filename: 'b.ts', status: 'added', additions: 5, deletions: 0, patch: '@@ b @@' },
        ],
      },
    });

    const res = await getCommitDiff('o', 'r', 'tok', 'abc123', 12000);

    expect(res.sha).toBe('abc123');
    expect(res.truncated).toBe(false);
    expect(res.files.map((f) => f.patch)).toEqual(['@@ a @@', '@@ b @@']);
  });

  it('truncates once the running patch length exceeds maxPatchChars', async () => {
    getCommitMock.mockResolvedValue({
      data: {
        sha: 'abc123',
        commit: { message: 'big' },
        files: [
          { filename: 'a.ts', status: 'modified', additions: 0, deletions: 0, patch: 'x'.repeat(8) },
          { filename: 'b.ts', status: 'modified', additions: 0, deletions: 0, patch: 'y'.repeat(8) },
          { filename: 'c.ts', status: 'modified', additions: 0, deletions: 0, patch: 'z'.repeat(8) },
        ],
      },
    });

    const res = await getCommitDiff('o', 'r', 'tok', 'abc123', 10);

    expect(res.truncated).toBe(true);
    // First file fits (8 <= 10); the next would overflow → patch dropped to null,
    // metadata retained. All later files also null.
    expect(res.files[0].patch).toBe('x'.repeat(8));
    expect(res.files[1].patch).toBeNull();
    expect(res.files[2].patch).toBeNull();
    expect(res.files[1].filename).toBe('b.ts');
  });

  it('keeps binary files (no patch) as null without flagging truncation', async () => {
    getCommitMock.mockResolvedValue({
      data: {
        sha: 'abc123',
        commit: { message: 'img' },
        files: [
          { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
          { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ a @@' },
        ],
      },
    });

    const res = await getCommitDiff('o', 'r', 'tok', 'abc123', 12000);

    expect(res.truncated).toBe(false);
    expect(res.files[0].patch).toBeNull();
    expect(res.files[1].patch).toBe('@@ a @@');
  });
});
