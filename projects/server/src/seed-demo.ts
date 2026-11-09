/**
 * Seeds the demo repository with realistic content for every RepoPilot feature:
 * backdated commit history (activity chart), a v1.0.0 release (release builder),
 * labelled issues incl. wontfix ones (bulk cleanup) and a prompt-injection issue
 * (safety demo), and pull requests: one merged (undo), one with planted bugs (AI
 * review), one draft, one left open.
 *
 *   npm run seed:demo -w @repopilot/server           # print the plan only
 *   npm run seed:demo -w @repopilot/server -- --yes  # write to GitHub
 *
 * Safe to re-run: existing files, labels, issues, branches and PRs are skipped.
 * Only touches the first repo in GITHUB_REPO_ALLOWLIST. Never prints the token.
 */
import { config } from './config';
import * as demo from './seed-demo-content';

const repo = config.GITHUB_REPO_ALLOWLIST[0];
const write = process.argv.includes('--yes');

if (!config.GITHUB_TOKEN) fail('GITHUB_TOKEN is empty.');
if (!repo) fail('GITHUB_REPO_ALLOWLIST is empty.');

// ---------------------------------------------------------------------------
// Tiny GitHub client (Octokit arrives with the week-2 tools)
// ---------------------------------------------------------------------------

interface GhResponse<T> {
  status: number;
  data: T;
}

async function gh<T = any>(method: string, path: string, body?: unknown): Promise<GhResponse<T>> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'repopilot-seed',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (method !== 'GET') await sleep(1100); // stay clear of GitHub's secondary rate limit
  return { status: res.status, data };
}

async function must<T = any>(method: string, path: string, body?: unknown, ok = [200, 201]) {
  const res = await gh<T>(method, path, body);
  if (!ok.includes(res.status)) {
    const msg = (res.data as { message?: string } | null)?.message ?? '';
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${msg}`);
  }
  return res.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const log = (icon: string, msg: string) => console.log(`${icon} ${msg}`);
function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function daysAgo(days: number, hour = 10) {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setUTCHours(hour, 17, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

let identity: { name: string; email: string };

/**
 * Create or update one file; returns the new commit SHA, or null if unchanged.
 * With `createOnly`, an existing file is never touched: used when replaying the
 * scripted history on an already-seeded repo, where a path appears in several
 * versions and later commits (e.g. merged PRs) must not be overwritten.
 */
async function putFile(file: demo.FileChange, branch?: string, createOnly = false): Promise<string | null> {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const existing = await gh<{ sha: string; content: string }>('GET', `/repos/${repo}/contents/${file.path}${ref}`);
  if (existing.status === 200 && createOnly) {
    log('·', `${file.path} already exists, history not replayed`);
    return null;
  }
  if (existing.status === 200) {
    const current = Buffer.from(existing.data.content, 'base64').toString('utf8');
    if (current === file.content) {
      log('·', `${file.path}${branch ? ` @ ${branch}` : ''} already up to date`);
      return null;
    }
  }

  const when = daysAgo(file.daysAgo ?? 0, file.hour);
  const person = { ...identity, date: when };
  try {
    const result = await must<{ commit: { sha: string } }>('PUT', `/repos/${repo}/contents/${file.path}`, {
      message: file.message,
      content: b64(file.content),
      ...(existing.status === 200 ? { sha: existing.data.sha } : {}),
      ...(branch ? { branch } : {}),
      author: person,
      committer: person,
    });
    log('✔', `${file.message}  (${file.path}${branch ? ` @ ${branch}` : ''})`);
    return result.commit.sha;
  } catch (err) {
    if (file.path.startsWith('.github/workflows/')) {
      log('!', `skipped ${file.path}: the token needs the "Workflows: write" permission to add CI`);
      return null;
    }
    throw err;
  }
}

async function ensureLabels() {
  const existing = await must<{ name: string }[]>('GET', `/repos/${repo}/labels?per_page=100`);
  const names = new Set(existing.map((l) => l.name.toLowerCase()));
  for (const label of demo.labels) {
    if (names.has(label.name.toLowerCase())) continue;
    await must('POST', `/repos/${repo}/labels`, label);
    log('✔', `label ${label.name}`);
  }
}

async function ensureRelease(targetSha: string | null) {
  const found = await gh('GET', `/repos/${repo}/releases/tags/${demo.release.tag}`);
  if (found.status === 200) return log('·', `release ${demo.release.tag} already exists`);
  const head = targetSha ?? (await must<{ object: { sha: string } }>('GET', `/repos/${repo}/git/ref/heads/main`)).object.sha;
  await must('POST', `/repos/${repo}/releases`, {
    tag_name: demo.release.tag,
    target_commitish: head,
    name: demo.release.tag,
    body: demo.release.body,
  });
  log('✔', `release ${demo.release.tag}`);
}

async function ensureIssues(): Promise<Map<string, number>> {
  const all = await must<{ title: string; number: number; pull_request?: unknown }[]>(
    'GET',
    `/repos/${repo}/issues?state=all&per_page=100`,
  );
  const byTitle = new Map(all.filter((i) => !i.pull_request).map((i) => [i.title, i.number]));

  for (const issue of demo.issues) {
    if (byTitle.has(issue.title)) {
      log('·', `issue "${issue.title}" already exists (#${byTitle.get(issue.title)})`);
      continue;
    }
    const created = await must<{ number: number }>('POST', `/repos/${repo}/issues`, {
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
    byTitle.set(issue.title, created.number);
    log('✔', `issue #${created.number} ${issue.title}`);
    if (issue.closed) {
      await must('PATCH', `/repos/${repo}/issues/${created.number}`, {
        state: 'closed',
        state_reason: issue.closed,
      });
      log('✔', `  closed #${created.number} as ${issue.closed}`);
    }
  }
  return byTitle;
}

async function ensurePullRequests(issueNumbers: Map<string, number>) {
  const prs = await must<{ number: number; head: { ref: string }; merged_at: string | null; state: string }[]>(
    'GET',
    `/repos/${repo}/pulls?state=all&per_page=100`,
  );

  for (const pr of demo.pullRequests) {
    // Branch from current main.
    const branchRef = await gh('GET', `/repos/${repo}/git/ref/heads/${pr.branch}`);
    if (branchRef.status !== 200) {
      const main = await must<{ object: { sha: string } }>('GET', `/repos/${repo}/git/ref/heads/main`);
      await must('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${pr.branch}`, sha: main.object.sha });
      log('✔', `branch ${pr.branch}`);
    }
    for (const file of pr.files) await putFile(file, pr.branch);

    let existing = prs.find((p) => p.head.ref === pr.branch);
    if (!existing) {
      const body = pr.body.replace(/\{\{issue:(.+?)\}\}/g, (_, title: string) => {
        const n = issueNumbers.get(title);
        return n ? `#${n}` : title;
      });
      const created = await must<{ number: number }>('POST', `/repos/${repo}/pulls`, {
        title: pr.title,
        head: pr.branch,
        base: 'main',
        body,
        draft: pr.draft ?? false,
      });
      existing = { number: created.number, head: { ref: pr.branch }, merged_at: null, state: 'open' };
      log('✔', `PR #${created.number} ${pr.title}${pr.draft ? ' (draft)' : ''}`);
      if (pr.labels?.length) {
        await must('POST', `/repos/${repo}/issues/${created.number}/labels`, { labels: pr.labels });
      }
    } else {
      log('·', `PR #${existing.number} for ${pr.branch} already exists`);
    }

    // Keep open PR branches current with main (e.g. after CI was added), which
    // also triggers a CI run on the PR.
    if (!pr.merge && existing.state === 'open') {
      const cmp = await must<{ behind_by: number }>('GET', `/repos/${repo}/compare/main...${encodeURIComponent(pr.branch)}`);
      if (cmp.behind_by > 0) {
        await must('PUT', `/repos/${repo}/pulls/${existing.number}/update-branch`, {}, [202]);
        log('✔', `  updated ${pr.branch} with main (${cmp.behind_by} commit${cmp.behind_by > 1 ? 's' : ''} behind)`);
      }
    }

    if (pr.merge && !existing.merged_at && existing.state === 'open') {
      // GitHub computes mergeability asynchronously; retry briefly.
      for (let attempt = 1; ; attempt++) {
        const res = await gh('PUT', `/repos/${repo}/pulls/${existing.number}/merge`, { merge_method: 'squash' });
        if (res.status === 200) {
          log('✔', `  merged PR #${existing.number} (squash)`);
          break;
        }
        if (attempt >= 5) throw new Error(`merge of PR #${existing.number} failed: HTTP ${res.status}`);
        await sleep(2000);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const me = await must<{ login: string; id: number; name: string | null }>('GET', '/user');
identity = { name: me.name ?? me.login, email: `${me.id}+${me.login}@users.noreply.github.com` };
const info = await must<{ default_branch: string; size: number }>('GET', `/repos/${repo}`);

console.log(`\nRepo:  ${repo} (default branch ${info.default_branch})`);
console.log(`As:    ${me.login}`);
console.log(
  `Plan:  ${demo.labels.length} labels, ${demo.mainHistory.length + demo.afterRelease.length} commits on main, ` +
    `release ${demo.release.tag}, ${demo.issues.length} issues, ${demo.pullRequests.length} pull requests\n`,
);

if (!write) {
  console.log('Dry run. Re-run with -- --yes to write these to GitHub.');
  process.exit(0);
}

await ensureLabels();
// The release marks a seeded history. On re-runs only missing files are created.
const seeded = (await gh('GET', `/repos/${repo}/releases/tags/${demo.release.tag}`)).status === 200;
let releaseSha: string | null = null;
for (const file of demo.mainHistory) releaseSha = (await putFile(file, undefined, seeded)) ?? releaseSha;
await ensureRelease(releaseSha);
for (const file of demo.afterRelease) await putFile(file, undefined, seeded);
const issueNumbers = await ensureIssues();
await ensurePullRequests(issueNumbers);

console.log(`\nDone: https://github.com/${repo}`);
