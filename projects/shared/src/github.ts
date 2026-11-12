/**
 * Every GitHub address RepoPilot uses, in one place: the server (API calls,
 * OAuth), the app (links, avatars) and the component catalog (which links and
 * images the agent's UI may contain). Change a host here and everything follows.
 */

/** The website: profiles, repositories, pull requests, OAuth, settings. */
export const GITHUB_WEB = 'https://github.com';
/** REST and GraphQL API. */
export const GITHUB_API = 'https://api.github.com';
/** Profile pictures. */
export const GITHUB_AVATARS = 'https://avatars.githubusercontent.com';

/** Hostnames for Zod's `z.url({ hostname })` checks in the catalog. */
export const GITHUB_WEB_HOST = /^github\.com$/;
export const GITHUB_AVATAR_HOST = /^avatars\.githubusercontent\.com$/;

/** Addresses built from the bases above. `repo` is "owner/name". */
export const githubUrl = {
  /** A REST path such as "/user" or "/repos/o/r/issues". */
  api: (path: string) => `${GITHUB_API}${path}`,
  graphql: `${GITHUB_API}/graphql`,

  oauthAuthorize: `${GITHUB_WEB}/login/oauth/authorize`,
  oauthAccessToken: `${GITHUB_WEB}/login/oauth/access_token`,
  /** Where a user reviews or revokes an OAuth App's access. */
  oauthAppAccess: (clientId: string) => `${GITHUB_WEB}/settings/connections/applications/${encodeURIComponent(clientId)}`,
  /** Fine-grained personal access tokens (dev mode). */
  personalTokens: `${GITHUB_WEB}/settings/personal-access-tokens`,

  repo: (repo: string) => `${GITHUB_WEB}/${repo}`,
  pullRequest: (repo: string, number: number) => `${GITHUB_WEB}/${repo}/pull/${number}`,
} as const;

/** True for an https URL on a given host pattern. Never throws. */
function onHost(url: unknown, host: RegExp): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && host.test(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** A github.com page over https (safe to link to). */
export const isGitHubUrl = (url: unknown): url is string => onHost(url, GITHUB_WEB_HOST);
/** A GitHub avatar over https (safe to load as an image). */
export const isGitHubAvatar = (url: unknown): url is string => onHost(url, GITHUB_AVATAR_HOST);
