# Set up Pidge

This guide runs one Pidge process on an always-on host with persistent storage. Use your own accounts and a new database. Keep production data out of test environments.

## Prepare the host

Install Node 24, pnpm 12.15.0, and Docker with Compose. Check the versions:

```sh
node --version
pnpm --version
docker compose version
```

iPhone photos arrive as HEIC. Pidge converts them to JPEG with ImageMagick, which needs an HEVC decoder. On Ubuntu 24.04, install `imagemagick libheif-plugin-libde265` and confirm a real decode with `convert 'heic:test/fixtures/photos/example.heic[0]' jpeg:- >/dev/null`; `convert -list format` alone does not prove the decoder is present. Without it, photos reach the model only as file labels.

Use a stable public HTTPS origin, such as `https://pidge.example.com`. The host must accept Photon's signed POST requests without an upstream login screen or redirect. Configure your TLS proxy to forward to the Next.js `PORT`, default 8000. Keep PostgreSQL private.

On exe.dev, follow the [documented HTTPS proxy configuration](https://exe.dev/docs/proxy.md). Configure visibility and the listening port deliberately. A private proxy login blocks Photon callbacks. Any other HTTPS reverse proxy is acceptable if it preserves webhook bodies and headers.

## Provision your provider accounts

1. Create a Photon **Stable / Spectrum Cloud** project at [app.photon.codes](https://app.photon.codes). Provision and activate an iMessage line using Photon's dashboard process, including any required account or line verification. Access and plan availability are external prerequisites. Do not substitute Photon v2 Beta credentials. Obtain the project ID and project secret. See [Photon's Eve integration](https://photon.codes/docs/integrations/eve) and the [official Chat SDK example](https://github.com/photon-hq/vercel-eve-imessage-example).
2. Create your own Composio project in the [Composio dashboard](https://dashboard.composio.dev). Create a project API key with Session management read/write, Session tool execution write, and Connected accounts read/write. Keep it server-side. Dashboard permission labels can change. Use the [project key permissions guide](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions) when diagnosing a scoped-key 401. Pidge disables raw proxy execution and sandbox tools.
3. Enable access and billing for the Composio toolkits you intend to use. The browser uses Composio Instant's `browser_tool`, with charges and limits managed by your Composio project. Confirm access in that project's dashboard before trying an errand. Pidge's 25-step bound is not a dollar cap. Never assume a connection or credits from another operator's project carry over.
4. Create an [AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok). Confirm your selected model ID is available to your team in the [model catalog](https://vercel.com/ai-gateway/models). Models charge for usage, and [Exa search](https://vercel.com/ai-gateway/models/exa-search) has separate search charges through Gateway. Review [Gateway pricing and credits](https://vercel.com/docs/ai-gateway/pricing) and configure spending controls before live use.

Composio creates per-user connected accounts when the user opens a Connect Link. [Managed authentication](https://docs.composio.dev/docs/authentication) usually avoids creating your own OAuth app. Toolkit restrictions, requested scopes, custom auth configurations, provider approval, and paid plans can still require operator work. Review the account and scopes before granting access. Use Pidge's Connections page or continue the chat after connecting. The web connection completion URL is `${APP_URL}/connections/complete`.

No Browser Use operator account, 1Password vault, or browser login credentials are needed by this implementation. Guest browser flows stop when a site requires sign-in or payment details.

## Configure a local runtime

Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
umask 077
cp .env.example .env.local
chmod 600 .env.local
mkdir -p "$PWD/.data/artifacts"
chmod 700 "$PWD/.data/artifacts"
openssl rand -base64 48
```

Put the generated value in `BETTER_AUTH_SECRET`. Edit `.env.local` with your provider credentials and public `APP_URL`. Set `ARTIFACT_STORAGE_DIR` to the absolute path printed by `pwd` followed by `/.data/artifacts`, or another private persistent directory owned by the runtime user. Do not leave a literal `$PWD` in that setting.

Create a separate secret for optional notifications with `openssl rand -hex 32`, or leave `PIDGE_NOTIFY_TOKEN` unset. Do not reuse another API key.

### Environment reference

The runtime contract is [shared/environment/env.ts](../shared/environment/env.ts). Required variables are checked on first runtime access. Build and automated tests use no live provider credentials.

| Variable | Set it to |
| --- | --- |
| `APP_URL` | Canonical public HTTPS origin, without a trailing slash. |
| `BETTER_AUTH_SECRET` | At least 32 random characters. Keep stable across restarts. |
| `BETTER_AUTH_URL` | Optional Better Auth override, normally omitted so it uses `APP_URL`. |
| `DATABASE_URL` | PostgreSQL runtime connection URL for the application database. |
| `DATABASE_URL_UNPOOLED` | Optional direct migration URL. It defaults to `DATABASE_URL`. |
| `COMPOSIO_API_KEY` | Your scoped Composio project key. |
| `COMPOSIO_TOOLKIT_ALLOWLIST` | Optional comma-separated toolkit slugs. Unset allows the catalog, subject to the denylist. Explicitly empty disables app toolkits. |
| `COMPOSIO_TOOLKIT_DENYLIST` | Optional comma-separated toolkit slugs to disable. The dedicated browser toolkits are always excluded from ordinary app sessions. |
| `IMESSAGE_PROJECT_ID` | Photon Stable project ID. |
| `IMESSAGE_PROJECT_SECRET` | Photon Stable project secret. |
| `IMESSAGE_WEBHOOK_SECRET` | Signing secret for the Photon webhook registered below. |
| `AI_GATEWAY_API_KEY` | Server-side Gateway key for models and Exa search. |
| `PIDGE_DEFAULT_MODEL` | Optional Gateway model ID. Defaults to `anthropic/claude-sonnet-5`. The owner can change models in Settings. |
| `ARTIFACT_STORAGE_DIR` | Absolute, private, writable persistent directory, mode 0700, owned by the runtime user. |
| `PORT` | Next.js listening port, default 8000 in the example. |
| `EVE_INTERNAL_ORIGIN` | Optional loopback origin for the app's agent proxy. Defaults to `http://127.0.0.1:${PORT}`, or port 3000 if `PORT` is unset. Match the actual app port. |
| `PIDGE_NOTIFY_TOKEN` | Optional random bearer token. Unset or empty disables both notify paths. |
| `OWNER_PASSWORD` | Optional setup-script input for noninteractive owner creation. Prefer the hidden terminal prompt. Never save it in source. |
| `TEST_DATABASE_URL` | Test-only disposable database URL. Never use the application database. See [CONTRIBUTING](../CONTRIBUTING.md). |

The allowlist controls ordinary app sessions. `run_browser` creates a separate session for `browser_tool` as documented in D5. Disabling an app toolkit does not impose a browser budget.

## Start PostgreSQL and create the owner

The supplied Compose file runs PostgreSQL 17 on loopback port 5432 and stores data in the `pidge-postgres` volume. Its `pidge` password is a local development example. Use separate strong credentials and private network access for a deployed database. If port 5432 is occupied, choose another private instance or adjust the published port and both database URLs.

```sh
docker compose up -d --wait postgres
pnpm db:migrate
pnpm setup:owner --email you@example.com --name "Your Name"
```

Enter a password of at least 12 characters at the hidden prompt. `setup:owner` creates the first owner and refuses if an owner already exists. There is no default account or public sign-up. Do not run `pnpm test` against this database. Tests drop and recreate their target database.

## Start the app and link iMessage

```sh
pnpm build
pnpm start
```

The start script loads `.env.local` before invoking the Next.js CLI, so its `PORT` is also the actual listening port. If you call `next start` directly, export `PORT` or pass `--port` yourself.

Keep this single process running. `next start` serves the app, starts the Eve agent, proxies `/eve/v1/*`, and runs the minute schedule dispatcher. `pnpm dev` is for development, not the persistent schedule deployment.

Check `https://pidge.example.com/eve/v1/health` through your configured proxy. In Photon Stable, register the webhook as `POST https://pidge.example.com/eve/v1/photon`, using your actual origin. Put that webhook's signing secret in `IMESSAGE_WEBHOOK_SECRET`, then restart Pidge. Eve's official Photon channel verifies signatures. Do not register a second `/webhooks/imessage` parser or route Photon through Composio.

Sign in at your public origin. Text the Photon line from your own phone. The first response contains a single-use, 15-minute link. Open it while signed in to bind the iMessage handle. Send a **new** message after linking. Earlier unverified requests never run automatically.

Set your timezone in Settings before creating a schedule. Test one harmless message scheduled a few minutes ahead with your browser closed. Use a harmless app read with your own connected account before enabling writes.

## Preserve data across restarts

Keep all of the following on persistent storage:

- The application PostgreSQL database and its backups.
- The `.eve` directory, including `.eve/.workflow-data`, and any root `.workflow-data` created by your runtime. These contain private conversation and execution state.
- `ARTIFACT_STORAGE_DIR` and `.env.local`.

Run exactly one Pidge app process. Do not run two foreground instances or combine a foreground server with systemd. Adding replicas requires a shared workflow world and shared state design first. Do not deploy the local workflow store on an ephemeral filesystem.

Back up the database and private files under your own retention policy. Keep backups private and test restoration in an isolated environment. Deleting the Compose volume with `docker compose down -v` deletes its database. Migrations change the target database, so back up a deployed database before upgrading.

## Deploy with systemd

A foreground `pnpm start` is enough to try Pidge. For a persistent Linux service, [deploy/deploy.sh](../deploy/deploy.sh) uses explicit SSH host, absolute destination, runtime user, and optional service name. It exports committed source with `git archive`, syncs it with `rsync --delete` while preserving private configuration and runtime state, installs dependencies, migrates, builds, installs the service unit, and restarts it. Running it changes that server.

Prepare the target with Node 24, pnpm 12.15.0 on the system service's `PATH`, Docker/Compose, the HEIC decoder above, and the runtime user. Make the app directory and artifact directory writable by that user. Add the user to the Docker group only if you accept its root-equivalent access. Configure `.env.local` mode 0600 on the target before deployment. Keep its ownership with the runtime user.

Run the script only after choosing a target you own:

```sh
PIDGE_HOST=operator@your-host.example \
PIDGE_REMOTE_DIR=/srv/pidge/app \
PIDGE_RUNTIME_USER=pidge \
PIDGE_SERVICE=pidge \
  bash deploy/deploy.sh
```

The runtime user's primary group must match its name for the supplied template. The SSH user needs permission to sync the app directory, run Docker for the database, and install/restart the unit with sudo. The service template is [deploy/pidge.service.in](../deploy/pidge.service.in). There is no default live host or deployment path. Protect `.env.local`, the local workflow store, artifacts, and database backups from deletion during any alternate deployment process.

After deployment, check the public health route and repeat the [independent release rehearsal](release-rehearsal.md). A successful build does not prove that your Photon line, project scopes, model access, or callback registration work.
