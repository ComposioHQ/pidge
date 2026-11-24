import { defineTool } from "eve/tools";
import { db } from "../../db/client";
import { manageTriggers, triggerInput, triggerWrite } from "../lib/triggers/subscriptions";

export default defineTool({
  description:
    "Discover app-event types and their config schemas on the person's active connected accounts. Create a subscription that runs the person's instruction and replies in this iMessage conversation. List subscriptions and recent run statuses, disable, or remove one. Inspect the schema and explicitly choose the account before creation. A subscription never grants approval for future writes.",
  inputSchema: triggerInput,
  approval: {
    request: ({ toolInput }) => triggerWrite(toolInput),
    prompt: ({ input }) => `Approve app-event subscription change?\n${JSON.stringify(input)}`,
  },
  async execute(input, ctx) {
    return manageTriggers(db(), input, {
      auth: ctx.session.auth.current,
      sessionId: ctx.session.id,
      callId: ctx.callId,
    });
  },
});
