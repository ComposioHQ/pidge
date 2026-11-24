import { defineMemory } from "eve/memory";
import { memoryScope, pidgeMemory } from "./lib/memory/provider";

/** One memory slot per authenticated Pidge user, stored in PostgreSQL (docs/decisions.md D17). Tools: memory__*. */
export default defineMemory({
  description: "Pidge's long-term memory of the signed-in person.",
  provider: pidgeMemory,
  scope: memoryScope,
});
