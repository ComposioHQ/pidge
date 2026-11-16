import Link from "next/link";
import { Mascot } from "@/web/components/mascot";

export const dynamic = "force-dynamic";

export default async function ConnectionCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; appName?: string }>;
}) {
  const { status, appName } = await searchParams;
  const failed = status !== undefined && status !== "success";
  return (
    <main className="shell" style={{ maxWidth: 520, textAlign: "center" }}>
      <Mascot size={80} mood={failed ? "lost" : "home"} />
      <h1>{failed ? "Connection didn't finish" : "Connected"}</h1>
      <p>
        {failed
          ? "Nothing was connected. You can try again from the Connect Link or your Connections page."
          : `${appName ? `${appName} is` : "Your app is"} connected. Go back to your conversation and tell Pidge to continue.`}
      </p>
      <p>
        <Link href="/connections">Connections</Link>
      </p>
    </main>
  );
}
