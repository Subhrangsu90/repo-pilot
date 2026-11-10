import { config } from '../config';
import { openDb } from './client';

// `npm run db:migrate -w @repopilot/server`: apply migrations without starting the server.
if (!config.DATABASE_URL) {
  console.error('DATABASE_URL is not set in projects/server/.env.');
  process.exit(1);
}
const { close } = await openDb(config.DATABASE_URL);
await close();
console.log('Database is up to date.');
