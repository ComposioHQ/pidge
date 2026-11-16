// Applies committed Drizzle migrations using the direct (unpooled) connection.
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connect } from "../db/client";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");

const { db, sql } = connect(url, { max: 1 });
try {
  await migrate(db, { migrationsFolder: new URL("../db/migrations", import.meta.url).pathname });
  console.log("migrations applied");
} finally {
  await sql.end();
}
