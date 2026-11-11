import { fileURLToPath } from 'node:url';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Connects and brings the schema up to date. Throws if Postgres is not reachable. */
export async function openDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  // Small pool: one dev server, a laptop next to Ollama.
  const sql = postgres(url, { max: 5, onnotice: () => {}, connect_timeout: 5 });
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => sql.end({ timeout: 5 }) };
}
