# Pidge: Trust Instinct

<img src="public/pidge.svg" width="72" alt="Pidge the homing pigeon" align="right" />

Pidge is a self-hosted personal assistant you text over iMessage or use through web chat. It can read connected apps, research public websites, attempt guest browser errands, and send scheduled iMessage reports.

**Experimental.** Pidge is a working experiment, with incomplete features and no production support or availability guarantee. It can make mistakes and perform real actions in your accounts. Start with test accounts, review every approval, and set provider spending limits before connecting important data.

## How it fits together

- [Eve](https://eve.dev) runs the agent, conversations, approvals, and durable execution.
- Photon Stable / Spectrum Cloud connects iMessage directly through Eve's official Photon channel at `/eve/v1/photon`. Composio is outside that messaging path.
- Composio Sessions discovers app tools, connects each user's accounts, and executes app actions. Pidge uses `@composio/experimental/eve`.
- Pidge's `run_browser` tool uses Composio's hosted `browser_tool`, billed through Composio Instant. It supports guest errands, with a 25-step provider bound. That bound is not a dollar spending cap.
- Next.js serves web chat and Better Auth email/password login. PostgreSQL stores application data. A minute dispatcher starts iMessage schedule runs.
- Vercel AI Gateway supplies models and Exa public web search.

Eve is pinned to `0.83.3` because the pinned Composio Eve provider uses the older `defineDynamic({ events })` API. Eve `0.84.0` changed that API. Upgrading Eve alone breaks the integration. The provider also stays external to Eve's build to preserve its tool behavior. See [decision D2](docs/decisions.md#d2-pin-eve0833-not-the-latest-eve) for the evidence and upgrade checks. An Undici `8.12.2` override patches Eve's HTTP dependency without changing the Eve API.

## Run it

Use Node 24, pnpm 12.15.0, Docker, and an always-on host with persistent disk. Live use also requires your own Photon Stable line, Composio project, and AI Gateway key. Installing dependencies and running automated tests needs none of those vendor credentials. iPhone HEIC photos need ImageMagick with an HEVC decoder on the Node host; on Ubuntu 24.04 install `imagemagick libheif-plugin-libde265`.

Follow [Set up Pidge](docs/setup.md) for account provisioning, environment variables, database setup, HTTPS, and deployment. The shortest local start after you configure `.env.local` is:

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait postgres
pnpm db:migrate
pnpm setup:owner --email you@example.com --name "Your Name"
pnpm build
pnpm start
```

Public sign-up is disabled. Text your configured Photon line, follow its single-use linking URL, sign in with the owner account, and send a new message after linking.

## Current limits

- Run exactly one app process. PostgreSQL, artifacts, and Eve's local workflow store must survive restarts. Ephemeral hosting and multiple replicas are unsupported.
- Owner setup is through the server console. Invitations, general multi-user onboarding, app triggers, account deletion/export, and the Phase 5/6 work in the original spec are deferred.
- iMessage supports direct conversations. Group chats are rejected. HEIC photos are converted to JPEG (primary still only). Images over 3 MiB or 8,000 pixels per side, and videos (including Live Photo motion), are rejected with a note asking for a smaller copy or a description.
- Schedules deliver through iMessage. Missed occurrences coalesce after downtime. Approval parked before a restart fails closed and needs a new request.
- Browser errands support guest flows. Signed-in browser vaults, 1Password, and the original Browser Use cost ledger are deferred. Some sites block hosted browsers or need manual verification.
- Third-party writes and notification delivery have no universal exactly-once guarantee. After an ambiguous failure, check the destination before retrying.
- `pnpm audit` reports one moderate advisory ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) in the `esbuild@0.18` that `drizzle-kit` uses for migrations tooling. It affects esbuild's development server, which Pidge never starts. The latest stable `drizzle-kit` still depends on it.

[The spec](docs/spec.md) describes the wider design. [Decisions](docs/decisions.md) records what changed. Sanitized [spike findings](docs/spike.md) and [MVP verification](docs/mvp-verification.md) are historical evidence, not guarantees for new accounts. Use the [independent release rehearsal](docs/release-rehearsal.md) to validate your deployment.

## Optional owner notifications

Set `PIDGE_NOTIFY_TOKEN` to a random bearer token to let a trusted service send the owner a message. Leave it unset to disable both notification paths. The token grants owner messaging access. Keep it in server configuration and an authorization header, never in a URL or client code.

```sh
curl -X POST https://pidge.example.com/api/notify \
  -H "Authorization: Bearer $PIDGE_NOTIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Your report is ready","idempotencyKey":"example-report-1"}'
```

Text is limited to 2,000 characters and request bodies to 16 KiB. Responses are 202 for accepted handoff, 200 for a duplicate key, 400 for invalid JSON or text, 401 for a bad token, 404 when disabled, 409 when the owner has no linked destination, 413 for an oversized body, and 502 for a failed handoff. A 202 is not delivery confirmation. Duplicate keys are remembered in one process for 24 hours, up to 1,000 keys, and disappear on restart. See [D14](docs/decisions.md#d14-optional-owner-notifications-use-eves-proactive-hand-off-without-a-model-call).

## Contribute

[CONTRIBUTING.md](CONTRIBUTING.md) explains the disposable test database and checks. Never put credentials, Connect Links, personal messages, or production logs in an issue or pull request. Report security issues privately through [SECURITY.md](SECURITY.md).

## Where your data goes

- Photon carries iMessage text and attachments through its managed infrastructure.
- AI Gateway and the selected model provider receive conversation content, instructions, and tool results. Exa receives web search queries.
- Composio holds connected app credentials and executes app actions. Its hosted browser receives errand instructions and, for an approved guest booking, contact fields from Personal info.
- Your server stores accounts, identity links, personal info, conversation bindings, browser task records, schedules, action metadata, and artifacts. Eve stores conversation history and execution state on local disk. `.env.local` contains server credentials.

Self-hosting does not keep all data on your machine. Review each provider's terms and retention settings before connecting sensitive accounts.
