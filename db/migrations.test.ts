import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../test/urls";
import { connect } from "./client";

it("migrates both an empty database and the original memory-0005 database without losing data", async () => {
  const folder = new URL("./migrations/", import.meta.url).pathname;
  const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
  const original = await mkdtemp(join(tmpdir(), "pidge-memory-migrations-"));
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const databases: string[] = [];
  const fingerprints: string[] = [];
  try {
    await mkdir(join(original, "meta"));
    const oldEntries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 5);
    await writeFile(join(original, "meta/_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
    for (const entry of oldEntries)
      await copyFile(join(folder, `${entry.tag}.sql`), join(original, `${entry.tag}.sql`));
    for (const incremental of [false, true]) {
      const name = `pidge_migration_${crypto.randomUUID().replaceAll("-", "")}`;
      databases.push(name);
      await admin.unsafe(`create database "${name}"`);
      const url = new URL(TEST_DATABASE_URL);
      url.pathname = `/${name}`;
      const { db, sql } = connect(url.toString(), { max: 1 });
      try {
        if (incremental) {
          await migrate(db, { migrationsFolder: original });
          await sql`insert into "user" (id, name, email) values ('00000000-0000-4000-8000-000000000001', 'Synthetic', 'synthetic@example.com')`;
          // Original PR allowed duplicate active rows; preserve both as provenance while enforcing new uniqueness.
          await sql`insert into memory_items(user_id, tier, origin, content, content_hash) values
            ('00000000-0000-4000-8000-000000000001', 'fact', 'explicit', 'Synthetic fact.', 'synthetic-hash'),
            ('00000000-0000-4000-8000-000000000001', 'fact', 'inferred', 'Synthetic fact.', 'synthetic-hash')`;
        }
        if (incremental) {
          // Commit the complete memory PR first, then upgrade that already-migrated database to the trigger stack.
          const memoryEntries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 6);
          await writeFile(join(original, "meta/_journal.json"), JSON.stringify({ ...journal, entries: memoryEntries }));
          for (const entry of memoryEntries)
            await copyFile(join(folder, `${entry.tag}.sql`), join(original, `${entry.tag}.sql`));
          await migrate(db, { migrationsFolder: original });
          expect(await sql`select to_regclass('public.app_event_runs') as events`).toEqual([{ events: null }]);
        }
        await migrate(db, { migrationsFolder: folder });
        await migrate(db, { migrationsFolder: folder }); // repeated deployment is a no-op
        if (incremental) {
          expect(await sql`select content, origin from memory_items where status = 'active'`).toEqual([
            { content: "Synthetic fact.", origin: "explicit" },
          ]);
          expect(await sql`select count(*)::int as n from memory_items`).toEqual([{ n: 2 }]);
        }
        const columns =
          await sql`select table_name, column_name, data_type, is_nullable, column_default, generation_expression
          from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`;
        const indexes =
          await sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`;
        fingerprints.push(JSON.stringify({ columns, indexes }));
      } finally {
        await sql.end();
      }
    }
    expect(fingerprints[0]).toBe(fingerprints[1]);
  } finally {
    for (const name of databases) await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
    await rm(original, { recursive: true, force: true });
  }
}, 30_000);
