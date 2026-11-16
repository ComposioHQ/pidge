import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../shared/environment/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let instance: { db: Database; sql: postgres.Sql } | undefined;

/** Lazily connected pooled client for the runtime DATABASE_URL. */
export function db(): Database {
  instance ??= connect(env().DATABASE_URL);
  return instance.db;
}

export function connect(url: string, options: { max?: number } = {}): { db: Database; sql: postgres.Sql } {
  const sql = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql };
}

export { schema };
