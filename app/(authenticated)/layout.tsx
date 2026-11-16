import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/web/auth/server";
import { Mascot } from "@/web/components/mascot";
import { SignOutButton } from "@/web/components/sign-out-button";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const user = await requireUser("/");
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <Mascot size={36} /> Pidge
        </Link>
        <nav>
          <Link href="/chat">Chat</Link>
          <Link href="/connections">Connections</Link>
          <Link href="/tasks">Tasks</Link>
          <Link href="/schedules">Schedules</Link>
          <Link href="/personal-info">Personal info</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        <span className="muted">{user.email}</span>
        <SignOutButton />
      </header>
      {children}
    </div>
  );
}
