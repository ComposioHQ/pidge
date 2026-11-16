import { db } from "@/db/client";
import { listBrowserTasks } from "@/db/services/browser-tasks";
import { requireUser } from "@/web/auth/server";
import { Mascot } from "@/web/components/mascot";

const label: Record<string, string> = {
  running: "Pidge is out",
  completed: "Pidge is back",
  failed: "Pidge got lost",
  stopped: "Stopped",
};

export default async function TasksPage() {
  const user = await requireUser("/tasks");
  const tasks = await listBrowserTasks(db(), user.id);
  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>Browser errands</h2>
      {tasks.length === 0 ? (
        <div style={{ textAlign: "center" }}>
          <Mascot size={64} />
          <p className="muted">No errands yet. Ask Pidge to check a booking site or find a table.</p>
        </div>
      ) : (
        tasks.map((task) => (
          <article key={task.id} className="panel">
            <strong>{label[task.status] ?? task.status}</strong>{" "}
            <span className="muted">· {task.createdAt.toLocaleString()}</span>
            <p>{task.summary}</p>
            <p className="muted">Runs: {task.runs.map((run) => `${run.mode} (${run.status})`).join(" → ") || "none"}</p>
            {task.outcome ? <p style={{ whiteSpace: "pre-wrap" }}>{task.outcome}</p> : null}
            {task.artifacts.length > 0 ? (
              <ul>
                {task.artifacts.map((file) => (
                  <li key={file.id}>
                    <a href={`/artifacts/${file.id}`}>{file.filename}</a>
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        ))
      )}
    </section>
  );
}
