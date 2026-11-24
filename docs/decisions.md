# Decisions and departures from the spec

Each entry records a choice the spec leaves open, or a departure from it, and why. D16 defines the experimental release scope. The remaining spec includes future plans and must not be read as a list of shipped features. Historical live checks below are not a fresh release verification.

## D1. Self-host on a dedicated exe.dev VM for the spike and the video MVP

- **Date:** 2026-11-04
- **Decided by:** operator
- **Choice:** Portable self-hosted deployment (§16.3) on a dedicated, always-on exe.dev VM instead of the Vercel reference deployment (§16.2). Development happens on a separate private machine. Deployment addresses and operator-specific sync paths are intentionally omitted.
- **Why:** Experiment 3 needs a server that keeps running while the operator's laptop is closed; a VM satisfies that with fewer human setup steps. A dedicated VM keeps the public proxy off the operator's development machine. §16.3 is a supported deployment mode, so this is not a departure from the spec.
- **Consequences:**
  - Runtime credentials live in gitignored `.env.local` files on the deployment host, mode 600, and are never committed.
  - Photon uses portable credentials (`IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET`, `IMESSAGE_WEBHOOK_SECRET`) and a direct signed webhook, not Vercel Connect.
  - PostgreSQL runs locally through Docker Compose.
  - Private object storage cannot be Vercel Blob (no Vercel project). See D6.
  - Schedules fire from a process that runs authored cron schedules (`eve start` / `next start`), not Vercel Cron.

## D2. Pin `eve@0.83.3`, not the latest Eve

- **Date:** 2026-11-04
- **Choice:** `eve@0.83.3`, `@composio/core@0.28.0`, `@composio/experimental@0.2.8`, all pinned exactly.
- **Why (evidence):**
  - `@composio/experimental@0.2.8` declares `peerDependencies.eve: ">=0.12.0 <1.0.0"`. That range excluded `eve@1.0.0-rc.3`, the npm `latest` tag during the 2026-11-04 spike.
  - With `eve@0.91.0` (newest in range at the time of the spike), `eve build` fails evaluating `agent/tools/composio.ts`: `defineDynamic() takes a function of the session, not an events map`. The provider's `defineComposioTools` calls `defineDynamic({ events: { "step.started": … } })`.
  - Eve's changelog shows 0.84.0 replaced lifecycle-map `defineDynamic({ events })` with `defineDynamic(ctx => value)`. The provider was built against `eve ^0.75.1` (its devDependency).
  - `eve@0.83.3` is the last release before 0.84.0, is inside the provider's peer range, includes `eve/channels/photon`, and builds the spike agent cleanly.
- **Consequences:** All authored dynamic capabilities use the 0.83 lifecycle-map form (`defineDynamic({ events: { "turn.started": … } })`). Implementation follows the docs bundled in `node_modules/eve/docs` for 0.83.3, which differ from current hosted docs. Upgrading Eve requires a Composio provider release that supports the new `defineDynamic` form, and the compatibility suite (§9.1, §20).
- **Required build setting:** `defineAgent({ build: { externalDependencies: ["@composio/experimental"] } })`. Without it, eve 0.83.3's dynamic-tool transform rewrites the bundled provider's `defineTool` calls and loses `this`, so every Composio step fails with `Cannot read properties of undefined (reading 'strict')` (spike finding F1). Keeping the package external is a documented eve packaging option and changes no provider behavior.

## D3. Default model

- **Date:** 2026-11-04
- **Decided by:** operator
- **Choice:** `anthropic/claude-sonnet-5` through Vercel AI Gateway as the deployment default. Users can change it in settings (§10.1).

## D4. Deterministic iMessage onboarding without a model turn (departure from §7.3 / §10.2 wording)

- **Date:** 2026-11-04
- **Decided by:** operator
- **Spec says:** unknown senders get a *restricted onboarding session* (§7.3) whose only tool is `create_imessage_link` (§10.2).
- **Problem (evidence, spike F2):** in eve 0.83.3 the built-in `web_search` is a gateway provider-executed tool (`gateway.tools.exaSearch`). It cannot be returned from `defineDynamic` (`returned "kind" without defineTool()`), so it cannot be withheld per session. Any model turn for an unknown sender would also offer web search.
- **Choice:** For an unknown DM sender, the Photon `onMessage` hook itself creates the single-use, 15-minute link token bound to the normalized handle and Photon conversation, posts one message with the `/link/imessage?token=…` link to that thread, and returns `null`. No Eve turn runs, so no model, tools, or session state exist for unverified senders.
- **Why:** It is strictly narrower than §10.2 (no tools at all instead of one) and costs nothing for strangers. Everything else in §7.3 stays: bot and group rejection, handle normalization, verified `channel_identities` lookup, single-use hashed tokens, sign-in-gated `/link/imessage`, fail-closed token states. A new inbound message is still required after linking.
- **Not changed:** The reply goes through the Chat SDK thread that Eve's Photon channel passes to `onMessage`. There is no second webhook parser or Spectrum client (§8.2). Linked users get ordinary Eve sessions with `web_search`/`web_fetch` as specified.

## D5. Composio `browser_tool` under Composio Instant instead of Browser Use Cloud (departure from §1.1, §11, §16.1)

- **Date:** 2026-11-04
- **Decided by:** operator ("Switch to Composio browser_tool"; "Composio Instant will enable users to manage their own budget").
- **Spec says:** Browser Use Cloud through the operator-owned `browser_use` connection, with `BROWSER_USE_START_RUN` and a provider-enforced `max_cost_usd` on every run, queued corrections, per-user daily USD budgets reserved by the app, and 1Password vault bindings.
- **Choice:** `run_browser` drives Composio's own `browser_tool` toolkit (`BROWSER_TOOL_CREATE_TASK`, `WATCH_TASK`, `STOP_TASK`, `GET_SESSION`, `GET_OUTPUT_FILE`), billed through Composio Instant. Spend limits are managed in Composio Instant rather than by an application-side USD reservation ledger.
- **What changes:**
  - No operator Browser Use account, no `COMPOSIO_OPERATOR_USER_ID`, no `pnpm setup:browser-use`; `browser_tool` is `NO_AUTH`.
  - Bound per task: the provider's 25-step limit, not `max_cost_usd`. `browser_tool` has no cost-cap input.
  - Corrections to an active task: `BROWSER_TOOL_STOP_TASK` (ends the task and its browser session), then a new `BROWSER_TOOL_CREATE_TASK` with the corrected instructions. There are no queued/interrupting messages. Both remain under the §9.6 approval rules: a committing task still needs Eve approval of its exact terms first.
  - No 1Password vault binding (1Password was Phase 5 anyway); the toolkit's inline `secrets` input is never used (§11.3: no raw secret source).
  - `BROWSER_USE_DAILY_USER_BUDGET_USD` / `BROWSER_USE_DEFAULT_MAX_COST_USD` are dropped.
- **What stays:** `run_browser` is still the only model-facing browser entry point. User Composio sessions disable both `browser_use` and `browser_tool`, and the provider hook denies `BROWSER_USE_*` and `BROWSER_TOOL_*`. Ownership checks, stored task/session IDs, approval of committing tasks, polling to a terminal state, and fetching the result once all stay.
- **Evidence:** spike check 2b in `docs/spike.md`.

## D6. Self-hosted storage and durability on the single VM (Phase 1)

- **Date:** 2026-11-04
- **Choice:**
  - **Private object storage:** local disk under `ARTIFACT_STORAGE_DIR` (an operator-selected persistent directory, mode 700), not Vercel Blob, because there is no Vercel project (D1). Each object key is a random UUID. Files are owner-only (0600) and reachable only through `/artifacts/[artifactId]` after an ownership check and a SHA-256 integrity check (`db/services/artifacts.ts`).
  - **Eve Workflow World:** eve's default local world under `.eve/.workflow-data` on the host's persistent disk, with exactly one `next start` process. §16.3 asks for a *shared* world so execution survives *replicas and restarts*. There is one replica, and eve re-enqueues pending local runs on startup. Adding a second replica requires a shared world first.
  - **Chat SDK state:** the Photon channel's in-memory Chat SDK state adapter (eve logs "MemoryStateAdapter is not recommended for production"). Retried-delivery dedupe was verified on this setup (Phase 1 scenario 2); it relies on eve's workflow world, not on Chat SDK state.
- **Why:** These are the smallest durable choices for the operator's single always-on VM. None of them changes an identity or integration boundary.

## D7. Web chat authorization uses server-minted, session-scoped tokens

- **Date:** 2026-11-04
- **Not a departure.** Implements §7.4 ("web routes bearing a session ID MUST verify both authentication and ownership") given that eve's route auth does not check session ownership (eve docs: "Route auth does not enforce session ownership").
- **Design:**
  - The Next.js server creates each web chat session and records its `conversation_bindings` row before any message.
  - The browser fetches a 10-minute HMAC token (key derived from `BETTER_AUTH_SECRET`) for one session it owns.
  - The agent's `eveChannel` auth accepts a token only on `/eve/v1/session/<that id>/…`. There is no anonymous, `localDev()`, or Vercel OIDC fallback.
- **Verified live:** another user got 404 for the chat page and the token endpoint, and 403 for the stream and for sending with their own token (see `docs/mvp-verification.md`).

## D8. iMessage photos arrive as HEIC, which the model cannot view

- **Superseded:** D17 adds HEIC conversion for the experimental release.
- **Date:** 2026-11-04
- **Observed:** Photos and even screenshots sent from the operator's iPhone reach eve as `image/heic` file parts. The model receives a text reference (`[file: image.heic (image/heic)]`) and cannot see the image.
- **Spec status:** Compliant with §8.3: the attachment is delivered as a file part, and an unsupported format yields a bounded note, not a fabricated result. The agent is instructed to say the format isn't supported yet.
- **Impact:** None of the three video-MVP experiments depends on photos. HEIC-to-JPEG conversion would be an enhancement beyond the spec and is not implemented.

## D9. "Other writes" require Eve approval (stricter than §9.7)

- **Date:** 2026-11-04
- **Spec says:** A write with no risky hint or action word "runs only when it exactly matches the user's current request; otherwise ask first."
- **Choice:** `agent/lib/composio/policy.ts` sends every such write, and every tool whose Composio metadata is unknown, through Eve approval.
- **Why:** Server code cannot verify that a write "exactly matches the current request". §9.6 forbids relying on prompt wording alone, so the central policy fails safe. The cost is one extra 👍 for plain writes such as adding a Notion block. The remaining §9.7 rows are implemented exactly:
  - read-only hints run freely;
  - destructive hints, high-risk words, and outbound words need approval;
  - connection replacement or removal (`reinitiate_all`, or any `COMPOSIO_MANAGE_CONNECTIONS` action other than add, list, check, status, or get) needs approval.

## D10. Approval prompts are attached to Composio provider tools by the app

- **Date:** 2026-11-04
- **Problem:** `@composio/experimental@0.2.8` sets only a function-form approval policy, so eve would show its default "Approve <tool>?" prompt. §9.7 requires the prompt to show the recipients/destination and content being approved.
- **Choice:** `withApprovalPrompts` (`agent/lib/composio/sessions.ts`) keeps the provider's policy and executor unchanged. It adds an approval `prompt` that lists every entry's tool slug and arguments; credential-like keys are hidden and length is bounded. The prompt is registered as a durable eve callback through the same global-symbol descriptor protocol the provider uses for its own callbacks.
- **Verified live:** Slack and Gmail approvals over iMessage showed channel, text, recipient, subject, and body, and were answered with a 👍 Tapback (`docs/mvp-verification.md`). Composio's session-level `requireApproval` stays off (§9.6).

## D11. Committing browser runs are refused on OpenTable; bookings go through SevenRooms or restaurant sites

- **Date:** 2026-11-04
- **Spec says:** "The MVP demo uses a site that allows guest booking" (§9.6). It does not name a site.
- **Observed:** Three approved OpenTable commit runs (The Fly Trap twice, FANG once) reached `opentable.com/booking/details`, but the hosted browser never saw the guest contact form. An automated headless Chromium gets "Access Denied" on OpenTable search. This is bot protection, and §9.6 forbids bypassing it. SevenRooms reservation pages load for the hosted browser: a research run reached Bar Sprezzatura's guest details step, which asks for name, email, and phone, with no card or deposit (`docs/mvp-verification.md`).
- **Choice:** `runBrowserApproval` denies a committing run whose terms site or `start_url` is OpenTable, before the person is asked to approve, and gives the model a reason that points at SevenRooms or the restaurant's own form. Research task text tells the browser agent to report SevenRooms or restaurant booking URLs for bookable options. Research on OpenTable (availability, listings) is still allowed.
- **Why:** Without this, the person approves a booking that can only fail. The rule names the one site with observed evidence and is a few lines to remove if OpenTable access changes.

## D12. A scheduled run is one report turn in the originating iMessage conversation

- **Date:** 2026-11-05
- **Spec says:** "Execution uses isolated runs with leases and bounded runtime … Completion creates a separate reporting turn in the originating conversation" (§13.1). It also defines separate scheduled-worker and scheduled-report tool scopes (§10.3), and says schedules deliver "through Photon or web chat" (§4.4).
- **Choice:** Pidge implements eve's application-managed dynamic-scheduling pattern. `scheduled_jobs` and `scheduled_runs` live in Postgres, and one authored minute dispatcher (`agent/schedules/dynamic.ts`) leases due occurrences. Each occurrence is handed to its originating conversation with `to(photon, { adapterName: "imessage", threadId }).send(…)`, running as the schedule's creator, with a principal that carries the run ID. That single turn does the work and is the report.
  - The run is bounded: a 20-minute lease, checked when the turn starts and before every model call. Pausing or deleting the schedule, or lease expiry, cancels the turn. 20 minutes exceeds the workflow engine's 860-second inline step lease, which sets how long a restart-interrupted step waits before it re-runs.
  - The destination is re-checked just before hand-off; an unlinked destination is suppressed and recorded.
  - The turn gets user-scoped Composio tools minus `COMPOSIO_MANAGE_CONNECTIONS`, and no `run_browser` or `schedule_*` tools. Writes still need approval, which arrives in the same conversation.
  - The occurrence is settled from the turn's final message.
  - Schedules can be created only from an iMessage conversation. In web chat, `schedule_create` explains that schedules deliver over iMessage.
- **Why:**
  - In eve 0.83.3 `to(photon).send` continues the thread's existing session (docs/spike.md Check 4), so the report naturally has the conversation's context. "Text me tomorrow afternoon with the booking details and directions" needs exactly that context.
  - A separate worker session would need a channel that can't message anyone, plus a second hand-off, for no MVP benefit. A worker question is simply a reply in the same thread.
  - The eve web channel has no proactive receive target, so web chat cannot be a delayed destination.
- **Delivery guarantees:**
  - An occurrence row is unique per schedule and time, so overlapping ticks cannot claim it twice.
  - A claim whose turn never started is re-leased after its lease expires, up to 3 attempts.
  - Once the turn has started (`reporting`), the occurrence is never handed off again. Photon `send` has no idempotency key (docs/spike.md F4), so Pidge prefers a reported failure to a duplicate message.
  - Occurrences missed while Pidge was down are coalesced into one run.
  - Recurring cron runs in the schedule's stored timezone, DST-stable via `croner`.

## D13. Video acceptance closed without a kept reservation

- **Date:** 2026-11-05
- **Decided by:** operator
- **Original goal:** experiment 2 ends in an approved reservation, and experiment 3 sends the next-afternoon message with booking details and directions while the laptop is closed.
- **Historical result:** Two real approved reservations completed and the operator cancelled both. One used a different time from the scripted experiment; the other used the wrong date because the model reused the previous day's "tomorrow". `agent/instructions/date-anchor.ts` addresses the date reuse. Booking identifiers and personal itinerary details are omitted.
- **Scope exception:** The operator declined another real booking. The final scripted run reached an approval with the correct date, time, and party size, which the operator declined. The operator accepted that outcome for the video MVP.
- **Evidence for experiment 3:** Scheduled delivery with no inbound message passed separately for a recurring job and a one-time job spanning downtime. The scripted booking-details message was never sent because there was no kept reservation. Pidge refused to invent one. See `docs/mvp-verification.md`.
- **Release implication:** The exact three-experiment script did not pass end to end. Describe the verified behaviors and this exception instead of claiming it did.

## D14. Optional owner notifications use Eve's proactive hand-off without a model call

- **Date:** 2026-11-09
- **Spec status:** An addition. A trusted outside service can send the owner a notification without starting a model call. The endpoint is optional and disabled unless the operator configures `PIDGE_NOTIFY_TOKEN`. D16 removes the original private caller integration.
- **Endpoint:** `POST /api/notify` with `{ "text": string, "idempotencyKey"?: string }` and `Authorization: Bearer <PIDGE_NOTIFY_TOKEN>`.
  - Unset token → 404 (disabled). Missing or wrong token → 401, compared in constant time over SHA-256 digests.
  - Empty or whitespace-only text, or text over 2,000 characters → 400. A body over 16 KiB → 413.
  - 202 means the text was handed to the owner's conversation; the iMessage is posted asynchronously.
  - A repeated `idempotencyKey` within 24 hours → 200 `duplicate`, no send. Keys are kept in memory, so a restart forgets them.
  - The Next.js route forwards to the agent service's `/eve/v1/notify` (`agent/channels/notify.ts`). The logic is `handleNotify` (`agent/lib/notify/request.ts`).
- **Delivery path:** eve's Photon channel does not expose its Chat SDK bot, and the spec (§8.2, "MUST NOT add a second Photon webhook parser or Spectrum client") rules out a second client. eve's documented proactive path, `to(photon, { adapterName: "imessage", threadId }).send(…)`, always starts a turn. So:
  1. The route hands a turn to the owner's iMessage thread (`findOwnerDeliveryTarget`: the owner's most recently bound iMessage conversation whose handle is still linked), with a notify principal that carries the text, and `turnPolicy: "queue"` so it never steers an active turn.
  2. `agent/hooks/session-owner.ts` runs the usual ownership check, then cancels the turn in `turn.started`. No model call runs.
  3. The Photon channel's `turn.cancelled` handler (Photon has no built-in one) re-checks `deliveryAllowed` and posts the text with `channel.thread.post`. A hand-off that failed the ownership check is also cancelled, and that re-check keeps it from posting.
- **Conversation history:** eve records a cancelled turn's message. In eve 0.83.3 the cross-channel `send` accepts only `auth` and `turnPolicy`, not `history`, so the text cannot be imported as an assistant message. The turn message is the text under a marker saying Pidge already sent it verbatim on behalf of a trusted outside service. A later reply such as "what are the three things?" then has the context.
- **Limits:** Channel event handlers are at least once, so a crash between posting and recording the event could repeat the iMessage. Photon send has no idempotency key (docs/spike.md F4). Key memory is process-local and holds at most 1,000 entries, so restarts and eviction can also permit duplicates. This endpoint does not guarantee exactly-once delivery.
- **Historical live check (2026-11-09):** `POST /api/notify` with no or a wrong token returned 401, and whitespace-only text returned 400. The real call returned 202, and a repeat of its `idempotencyKey` returned 200 `duplicate`. The owner's session shows `turn.started` then `turn.cancelled` with no model step. The cancelled turn's recorded message is the marker plus the text, and `pidge.notify_posted` logged a Photon message reference. The private reference is omitted.

## D15. Private Chief of Staff integration, removed for release

- **Date:** 2026-11-12, superseded by D16 on 2026-11-14
- **Historical purpose:** An operator-specific integration exposed `cos_status` and `cos_forward` to the owner and interpreted notifications as messages from that private assistant.
- **Release status:** Removed. The bridge, its environment setting, private infrastructure details, and caller-specific instructions are outside Pidge's open-source scope. The generic optional notification endpoint remains. A future integration should have its own documented contract rather than assume access to the original operator's infrastructure.

## D16. Release the implemented MVP as experimental

- **Date:** 2026-11-14
- **Context:** The planned public release is an experimental project. It is not the completed product described by every section of the original spec.
- **Scope:** Authenticated iMessage and web conversations, per-user Composio app discovery and connections, centrally approved writes, hosted guest-browser errands through `browser_tool`, structured non-secret personal info, private artifacts, and iMessage schedules. These features remain subject to the historical limits documented above and to each deployment's provider access.
- **Optional extension:** `POST /api/notify` accepts generic trusted-service text only when `PIDGE_NOTIFY_TOKEN` is configured. It has no Chief of Staff dependency and remains disabled by default.
- **Removed:** The private `cos_status` / `cos_forward` bridge and its deployment-specific instructions. The operator's Todoist tweet rule is not a built-in release behavior.
- **Deferred:** Phase 5 and Phase 6 are future plans. Pidge does not claim Composio trigger support, profile memory, workstreams, 1Password/browser-vault integration, a complete account-deletion flow, production retention/backup guarantees, or production readiness. Some foundations exist, including invitations, but that does not establish completion of either phase.
- **Browser limits:** D5 replaces the original Browser Use Cloud and dollar-budget design. `browser_tool` has a step bound; no application-enforced dollar budget is provided. Composio Instant spend enforcement was not demonstrated in the historical tests.
- **Documentation rule:** The README and environment example describe current setup. `docs/spec.md` preserves the larger design with an explicit scope note, and `docs/spike.md` / `docs/mvp-verification.md` record sanitized historical evidence. Current local validation must be reported separately from live provider tests and independent onboarding.

The release security fixes authenticate both notification paths before consuming a body, enforce the 16 KiB limit while streaming, and reserve idempotency keys after asynchronous target lookup without an intervening await. `pnpm start` loads `.env.local` before Next.js reads the listening port.

## D17. Convert inbound HEIC photos to JPEG on the Node host

- **Date:** 2026-11-16
- **Request:** iPhone photos must be readable before the November 19 experimental release.
- **Cause:** Photon delivers attachment metadata and an id, not inline bytes. Eve downloads through the existing authenticated Photon adapter, stages files in its sandbox, then includes only supported formats within its visibility ceilings in model input. HEIC reaches the model as a text reference. Pidge also instructed the model to reject HEIC, per D8.
- **Choice:** Wrap the Photon channel's file resolver to convert HEIC bytes to JPEG with the host's ImageMagick, then let Eve stage and hydrate the JPEG normally. Detection uses HEIF brands as well as MIME metadata. Conversion reads stdin, selects the primary still, applies orientation, strips metadata, and writes stdout. Failures become Eve attachment notes. Existing authorization, downloads, and non-HEIC attachments use their original paths.
- **Dependency:** No npm dependency or Eve upgrade. Ubuntu's ImageMagick and libheif packages do not include the HEVC decoder by default. `libheif-plugin-libde265` is required on the Node host. `deploy/deploy.sh` now decodes the public fixture before syncing any code, since a listed HEIC format does not prove codec support. Next's transitive Sharp binary also lacks HEVC support, so importing it would not solve this. See [Sharp's HEVC requirements](https://sharp.pixelplumbing.com/api-output/#heif).
- **Compatibility:** Eve 0.83.3 has no Photon attachment-transform configuration. Its compiled channel adapter exposes the existing `fetchFile` resolver at runtime but omits it from the public channel type. A narrow type assertion permits the wrapper; the fixture test exercises the actual pinned Photon parser, download rehydration, queue serialization, staging, and model hydration. Recheck this extension before any Eve upgrade.
- **Limits:** Eve's ceilings remain: 25 MiB inbound downloads; JPEG, PNG, GIF, and WebP model input at most 3 MiB and 8,000 pixels per side. Conversion lowers JPEG quality with `jpeg:extent` (not dimensions) so ordinary iPhone photos fit. Any image still over a ceiling, and any video (including Live Photo motion), becomes an attachment note asking for a smaller copy or a description instead of a bare file label. Images are not resized. Multiple images are handled one by one, each subject to these limits.
- **Evidence:** `agent/lib/attachments/photos.test.ts` reproduces the original HEIC failure and checks JPEG model bytes with and without text, normal PNG, generic MIME, corrupt HEIC, and download failures. Fixtures are public libheif examples with synthetic message metadata. No real conversations, model calls, iMessages, or notifications are used. Live iPhone acceptance has not been run.

## D17. Searchable memory and dreaming in PostgreSQL

- **Date:** 2026-11-24
- **Spec status:** Partly implements §12 "Profile" memory with a different backend. The spec named Eve file memory in object storage. Pidge uses Eve's memory slot API (`agent/memory.ts`) with its own provider over a PostgreSQL table, `memory_items`. Workstreams (§12.3) remain deferred.
- **Why PostgreSQL:** Pidge already depends on it, it gives per-user foreign keys with cascade delete, and its full-text search covers keyword retrieval without an external memory service, embeddings, or a vector index. File memory has no search, no provenance, and no place to record what was forgotten.
- **Model context:** `recall["turn.started"]` returns two keyed messages before the model runs. One holds active facts, explicit first, up to 40. The other holds up to 5 notes that match the new message. Both are always returned, so a forgotten item is superseded on the next turn. Eve places recalled text in user-role messages, not system instructions.
- **Tools:** `memory__save` always saves an inferred note; model input cannot select explicit provenance. `memory__search` reads the authenticated user’s facts and notes. `memory__forget` requires Eve approval. Corrections and explicit facts come only from authenticated `/memory` actions. Scheduled reports and app-event turns get search only; event content creates no notes for dreaming; notify hand-offs disable the slot.
- **Replay:** Each recall operation keeps a reference-only snapshot in Eve durable state, separately for turn start and compaction. The same operation returns its original records after a restart even if other memories were added. Forgetting or correcting a referenced item makes replay fail closed with a request to start a fresh turn. This cache holds no plaintext; Eve history and provider logs have their existing retention.
- **Dreaming:** At minute 17 hourly, users whose local time is 3 a.m. receive a pass over up to 50 active notes, oldest first, up to 25 users per tick. A per-user five-minute database lease precedes the model call. The production call times out after two minutes, has no automatic retry, and caps output at 4,000 tokens and 20 bounded facts. The apply transaction checks the lease and every input again: any forgotten or changed input invalidates the entire proposal, including uncited paraphrases. Successful proposals stay inferred. Rejected source notes stay active. Capacity-aware replacements and per-user mutation locks avoid partial changes and concurrent overfill. A model failure releases the lease; a crashed worker’s lease expires. An expired model call cannot commit.
- **Forgetting:** Erases text across the complete connected provenance component in the user’s partition, including ancestors and siblings. Hash tombstones suppress exact normalized inferred text only; reworded versions are not semantically suppressed. Correction rolls back forgetting if replacement fails. A user-confirmed duplicate becomes explicit and detaches inferred source links.
- **Management:** `/memory` shows the actual count of pending notes, pages through notes, and offers forgetting on search results. It permits adding, correcting, forgetting one component, forgetting everything, and dreaming now.
- **Limits:** Capture is model-driven, without automatic conversation logging. Keyword search uses PostgreSQL English stemming and substring matching, without embeddings. Secret detection is heuristic. A misled model can still save an unconfirmed observation in an ordinary user turn; instructions and inferred labels do not establish truth. Only authenticated user actions establish explicit provenance. Semantic erasure, complete backup/provider erasure, and live model quality are unverified.
- **Migrations:** `0005_memory` creates `memory_items`; `0006_memory_safety` adds the dreaming lease and active-text uniqueness, resolving old duplicate active rows without dropping their provenance. No new environment variables.
