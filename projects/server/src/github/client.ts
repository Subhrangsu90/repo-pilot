/**
 * Minimal GitHub client over fetch (REST + GraphQL). The token stays here: it
 * is never logged, never sent to the browser and never given to the model.
 */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class GitHub {
  private viewer?: Promise<string>;

  constructor(private readonly token: string) {}

  private headers() {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'repopilot',
    };
  }

  async rest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? 'GET',
      headers: { ...this.headers(), ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new GitHubError(`GitHub ${init.method ?? 'GET'} ${path}: ${await message(res)}`, res.status);
    // DELETE and some PUTs answer 204 with no body.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new GitHubError(`GitHub GraphQL: ${await message(res)}`, res.status);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new GitHubError(`GitHub GraphQL: ${body.errors[0].message}`, 200);
    return body.data as T;
  }

  /**
   * The token's user and, for OAuth tokens, the scopes GitHub actually granted
   * (`x-oauth-scopes`; fine-grained tokens send none, so `scopes` is null).
   */
  async me<T>(): Promise<{ user: T; scopes: string[] | null }> {
    const res = await fetch('https://api.github.com/user', { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new GitHubError(`GitHub GET /user: ${await message(res)}`, res.status);
    const header = res.headers.get('x-oauth-scopes');
    return {
      user: (await res.json()) as T,
      scopes: header === null ? null : header.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }

  /** Login of the token's user, for "@me". Cached. */
  login(): Promise<string> {
    this.viewer ??= this.rest<{ login: string }>('/user').then((u) => u.login);
    return this.viewer;
  }
}

async function message(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return `HTTP ${res.status} ${body.message ?? ''}`.trim();
  } catch {
    return `HTTP ${res.status}`;
  }
}
