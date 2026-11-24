import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { modelDreamer } from "@/agent/lib/memory/dream";
import { db } from "@/db/client";
import {
  consolidateMemory,
  correctMemory,
  forgetAllMemory,
  forgetMemory,
  listMemory,
  type MemoryView,
  saveMemory,
  searchMemory,
} from "@/db/services/memory";
import { requireUser } from "@/web/auth/server";

function done(error?: string): never {
  revalidatePath("/memory");
  redirect(error ? `/memory?error=${encodeURIComponent(error)}` : "/memory");
}

async function add(formData: FormData) {
  "use server";
  const user = await requireUser("/memory");
  const saved = await saveMemory(db(), user.id, {
    content: String(formData.get("content") ?? ""),
    tier: "fact",
    origin: "explicit",
    channel: "web",
  });
  done(saved.ok ? undefined : saved.error);
}

async function correct(formData: FormData) {
  "use server";
  const user = await requireUser("/memory");
  const fixed = await correctMemory(db(), user.id, String(formData.get("id")), String(formData.get("content") ?? ""), {
    channel: "web",
  });
  done(fixed.ok ? undefined : fixed.error);
}

async function forget(formData: FormData) {
  "use server";
  const user = await requireUser("/memory");
  await forgetMemory(db(), user.id, String(formData.get("id")));
  done();
}

async function forgetAll() {
  "use server";
  const user = await requireUser("/memory");
  await forgetAllMemory(db(), user.id);
  done();
}

async function dreamNow() {
  "use server";
  const user = await requireUser("/memory");
  try {
    await consolidateMemory(db(), user.id, await modelDreamer(db(), user.id));
  } catch {
    done("Dreaming failed. Your notes are unchanged; try again later.");
  }
  done();
}

function origin(item: MemoryView) {
  if (item.tier === "note") return item.status === "consolidated" ? "Note · dreamed" : "Note · waiting for dreaming";
  if (item.origin === "explicit") return "You said";
  return item.sourceIds.length ? `Inferred from ${item.sourceIds.length} note(s)` : "Inferred";
}

function Meta({ item }: { item: MemoryView }) {
  return (
    <span className="muted">
      {origin(item)} · {item.createdAt.toLocaleDateString()}
      {item.channel ? ` · ${item.channel === "imessage" ? "iMessage" : "web"}` : ""}
    </span>
  );
}

function ForgetButton({ id }: { id: string }) {
  return (
    <form action={forget}>
      <input type="hidden" name="id" value={id} />
      <button type="submit">Forget</button>
    </form>
  );
}

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; error?: string; offset?: string }>;
}) {
  const user = await requireUser("/memory");
  const { q = "", error, offset: rawOffset = "0" } = await searchParams;
  const offset = Math.max(0, Math.min(100000, Number.parseInt(rawOffset, 10) || 0));
  const [{ facts, notes, pending }, results] = await Promise.all([
    listMemory(db(), user.id, offset),
    q.trim() ? searchMemory(db(), user.id, q, { limit: 25 }) : Promise.resolve(null),
  ]);
  return (
    <>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Memory</h2>
        <p className="muted">
          Pidge reads your long-term facts at the start of every conversation and searches notes when they look
          relevant. Each night around 3 a.m. your time, it condenses new notes into facts (“dreaming”). Forgetting
          erases the text here and anything built from it, but not past conversation history or provider logs.
          Don&apos;t store secrets.
        </p>
        {error ? <p className="status-bad">{error}</p> : null}
        <form method="get" style={{ display: "flex", gap: 8 }}>
          <input name="q" defaultValue={q} placeholder="Search memory" maxLength={200} />
          <button type="submit">Search</button>
        </form>
        {results ? (
          results.length === 0 ? (
            <p className="muted">Nothing matches.</p>
          ) : (
            <ul>
              {results.map((item) => (
                <li key={item.id}>
                  {item.content} <Meta item={item} /> <ForgetButton id={item.id} />
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      <section className="panel">
        <h3 style={{ marginTop: 0 }}>Long-term facts ({facts.length})</h3>
        <form action={add} style={{ display: "flex", gap: 8 }}>
          <input name="content" placeholder="Add a fact, e.g. Prefers aisle seats." maxLength={500} required />
          <button type="submit">Add</button>
        </form>
        {facts.map((fact) => (
          <article key={fact.id} className="panel">
            <form action={correct} style={{ display: "flex", gap: 8 }}>
              <input type="hidden" name="id" value={fact.id} />
              <input name="content" defaultValue={fact.content ?? ""} maxLength={500} required aria-label="Fact" />
              <button type="submit">Correct</button>
            </form>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <Meta item={fact} />
              <ForgetButton id={fact.id} />
            </div>
          </article>
        ))}
      </section>

      <section className="panel">
        <h3 style={{ marginTop: 0 }}>Notes</h3>
        <p className="muted">
          Things Pidge noticed. {pending} waiting for dreaming. Showing {offset + 1}–{offset + notes.length}.
        </p>
        <form action={dreamNow}>
          <button type="submit" disabled={pending === 0}>
            Dream now
          </button>
        </form>
        <ul>
          {notes.map((note) => (
            <li key={note.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>
                {note.content} <Meta item={note} />
              </span>
              <ForgetButton id={note.id} />
            </li>
          ))}
        </ul>
        {offset > 0 ? <a href={`/memory?offset=${Math.max(0, offset - 100)}`}>Newer notes</a> : null}{" "}
        {notes.length === 100 ? <a href={`/memory?offset=${offset + 100}`}>Older notes</a> : null}
      </section>

      <section className="panel">
        <form action={forgetAll}>
          <button type="submit">Forget everything</button>
        </form>
      </section>
    </>
  );
}
