import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { connect } from "../db/client";
import { TEST_DATABASE_URL } from "./urls";

/** Recreates the test database from committed migrations before the run. */
export default async function setup(): Promise<void> {
  const admin = new URL(TEST_DATABASE_URL);
  const name = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
    await sql.unsafe(`create database "${name}"`);
  } finally {
    await sql.end();
  }
  const { db, sql: client } = connect(TEST_DATABASE_URL, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: new URL("../db/migrations", import.meta.url).pathname });
  } finally {
    await client.end();
  }
}
