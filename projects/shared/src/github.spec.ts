import { validateNode } from './catalog';
import { githubUrl, isGitHubAvatar, isGitHubUrl } from './github';

describe('GitHub addresses', () => {
  it('builds every address from one base', () => {
    expect(githubUrl.api('/user')).toBe('https://api.github.com/user');
    expect(githubUrl.graphql).toBe('https://api.github.com/graphql');
    expect(githubUrl.oauthAuthorize).toBe('https://github.com/login/oauth/authorize');
    expect(githubUrl.oauthAppAccess('Iv1 x/y')).toBe('https://github.com/settings/connections/applications/Iv1%20x%2Fy');
    expect(githubUrl.pullRequest('octo/app', 15)).toBe('https://github.com/octo/app/pull/15');
  });

  it('accepts only https github.com pages and GitHub avatars', () => {
    expect(isGitHubUrl('https://github.com/octocat')).toBe(true);
    expect(isGitHubAvatar('https://avatars.githubusercontent.com/u/1?v=4')).toBe(true);
    for (const bad of [
      'http://github.com/octocat',
      'https://github.com.evil.example/x',
      'https://evil.example/github.com',
      'https://gist.github.com/x',
      'https://user:pass@github.com/x',
      'javascript:alert(1)',
      '//github.com/x',
      42,
      null,
    ]) {
      expect(isGitHubUrl(bad)).toBe(false);
    }
    expect(isGitHubAvatar('https://avatars.githubusercontent.com.evil.example/u/1')).toBe(false);
    expect(isGitHubAvatar('https://github.com/u/1')).toBe(false);
  });

  it('is what the catalog checks links and avatars against', () => {
    const card = (url: string) => ({ component: 'PrCard', props: { number: 1, title: 't', state: 'open', ageDays: 0, url } });
    expect(validateNode(card(githubUrl.pullRequest('octo/app', 1))).ok).toBe(true);
    expect(validateNode(card('https://github.com.evil.example/o/r/pull/1')).ok).toBe(false);
  });
});
