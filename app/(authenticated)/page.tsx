import { sql } from "drizzle-orm";
import Link from "next/link";
import { listConnections } from "@/agent/lib/composio/connections";
import { db } from "@/db/client";
import { listIdentities } from "@/db/services/identity";
import { getSettings } from "@/db/services/settings";
import { env } from "@/shared/environment/env";
import { requireUser } from "@/web/auth/server";

async function databaseReady(): Promise<boolean> {
  try {
    await db().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export default async function HomePage() {
  const user = await requireUser("/");
  const [dbOk, settings, identities, connections] = await Promise.all([
    databaseReady(),
    getSettings(db(), user.id),
    listIdentities(db(), user.id),
    listConnections(user.id).catch(() => null),
  ]);
  const config = env();

  return (
    <>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Hi {user.name.split(" ")[0]}, Pidge is home.</h1>
        <p className="muted">
          Text Pidge on iMessage or start a web chat. Send Pidge out on an errand and it flies back.
        </p>
        <Link className="button" href="/chat">
          Send Pidge
        </Link>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Readiness</h2>
        <table>
          <tbody>
            <tr>
              <td>Database</td>
              <td className={dbOk ? "status-ok" : "status-bad"}>{dbOk ? "Connected (checked now)" : "Unreachable"}</td>
            </tr>
            <tr>
              <td>iMessage (Photon)</td>
              <td className="status-config">
                Configured: project credentials and webhook secret set. Webhook: <code>/eve/v1/photon</code>
              </td>
            </tr>
            <tr>
              <td>Your iMessage</td>
              <td className={identities.length > 0 ? "status-ok" : "status-bad"}>
                {identities.length > 0
                  ? `${identities.length} handle${identities.length > 1 ? "s" : ""} linked`
                  : "Not linked yet: text Pidge to get a link"}
              </td>
            </tr>
            <tr>
              <td>Apps (Composio)</td>
              <td className={connections ? "status-ok" : "status-bad"}>
                {connections
                  ? `Reachable (checked now): ${connections.filter((c) => c.status === "ACTIVE").length} app account(s) connected`
                  : "Unreachable"}{" "}
                · <Link href="/connections">manage</Link>
              </td>
            </tr>
            <tr>
              <td>Model</td>
              <td>
                {settings?.model ?? `${config.PIDGE_DEFAULT_MODEL} (deployment default)`} ·{" "}
                <Link href="/settings">change</Link>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          “Configured” rows reflect configuration only; they are not live checks of the external service.
        </p>
      </section>
    </>
  );
}
