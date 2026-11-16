import { Mascot } from "@/web/components/mascot";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Only same-site relative paths are honored as post-sign-in destinations.
  const destination = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
  return (
    <main className="shell" style={{ maxWidth: 420 }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <Mascot size={88} />
        <h1>Sign in to Pidge</h1>
        <p className="muted">Accounts are created by the owner. There is no public sign-up.</p>
      </div>
      <div className="panel">
        <SignInForm destination={destination} />
      </div>
    </main>
  );
}
