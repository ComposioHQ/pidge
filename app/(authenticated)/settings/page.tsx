import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { listIdentities, unlinkIdentity } from "@/db/services/identity";
import { getSettings, isValidTimeZone, updateSettings } from "@/db/services/settings";
import { env } from "@/shared/environment/env";
import { maskHandle } from "@/shared/identity/handles";
import { requireUser } from "@/web/auth/server";

const MODEL_ID = /^[a-z0-9-]+\/[a-z0-9.\-_]+$/i;

async function saveSettings(formData: FormData) {
  "use server";
  const user = await requireUser("/settings");
  const model = String(formData.get("model") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();
  if (model && !MODEL_ID.test(model)) throw new Error("Model must be an AI Gateway ID like provider/model.");
  if (!isValidTimeZone(timezone)) throw new Error("Unknown time zone.");
  await updateSettings(db(), user.id, { model: model || null, timezone });
  revalidatePath("/settings");
}

async function unlink(formData: FormData) {
  "use server";
  const user = await requireUser("/settings");
  await unlinkIdentity(db(), { userId: user.id, identityId: String(formData.get("identityId") ?? "") });
  revalidatePath("/settings");
}

export default async function SettingsPage() {
  const user = await requireUser("/settings");
  const [settings, identities] = await Promise.all([getSettings(db(), user.id), listIdentities(db(), user.id)]);
  return (
    <>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Assistant</h2>
        <form action={saveSettings}>
          <label>
            Model (AI Gateway ID; blank uses the deployment default <code>{env().PIDGE_DEFAULT_MODEL}</code>)
            <input name="model" defaultValue={settings?.model ?? ""} placeholder={env().PIDGE_DEFAULT_MODEL} />
          </label>
          <label>
            Time zone (IANA, e.g. America/Los_Angeles)
            <input name="timezone" defaultValue={settings?.timezone ?? "UTC"} required />
          </label>
          <button type="submit">Save</button>
        </form>
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Linked iMessage handles</h2>
        {identities.length === 0 ? (
          <p className="muted">None yet. Text Pidge to get a link.</p>
        ) : (
          <table>
            <tbody>
              {identities.map((identity) => (
                <tr key={identity.id}>
                  <td>{maskHandle(identity.normalizedHandle)}</td>
                  <td className="muted">linked {identity.verifiedAt.toLocaleDateString()}</td>
                  <td>
                    <form action={unlink}>
                      <input type="hidden" name="identityId" value={identity.id} />
                      <button type="submit" className="danger">
                        Unlink
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Unlinking stops Pidge from replying to or messaging that number. It does not delete your account or app
          connections.
        </p>
      </section>
    </>
  );
}
