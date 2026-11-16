import { describe, expect, it } from "vitest";
import { firstOccurrence, nextOccurrence } from "./recurrence";

const LA = "America/Los_Angeles";
const iso = (date: Date | null) => date?.toISOString() ?? null;

function recurring(cron: string) {
  return { kind: "recurring" as const, cron, everyMinutes: null, timezone: LA };
}

describe("recurrence", () => {
  it("keeps a daily local time across the fall DST change", () => {
    const job = recurring("0 9 * * *");
    const first = firstOccurrence({ kind: "recurring", cron: job.cron }, LA, new Date("2026-10-31T12:00:00Z"));
    expect(iso(first as Date)).toBe("2026-10-31T16:00:00.000Z"); // 09:00 PDT
    const second = nextOccurrence(job, first as Date, first as Date);
    expect(iso(second)).toBe("2026-11-01T17:00:00.000Z"); // 09:00 PST
  });

  it("keeps a weekday local time across the spring DST change", () => {
    const job = recurring("0 8 * * 1-5");
    const friday = new Date("2027-03-12T16:00:00Z"); // Fri 08:00 PST
    expect(iso(nextOccurrence(job, friday, friday))).toBe("2027-03-15T15:00:00.000Z"); // Mon 08:00 PDT
  });

  it("fires once when the local time is skipped or repeated by DST", () => {
    const skipped = recurring("30 2 * * *");
    const before = new Date("2027-03-13T10:30:00Z"); // Sat 02:30 PST
    const onChangeDay = nextOccurrence(skipped, before, before) as Date;
    expect(iso(onChangeDay)).toBe("2027-03-14T10:30:00.000Z"); // 02:30 doesn't exist; runs once at 03:30 PDT
    const after = nextOccurrence(skipped, onChangeDay, onChangeDay);
    expect(iso(after)).toBe("2027-03-15T09:30:00.000Z"); // Mon 02:30 PDT

    const repeated = recurring("30 1 * * *");
    const first = new Date("2026-11-01T08:30:00Z"); // 01:30 PDT, before the repeat
    expect(iso(nextOccurrence(repeated, first, first))).toBe("2026-11-02T09:30:00.000Z");
  });

  it("rejects cadences that are too frequent, malformed, or in the past", () => {
    const now = new Date("2026-11-05T12:00:00Z");
    expect(firstOccurrence({ kind: "recurring", cron: "*/5 * * * *" }, LA, now)).toHaveProperty("error");
    expect(firstOccurrence({ kind: "recurring", cron: "0 0 9 * * *" }, LA, now)).toHaveProperty("error");
    expect(firstOccurrence({ kind: "recurring", cron: "not a cron" }, LA, now)).toHaveProperty("error");
    expect(firstOccurrence({ kind: "interval", everyMinutes: 5, firstAt: now }, LA, now)).toHaveProperty("error");
    expect(firstOccurrence({ kind: "once", at: new Date("2026-11-05T11:00:00Z") }, LA, now)).toHaveProperty("error");
    expect(firstOccurrence({ kind: "once", at: new Date("2028-11-05T11:00:00Z") }, LA, now)).toHaveProperty("error");
    expect(firstOccurrence({ kind: "once", at: new Date("2026-11-06T23:00:00Z") }, LA, now)).toEqual(
      new Date("2026-11-06T23:00:00Z"),
    );
  });

  it("coalesces missed occurrences instead of replaying them", () => {
    const interval = { kind: "interval" as const, cron: null, everyMinutes: 60, timezone: LA };
    const claimed = new Date("2026-11-05T00:00:00Z");
    const now = new Date("2026-11-05T05:30:00Z");
    expect(iso(nextOccurrence(interval, claimed, now))).toBe("2026-11-05T06:00:00.000Z");

    const daily = recurring("0 9 * * *");
    const missed = new Date("2026-11-02T17:00:00Z");
    expect(iso(nextOccurrence(daily, missed, new Date("2026-11-05T18:00:00Z")))).toBe("2026-11-06T17:00:00.000Z");
    expect(nextOccurrence({ kind: "once", cron: null, everyMinutes: null, timezone: LA }, claimed, now)).toBeNull();
  });
});
