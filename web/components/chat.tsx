"use client";

import { openConversationInputs, useEveAgent } from "eve/react";
import { useState } from "react";
import { Mascot } from "./mascot";

async function fetchToken(sessionId: string): Promise<string> {
  const response = await fetch("/api/chat/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Not allowed to open this conversation.");
  const { token } = (await response.json()) as { token: string };
  return token;
}

export function Chat({ sessionId }: { sessionId: string }) {
  const [draft, setDraft] = useState("");
  const agent = useEveAgent({
    initialSession: { sessionId, streamIndex: 0 },
    resume: true,
    auth: { bearer: () => fetchToken(sessionId) },
  });
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const resuming = agent.status === "resuming";
  const pending = openConversationInputs(agent.data).map((input) => input.request);

  return (
    <section className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Mascot size={40} mood={agent.status === "error" ? "lost" : busy ? "out" : "home"} />
        <strong>
          {agent.status === "error"
            ? "Pidge got lost"
            : busy
              ? "Pidge is out…"
              : resuming
                ? "Loading conversation…"
                : "Pidge is home"}
        </strong>
        {busy ? (
          <button type="button" className="secondary" onClick={() => void agent.cancel()}>
            Stop
          </button>
        ) : null}
      </div>
      {agent.error ? <p className="status-bad">{agent.error.message}</p> : null}

      <div className="chat-log">
        {agent.data.messages.map((message) =>
          message.parts.map((part, index) => {
            const key = `${message.id}:${index}`;
            if (part.type === "text") {
              return (
                <div key={key} className={`bubble ${message.role === "user" ? "user" : "assistant"}`}>
                  {part.text}
                </div>
              );
            }
            if (part.type === "dynamic-tool") {
              return (
                <div key={key} className="tool-note">
                  ⚙︎ {part.toolName} · {part.state}
                </div>
              );
            }
            return null;
          }),
        )}
      </div>

      {pending.map((request) => (
        <div key={request.requestId} className="approval">
          <strong>{request.kind === "tool-approval" ? "Approval needed" : "Pidge has a question"}</strong>
          <p>{request.prompt}</p>
          <div style={{ display: "flex", gap: 8 }}>
            {request.options?.map((option) => (
              <button
                key={option.id}
                type="button"
                className={option.id === "approve" ? undefined : "secondary"}
                disabled={resuming}
                onClick={() => void agent.respond([{ requestId: request.requestId, optionId: option.id }])}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (text.length === 0 || resuming) return;
          setDraft("");
          void agent.send(text, busy ? { turnPolicy: "steer" } : undefined);
        }}
      >
        <input
          aria-label="Message Pidge"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={busy ? "Add a correction…" : "Send Pidge on an errand…"}
          disabled={resuming}
        />
        <button type="submit" disabled={resuming || draft.trim().length === 0}>
          Send
        </button>
      </form>
    </section>
  );
}
