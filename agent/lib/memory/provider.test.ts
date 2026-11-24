import { beforeEach, describe, expect, it } from "vitest";
import { saveMemory } from "../../../db/services/memory";
import { makeUser, resetDb, testDb } from "../../../test/db";
import { imessagePrincipal, notifyPrincipal, scheduledPrincipal, webPrincipal } from "../identity/principal";
import { pidgeMemory } from "./provider";

const eveRoot = new URL("./", import.meta.resolve("eve"));
const { ContextContainer, contextStorage } = await import(new URL("context/container.js", eveRoot).href);
const recall = (context: never): ReturnType<(typeof pidgeMemory.recall)["turn.started"]> =>
  contextStorage.run(new ContextContainer(), () => pidgeMemory.recall["turn.started"](context));

const THREAD = "imessage:any;-;+14155550100";

function ctx(auth: ReturnType<typeof webPrincipal> | null, scope: string | null, text = "") {
  return {
    session: { id: "wrun_memory_test", auth: { current: auth } },
    memory: { scope: { key: "k", namespace: "n", value: scope }, slot: "memory" },
    turn: { id: "t1", sequence: 1, input: [{ role: "user", content: [{ type: "text", text }] }] },
  } as never;
}

type Tool = { approval?: unknown; execute(input: unknown, ctx: never): Promise<Record<string, unknown>> };
async function tools(auth: ReturnType<typeof webPrincipal>, userId: string) {
  return (await pidgeMemory.tools?.(ctx(auth, userId))) as Record<string, Tool> | null;
}

describe("pidge memory provider", () => {
  beforeEach(resetDb);

  it("recalls the owner's facts and notes related to the new message before the model runs", async () => {
    const ada = await makeUser("Ada");
    const bo = await makeUser("Bo");
    await saveMemory(testDb(), ada, { content: "Prefers aisle seats.", tier: "fact", origin: "explicit" });
    await saveMemory(testDb(), ada, {
      content: "Flying to Denver for a wedding in May.",
      tier: "note",
      origin: "inferred",
    });
    await saveMemory(testDb(), bo, { content: "Bo's secret project.", tier: "fact", origin: "explicit" });

    const recalled = await recall(ctx(webPrincipal(ada), ada, "book my Denver flight"));
    const text = recalled?.messages.map((m) => m.content).join("\n") ?? "";
    expect(recalled?.messages.map((m) => m.id)).toEqual(["pidge-memory-facts", "pidge-memory-related"]);
    expect(text).toContain("(they told you) Prefers aisle seats.");
    expect(text).toContain("Flying to Denver for a wedding in May.");
    expect(text).not.toContain("Bo's");
  });

  it("disables memory without a Pidge principal, for notify hand-offs, and when the locked scope disagrees", async () => {
    const ada = await makeUser("Ada");
    const bo = await makeUser("Bo");
    expect(await recall(ctx(null, ada))).toBeNull();
    expect(await recall(ctx(notifyPrincipal(ada, THREAD, "+14155550100", "hi"), ada))).toBeNull();
    expect(await recall(ctx(webPrincipal(ada), bo))).toBeNull();
    expect(await pidgeMemory.tools?.(ctx(webPrincipal(ada), bo))).toBeNull();
  });

  it("keeps automatic saves unconfirmed and reserves corrections for authenticated web actions", async () => {
    const ada = await makeUser("Ada");
    const t = await tools(imessagePrincipal(ada, THREAD, "+14155550100"), ada);
    const fact = await t?.save?.execute({ text: "Lives in Oakland.", kind: "explicit" }, {} as never);
    expect(fact).toMatchObject({ status: "saved", memory: { kind: "note" } });
    expect(await t?.save?.execute({ text: "Seems to like ramen.", kind: "observation" }, {} as never)).toMatchObject({
      memory: { kind: "note" },
    });
    expect(await t?.save?.execute({ text: "My PIN is 1234", kind: "explicit" }, {} as never)).toMatchObject({
      status: "refused",
    });

    const id = (fact?.memory as { id: string } | undefined)?.id;
    expect(await t?.save?.execute({ text: "Lives in Berkeley.", kind: "explicit" }, {} as never)).toMatchObject({
      memory: { kind: "note" },
    });
    expect(t?.forget?.approval).toBeDefined();
    expect(await t?.forget?.execute({ id }, {} as never)).toMatchObject({ status: "forgotten" });
  });

  it("gives scheduled report turns read-only memory", async () => {
    const ada = await makeUser("Ada");
    const t = await tools(scheduledPrincipal(ada, THREAD, "+14155550100", "run-1"), ada);
    expect(Object.keys(t ?? {})).toEqual(["search"]);
  });
});
