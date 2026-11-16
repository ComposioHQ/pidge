import { defineAgent, defineDynamic } from "eve";
import { db } from "../db/client";
import { getSettings } from "../db/services/settings";
import { env } from "../shared/environment/env";
import { readPrincipal } from "./lib/identity/principal";

export default defineAgent({
  // spec §10.1: the model comes from the authenticated user's settings before each model call.
  model: defineDynamic({
    events: {
      async "step.started"(_event, ctx) {
        const principal = readPrincipal(ctx.session.auth.current);
        const chosen = principal ? (await getSettings(db(), principal.userId))?.model : null;
        return chosen ?? env().PIDGE_DEFAULT_MODEL;
      },
    },
  }),
  // Pidge authors every tool it offers; no sandbox shell or file tools.
  defaultTools: false,
  // Keep the Composio provider out of eve's dynamic-tool transform (docs/spike.md F1, docs/decisions.md D2).
  build: { externalDependencies: ["@composio/experimental"] },
});
