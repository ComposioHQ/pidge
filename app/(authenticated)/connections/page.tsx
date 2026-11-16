import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { disconnect, listConnections, startConnection } from "@/agent/lib/composio/connections";
import { db } from "@/db/client";
import { listRecentActions } from "@/db/services/audit";
import { requireUser } from "@/web/auth/server";

async function connect(formData: FormData) {
  "use server";
  const user = await requireUser("/connections");
  const url = await startConnection(
    user.id,
    String(formData.get("toolkit") ?? ""),
    String(formData.get("alias") ?? ""),
  );
  redirect(url);
}

async function remove(formData: FormData) {
  "use server";
  const user = await requireUser("/connections");
  await disconnect(user.id, String(formData.get("id") ?? ""));
  revalidatePath("/connections");
}

export default async function ConnectionsPage() {
  const user = await requireUser("/connections");
  let connections: Awaited<ReturnType<typeof listConnections>> | null = null;
  try {
    connections = await listConnections(user.id);
  } catch {
    connections = null;
  }
  const actions = await listRecentActions(db(), user.id, 20);
  return (
    <>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Connected apps</h2>
        <p className="muted">
          Pidge can reach any app in the Composio catalog. When you ask for one you haven&apos;t connected, Pidge sends
          a Connect Link. Credentials stay with Composio; Pidge never stores them.
        </p>
        {connections === null ? (
          <p className="status-bad">Couldn&apos;t reach Composio right now.</p>
        ) : connections.length === 0 ? (
          <p className="muted">No apps connected yet.</p>
        ) : (
          <table>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id}>
                  <td>{connection.toolkit}</td>
                  <td>{connection.alias ?? <span className="muted">no alias</span>}</td>
                  <td className={connection.status === "ACTIVE" ? "status-ok" : "status-bad"}>{connection.status}</td>
                  <td>
                    <form action={connect} style={{ display: "inline" }}>
                      <input type="hidden" name="toolkit" value={connection.toolkit} />
                      <input type="hidden" name="alias" value={connection.alias ?? ""} />
                      <button type="submit" className="secondary">
                        Reconnect
                      </button>
                    </form>{" "}
                    <form action={remove} style={{ display: "inline" }}>
                      <input type="hidden" name="id" value={connection.id} />
                      <button type="submit" className="danger">
                        Disconnect
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Connect an app</h2>
        <form action={connect}>
          <label>
            App (Composio toolkit slug, e.g. slack, gmail, notion, linear)
            <input name="toolkit" required pattern="[a-z0-9_]{2,64}" />
          </label>
          <label>
            Alias (optional, e.g. work or personal; needed when you connect more than one account)
            <input name="alias" maxLength={40} />
          </label>
          <button type="submit">Get Connect Link</button>
        </form>
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Recent app actions</h2>
        {actions.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table>
            <tbody>
              {actions.map((action) => (
                <tr key={`${action.toolSlug}-${action.createdAt.toISOString()}`}>
                  <td>{action.toolSlug}</td>
                  <td className="muted">{action.risk}</td>
                  <td>{action.approval === "required" ? "approved" : "no approval needed"}</td>
                  <td className={action.outcome === "completed" ? "status-ok" : "status-bad"}>{action.outcome}</td>
                  <td className="muted">{action.createdAt.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
