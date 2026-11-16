# Contribute to Pidge

Pidge is experimental. Keep changes small and explain the user-visible behavior. Read [current scope](README.md#current-limits) and [decisions](docs/decisions.md) before implementing a feature from the wider spec.

## Run the checks

Install Node 24, pnpm 12.15.0, Docker, and ImageMagick with an HEVC decoder (Ubuntu: `imagemagick libheif-plugin-libde265`) for the photo tests. Use a disposable local database. The example Compose credentials are for local development only.

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait postgres
export TEST_DATABASE_URL=postgres://pidge:pidge@127.0.0.1:5432/pidge_test
pnpm check
pnpm build
pnpm release:check
```

**Tests delete the database named by `TEST_DATABASE_URL`, recreate it, and apply migrations.** Never point that variable at an application or production database. The test role needs permission to create and drop that disposable database. The default is `pidge_test` on localhost port 5432. If port 5432 already serves another PostgreSQL instance, use a separate disposable instance and change the URL before running tests.

`pnpm check` runs typecheck, Biome lint, and Vitest. Tests inject fictional runtime settings and use mocked vendor calls. The build needs no live credentials. Do not copy a production `.env.local` to run these checks. CI runs the same commands with a disposable PostgreSQL 17 service and no provider secrets.

If formatting fails, run `pnpm format` and inspect its diff. Commit `pnpm-lock.yaml` with dependency changes. Keep the Eve/Composio compatibility pins and Undici override unless you also verify the provider behavior listed in D2.

## Prepare a change

Add a focused regression test for behavior or security fixes. For changes that reach real services, explain which account you used and summarize the result without identifiers or message contents. Use your own test accounts, harmless reads, and explicit approvals for writes.

Do not commit `.env.local`, database dumps, local workflow stores, generated builds, raw message logs, or real auth links. Replace personal details with fictional examples. Review the staged diff before committing. The release check scans tracked release files and is a guard against known leaks, not proof that every secret pattern is detectable.

In a pull request, state the problem, the resulting behavior, and which checks passed. Call out unverified live behavior. Do not promise completion of Phase 5/6 features from the spec.

## Report problems

For ordinary bugs, include reproduction steps, dependency versions, and sanitized error text. Keep private conversations and account identifiers out of screenshots and logs. Never file an exploitable security issue publicly. Use the private Composio reporting contact in [SECURITY.md](SECURITY.md).
