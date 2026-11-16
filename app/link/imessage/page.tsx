import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { consumeLinkToken } from "@/db/services/identity";
import { maskHandle } from "@/shared/identity/handles";
import { requireUser } from "@/web/auth/server";
import { Mascot } from "@/web/components/mascot";

export const dynamic = "force-dynamic";

const failures: Record<string, string> = {
  invalid: "This link isn't valid. Text Pidge again to get a new one.",
  expired: "This link expired. Text Pidge again to get a new one.",
  consumed: "This link was already used.",
  already_bound: "That number is already linked to a Pidge account.",
  conversation_mismatch: "That conversation belongs to a different account.",
};

async function linkAction(formData: FormData) {
  "use server";
  const user = await requireUser("/link/imessage");
  const token = String(formData.get("token") ?? "");
  const result = await consumeLinkToken(db(), { token, userId: user.id });
  redirect(
    result.ok
      ? `/link/imessage?done=${encodeURIComponent(maskHandle(result.normalizedHandle))}`
      : `/link/imessage?error=${result.reason}`,
  );
}

export default async function LinkImessagePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string; error?: string }>;
}) {
  const params = await searchParams;
  const returnTo = params.token ? `/link/imessage?token=${encodeURIComponent(params.token)}` : "/link/imessage";
  const user = await requireUser(returnTo);

  return (
    <main className="shell" style={{ maxWidth: 520 }}>
      <div style={{ textAlign: "center" }}>
        <Mascot size={80} mood={params.error ? "lost" : "home"} />
        <h1>Link iMessage</h1>
      </div>
      <div className="panel">
        {params.done ? (
          <>
            <p className="status-ok">
              Linked {params.done} to {user.email}.
            </p>
            <p>Text Pidge again to start. Pidge won't act on anything you sent before linking.</p>
          </>
        ) : params.error ? (
          <p className="status-bad">{failures[params.error] ?? "Linking failed."}</p>
        ) : params.token ? (
          // Linking needs an explicit POST; opening the link (or a link preview fetching it) changes nothing.
          <form action={linkAction}>
            <input type="hidden" name="token" value={params.token} />
            <p>
              Link the iMessage number that received this link to <strong>{user.email}</strong>?
            </p>
            <button type="submit">Link this number</button>
          </form>
        ) : (
          <p className="muted">Text Pidge from your phone to get a link.</p>
        )}
      </div>
    </main>
  );
}
