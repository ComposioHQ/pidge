import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { getPersonalInfo, savePersonalInfo } from "@/db/services/personal-info";
import { requireUser } from "@/web/auth/server";

async function save(formData: FormData) {
  "use server";
  const user = await requireUser("/personal-info");
  await savePersonalInfo(db(), user.id, {
    fullName: String(formData.get("fullName") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    homeArea: String(formData.get("homeArea") ?? ""),
  });
  revalidatePath("/personal-info");
}

export default async function PersonalInfoPage() {
  const user = await requireUser("/personal-info");
  const info = await getPersonalInfo(db(), user.id);
  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>Personal info</h2>
      <p className="muted">
        Pidge attaches your name, phone, and email only to bookings you approve (for example a guest restaurant
        reservation). Don&apos;t put passwords, card numbers, or other secrets here.
      </p>
      <form action={save}>
        <label>
          Full name
          <input name="fullName" defaultValue={info?.fullName ?? ""} maxLength={120} autoComplete="name" />
        </label>
        <label>
          Email
          <input name="email" type="email" defaultValue={info?.email ?? ""} maxLength={200} autoComplete="email" />
        </label>
        <label>
          Phone
          <input name="phone" type="tel" defaultValue={info?.phone ?? ""} maxLength={40} autoComplete="tel" />
        </label>
        <label>
          Home area (optional, e.g. Mission District, San Francisco)
          <input name="homeArea" defaultValue={info?.homeArea ?? ""} maxLength={120} />
        </label>
        <button type="submit">Save</button>
      </form>
    </section>
  );
}
