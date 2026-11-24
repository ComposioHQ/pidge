import { defineSchedule } from "eve/schedules";
import { db } from "../../db/client";
import { dreamDue } from "../../db/services/memory";
import { modelDreamer } from "../lib/memory/dream";

/**
 * Nightly dreaming (docs/decisions.md D17): hourly, consolidate the notes of each person whose local time is 3 a.m.
 * into concise durable facts. Runs as plain code: no conversation or message is started.
 */
export default defineSchedule({
  cron: "17 * * * *",
  run({ waitUntil }) {
    waitUntil(dreamDue(db(), (userId) => modelDreamer(db(), userId)));
  },
});
