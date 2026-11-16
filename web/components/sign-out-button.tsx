"use client";

import { authClient } from "@/web/auth/client";

export function SignOutButton() {
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        await authClient.signOut();
        window.location.assign("/sign-in");
      }}
    >
      Sign out
    </button>
  );
}
