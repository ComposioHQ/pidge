import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { getBinding } from "@/db/services/conversations";
import { requireUser } from "@/web/auth/server";
import { Chat } from "@/web/components/chat";

export default async function ChatPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const user = await requireUser(`/chat/${encodeURIComponent(sessionId)}`);
  const binding = await getBinding(db(), sessionId);
  // Ownership is checked here and again by the agent's channel auth on every request (spec §7.4).
  if (!binding || binding.userId !== user.id || binding.channel !== "web") notFound();
  return <Chat key={sessionId} sessionId={sessionId} />;
}
