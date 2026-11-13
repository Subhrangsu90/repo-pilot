import { inverseRepo, pinRepo, type Inverse } from './undo';

describe('undo keeps the repository of the change', () => {
  const issues: Inverse = { kind: 'issues', label: 'Reopen #9', input: { issueNumbers: [9], action: 'reopen', reason: 'not_planned' } };
  const release: Inverse = { kind: 'release', label: 'Delete v1.2.0', repo: '', releaseId: 7, tag: 'v1.2.0' };

  it('pins the repo into issue and release inverses', () => {
    expect(inverseRepo(pinRepo(issues, 'octo/app'))).toBe('octo/app');
    expect(inverseRepo(pinRepo(release, 'octo/app'))).toBe('octo/app');
    // The original is not changed.
    expect(issues.input.repo).toBeUndefined();
  });

  it('reports no repo for entries recorded before repos were pinned', () => {
    expect(inverseRepo(issues)).toBeUndefined();
    expect(inverseRepo(release)).toBeUndefined();
  });
});
