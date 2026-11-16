import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { deleteSchedule, listSchedules, updateSchedule } from "@/db/services/schedules";
import { formatLocal } from "@/shared/schedules/recurrence";
import { requireUser } from "@/web/auth/server";
import { Mascot } from "@/web/components/mascot";

async function setEnabled(formData: FormData) {
  "use server";
  const user = await requireUser("/schedules");
  await updateSchedule(db(), user.id, String(formData.get("id")), { enabled: formData.get("enabled") === "true" });
  revalidatePath("/schedules");
}

async function remove(formData: FormData) {
  "use server";
  const user = await requireUser("/schedules");
  await deleteSchedule(db(), user.id, String(formData.get("id")));
  revalidatePath("/schedules");
}

const runLabel: Record<string, string> = {
  leased: "Pidge is out",
  reporting: "Pidge is out",
  completed: "Pidge is back",
  failed: "Pidge got lost",
  suppressed: "Not delivered",
};

function cadence(job: { kind: string; cron: string | null; everyMinutes: number | null; timezone: string }) {
  if (job.kind === "once") return "One time";
  if (job.kind === "interval") return `Every ${job.everyMinutes} minutes`;
  return `Cron ${job.cron} (${job.timezone})`;
}

export default async function SchedulesPage() {
  const user = await requireUser("/schedules");
  const jobs = await listSchedules(db(), user.id);
  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>Schedules</h2>
      {jobs.length === 0 ? (
        <div style={{ textAlign: "center" }}>
          <Mascot size={64} />
          <p className="muted">
            No schedules yet. Text Pidge something like “Text me tomorrow afternoon with the details.”
          </p>
        </div>
      ) : (
        jobs.map((job) => (
          <article key={job.id} className="panel">
            <strong>{job.title}</strong>{" "}
            <span className="muted">
              · {cadence(job)} · {job.enabled ? "active" : "paused"}
            </span>
            <p style={{ whiteSpace: "pre-wrap" }}>{job.instruction}</p>
            <p className="muted">
              {job.nextRunAt
                ? `Next: ${formatLocal(job.nextRunAt, job.timezone)}`
                : job.kind === "once"
                  ? "Already ran"
                  : "No upcoming run"}
            </p>
            {job.runs.length > 0 ? (
              <ul>
                {job.runs.map((run) => (
                  <li key={run.id}>
                    {formatLocal(run.scheduledFor, job.timezone)}: {runLabel[run.status] ?? run.status}
                    {run.outcome ? <span className="muted"> · {run.outcome}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <div style={{ display: "flex", gap: 8 }}>
              {job.kind !== "once" || job.nextRunAt ? (
                <form action={setEnabled}>
                  <input type="hidden" name="id" value={job.id} />
                  <input type="hidden" name="enabled" value={job.enabled ? "false" : "true"} />
                  <button type="submit">{job.enabled ? "Pause" : "Resume"}</button>
                </form>
              ) : null}
              <form action={remove}>
                <input type="hidden" name="id" value={job.id} />
                <button type="submit">Delete</button>
              </form>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
