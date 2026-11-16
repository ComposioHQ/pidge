// Creates the first Pidge account with the `owner` role from the server console (spec §7.2).
// Usage: pnpm setup:owner --email you@example.com --name "Your Name"
// The password is read from the OWNER_PASSWORD environment variable, or prompted for on a TTY.
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createOwner } from "@/db/services/accounts";
import { auth } from "@/web/auth/server";

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
if (!values.email || !values.name) {
  console.error('usage: pnpm setup:owner --email you@example.com --name "Your Name"');
  process.exit(2);
}

async function readPassword(): Promise<string> {
  if (process.env.OWNER_PASSWORD) return process.env.OWNER_PASSWORD;
  if (!process.stdin.isTTY) throw new Error("Set OWNER_PASSWORD or run on a TTY.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const muted = rl as unknown as { _writeToOutput: (s: string) => void };
  muted._writeToOutput = () => {};
  process.stdout.write("Owner password (min 12 chars): ");
  const password = await rl.question("");
  rl.close();
  process.stdout.write("\n");
  return password;
}

const password = await readPassword();
const result = await createOwner(await auth().$context, {
  email: values.email,
  name: values.name,
  password,
});
if (!result.ok) {
  console.error(`Owner not created: ${result.reason}`);
  process.exit(1);
}
console.log(`Owner created: ${result.userId}`);
process.exit(0);
