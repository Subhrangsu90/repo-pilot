import { defineConfig } from 'drizzle-kit';

// `npm run db:generate -w @repopilot/server` writes SQL migrations to ./drizzle;
// the server applies them on startup (src/db/client.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
