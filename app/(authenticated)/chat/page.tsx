import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { listConversations } from "@/db/services/conversations";
import { requireUser } from "@/web/auth/server";
import { createWebConversation } from "@/web/eve/sessions";

async function startChat() {
  "use server";
  const user = await requireUser("/chat");
  const sessionId = await createWebConversation(user.id);
  redirect(`/chat/${encodeURIComponent(sessionId)}`);
}

export default async function ChatListPage() {
  const user = await requireUser("/chat");
  const conversations = await listConversations(db(), user.id);
  return (
    <>
      <section className="panel">
        <form action={startChat}>
          <button type="submit">Send Pidge (new chat)</button>
        </form>
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Conversations</h2>
        {conversations.length === 0 ? (
          <p className="muted">No conversations yet.</p>
        ) : (
          <table>
            <tbody>
              {conversations.map((conversation) => (
                <tr key={conversation.eveSessionId}>
                  <td>{conversation.channel === "imessage" ? "iMessage" : "Web"}</td>
                  <td>
                    {conversation.channel === "web" ? (
                      <Link href={`/chat/${encodeURIComponent(conversation.eveSessionId)}`}>
                        {conversation.title ?? "Web chat"}
                      </Link>
                    ) : (
                      (conversation.title ?? "iMessage conversation")
                    )}
                  </td>
                  <td className="muted">{conversation.updatedAt.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
