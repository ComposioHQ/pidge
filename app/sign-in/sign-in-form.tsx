"use client";

import { useState } from "react";
import { authClient } from "@/web/auth/client";

export function SignInForm({ destination }: { destination: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setPending(true);
        setError(null);
        const { error: failure } = await authClient.signIn.email({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        });
        setPending(false);
        if (failure) {
          setError("That email and password didn't match.");
          return;
        }
        window.location.assign(destination);
      }}
    >
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required minLength={12} />
      </label>
      {error ? <p className="status-bad">{error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
