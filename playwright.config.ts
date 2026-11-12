import { defineConfig, devices } from '@playwright/test';

/**
 * End to end (doc §11): prompt → mock agent → components render → approve →
 * the fake GitHub receives the expected call. The server runs in E2E_MODE
 * (scripted model, in-process fake GitHub, no database) on its own ports, so a
 * run never touches the real GitHub, a real model, the dev database or the dev
 * servers on :3000 / :4200.
 */
const SERVER = 'http://127.0.0.1:3100';
const WEB = 'http://localhost:4300';

export default defineConfig({
  testDir: './e2e',
  // One fake GitHub is shared by the tests, so they run one at a time and reset it first.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: 'projects/server',
      env: { E2E_MODE: '1', PORT: '3100' },
      url: `${SERVER}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npx ng serve --port 4300 --proxy-config proxy.e2e.json',
      cwd: 'projects/web',
      url: WEB,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
