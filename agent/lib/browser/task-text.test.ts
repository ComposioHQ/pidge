import { describe, expect, it } from "vitest";
import { buildTaskText, commitApprovalPrompt, prepareSucceeded, runBrowserApproval } from "./task-text";

const terms = {
  site: "SevenRooms - Cafe Example",
  action: "Reserve a table at Cafe Example",
  date_time: "Thursday Nov 5, 2026 at 8:00 PM",
  party_size: 4,
  total: "No deposit",
  account: "guest",
};
const contact = { fullName: "Alex Example", email: "alex@example.com", phone: "+1 415 555 0100" };

describe("run_browser approval", () => {
  it("lets research runs start without approval", () => {
    expect(runBrowserApproval({ instructions: "Find vegetarian dinner options near Moscone", mode: "research" })).toBe(
      "not-applicable",
    );
  });

  it("requires approval of exact terms for every committing run", () => {
    expect(runBrowserApproval({ instructions: "Book the selected table for four", mode: "commit", terms })).toBe(
      "user-approval",
    );
  });

  it("denies committing runs without terms, and malformed input", () => {
    expect(runBrowserApproval({ instructions: "Book the selected table for four", mode: "commit" })).toMatchObject({
      type: "denied",
    });
    expect(runBrowserApproval({ mode: "research" })).toMatchObject({ type: "denied" });
    expect(runBrowserApproval({ instructions: "Book a table for us", mode: "purchase" })).toMatchObject({
      type: "denied",
    });
  });

  it("refuses committing runs on OpenTable, whose guest checkout hosted browsers cannot reach", () => {
    expect(
      runBrowserApproval({
        instructions: "Book the 8 PM table",
        mode: "commit",
        terms: { ...terms, site: "OpenTable" },
      }),
    ).toMatchObject({ type: "denied" });
    const viaUrl = { ...terms, site: "FANG" };
    expect(
      runBrowserApproval({
        instructions: "Book the 8 PM table",
        mode: "commit",
        terms: viaUrl,
        start_url: "https://www.opentable.com/rest/4037?covers=4",
      }),
    ).toMatchObject({ type: "denied" });
    expect(
      runBrowserApproval({
        instructions: "Book the 8 PM table",
        mode: "commit",
        terms: { ...terms, site: "SevenRooms - Bar Sprezzatura" },
        start_url: "https://www.sevenrooms.com/explore/barsprezzatura/reservations/create/search?party_size=4",
      }),
    ).toBe("user-approval");
  });

  it("shows the merchant, action, time, party size, total, and account in the approval", () => {
    const prompt = commitApprovalPrompt(terms);
    for (const value of [terms.site, terms.action, terms.date_time, "4", terms.total, terms.account]) {
      expect(prompt).toContain(value);
    }
  });
});

describe("browser task text", () => {
  it("forbids submissions in research runs and never includes contact details", () => {
    const text = buildTaskText({ instructions: "Check availability for 2 at 7 PM", mode: "research" }, contact);
    expect(text).toMatch(/^RESEARCH ONLY/);
    expect(text).toContain("Do not submit any form");
    expect(text).not.toContain(contact.phone);
    expect(text).not.toContain(contact.email);
    expect(text).toContain("CAPTCHA");
  });

  it("keeps contact details out of the navigation phase and forbids typing or submitting there", () => {
    const text = buildTaskText({ instructions: "Reserve the 8 PM table", mode: "commit", terms }, contact, "prepare");
    expect(text).toContain("party size 4");
    expect(text).toContain("Do NOT type into any field and do NOT press submit");
    expect(text).not.toContain(contact.phone);
    expect(text).not.toContain(contact.email);
    expect(text).toContain("Never sign in");
  });

  it("submits only in the completion phase, bounded to the approved terms, with only booking contact fields", () => {
    const text = buildTaskText({ instructions: "Reserve the 8 PM table", mode: "commit", terms }, contact, "complete");
    expect(text).toContain("party size 4");
    expect(text).toContain("submit it exactly once");
    expect(text).toContain("First name: Alex");
    expect(text).toContain("Last name: Example");
    expect(text).toContain(contact.phone);
    expect(text).toContain("STOP and report exactly what differs");
  });

  it("continues to the completion phase only when the navigation run reports the form is ready", () => {
    expect(prepareSucceeded("READY: Thu Nov 5, 8:00 PM, 4 guests, total $0.00")).toBe(true);
    expect(prepareSucceeded("  READY\nform shown")).toBe(true);
    expect(prepareSucceeded("NOT READY: a $39 deposit is required")).toBe(false);
    expect(prepareSucceeded("The guest form is shown")).toBe(false);
    expect(prepareSucceeded(null)).toBe(false);
  });

  it("refuses to build a committing task without terms", () => {
    expect(() => buildTaskText({ instructions: "Reserve the 8 PM table", mode: "commit" }, contact)).toThrow();
  });
});
