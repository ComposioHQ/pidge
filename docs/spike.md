# Phase 0 integration spike

These are sanitized historical results from 2026-11-04 against real services. They explain compatibility choices; they are not a fresh release verification or a claim about current provider behavior. Private deployment addresses, account and run identifiers, authentication links, and message transcripts have been removed. The original throwaway `spike/` implementation is not part of the release.

Tested versions were `eve@0.83.3`, `@composio/core@0.28.0`, and `@composio/experimental@0.2.8`. See D2 in [decisions.md](decisions.md). The test deployment used a single always-on VM and an AI Gateway model.

## Version compatibility

| Combination tested | Historical result |
|---|---|
| `eve@1.0.0-rc.3` with `@composio/experimental@0.2.8` | Outside the provider's peer range, `eve >=0.12.0 <1.0.0`. |
| `eve@0.91.0` with `@composio/experimental@0.2.8` | `eve build` failed with `defineDynamic() takes a function of the session, not an events map`. |
| `eve@0.83.3` with `@composio/experimental@0.2.8` | Build and typecheck passed. |

## Check 1: Eve and Composio

The per-conversation dynamic resolver returned `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, and `COMPOSIO_SEARCH_TOOLS`. Workbench, Bash, and proxy tools were absent. Four Eve conversations produced four distinct Composio sessions, and later steps restored their stored sessions with `composio.use()`.

A missing Slack connection returned a Connect Link without executing a Slack action. The actual link is intentionally omitted. The callback used the deployment's `/connections/complete` page. The session enabled explicit multi-account selection and disabled `browser_use`, sandbox/workbench execution, and proxy execution.

The provider hook rejected a `BROWSER_USE_START_RUN` inside multi-execute before a network call. With that hook bypassed for a direct SDK check, Composio still rejected the disabled toolkit with `ToolRouterV2_ToolkitDisabled`. This check passed after the packaging fix in F1.

## Check 2: Browser Use through Composio

This path passed its historical lifecycle check and was then superseded by D5. An operator-owned standard API-key Browser Use connection ran through a server-only Composio service session restricted to `browser_use`.

| Step | Historical result |
|---|---|
| Start with `max_cost_usd` | Run queued with remote session and run metadata. |
| Queue the same non-interrupting `deduplication_key` twice | Two messages were created. The key did not deduplicate them. |
| Cancel pending messages | Both reached `cancelled`. |
| Queue an interrupting correction | Message reached `consumed`, original run was cancelled, and `GET_SESSION.latest_run_id` identified the replacement. |
| Cancel replacement | Replacement reached `cancelled`. |
| Start another capped run in the same session | Run completed; full result fetched once. Nothing was submitted. |
| Read settled session cost | LLM, browser-time, and proxy costs were returned separately. |

A `$0.03` cap completed below its LLM limit. A `$0.003` cap stopped after a step boundary at `$0.005012` of LLM cost. An interrupting queued replacement refused to start after the original run had already exceeded the shared `$0.003` budget. Browser time and proxy fees remained outside that cap. These figures describe those test runs only.

The queued-message record referred to its original run, not its replacement. After consumption, `GET_SESSION.latest_run_id` identified the replacement, and the session queue recorded the interrupted source run. The selected queued-correction path was superseded when the operator chose `browser_tool`.

## Check 2b: Composio `browser_tool` after D5

Server sessions enabled only `browser_tool`, disabled connection management, sandbox/workbench, and proxy execution, and requested Instant charge reporting.

| Step | Historical result |
|---|---|
| `BROWSER_TOOL_CREATE_TASK` and `WATCH_TASK` | Task finished with output, steps, and output-file metadata. |
| Second task in the same session | Existing page state remained available. |
| `BROWSER_TOOL_STOP_TASK` | Long task stopped. A corrected task finished in a new session. |
| User B calls `GET_SESSION` on user A's session | Rejected with "Session not found or access denied". |
| User B calls `WATCH_TASK` on user A's task ID | Returned A's full output and steps. See F7. |
| Ordinary user session disables `browser_tool` | Direct execution failed with `ToolRouterV2_ToolkitDisabled`. |
| Instant charge reporting | Responses omitted `instantCharge`; project usage reported zero. Spend enforcement was not demonstrated. See F8. |

Lifecycle, stop-and-restart correction, session reuse, and ordinary user-session restrictions passed. The provider's observed bound was 25 steps per task, not a dollar cap.

## Check 3: Photon and Eve

The Photon Stable project used portable credentials and a direct signed webhook at `/eve/v1/photon`. An unsigned request returned 400. Real iMessages from one test sender reached one conversation.

The spike gave an unknown sender a restricted onboarding principal. It offered only an identity link and could not run browser tasks. After linking, the same conversation could call `run_browser`, received an exact-terms approval, and answered it through Tapbacks. Like approved and ran the call once; dislike resolved to `cancel` and prevented execution. Tapbacks answered the request attached to the tapped message.

The onboarding-only tool disappeared for a linked principal. The application later adopted deterministic onboarding without a model turn because built-in tools could not be gated in the same way. See D4 and F2.

## Check 4: Proactive delivery

A stored one-time job fired from the authored minute dispatcher with no new inbound message. `to(photon, { adapterName: "imessage", threadId }).send(..., { auth })` delivered a real iMessage. Eve 0.83.3 continued the thread's existing session, preserving conversation context.

## Check 5: Search

Eve's built-in `webSearch({ provider: "exa" })` through AI Gateway returned public search results with source URLs, and the reply cited a returned source. The check passed with the configured deployment model.

## Check 6: Local approval

An authored `run_browser` probe paused with `input.requested`, `kind: "tool-approval"`, and `approve` / `cancel` options. Its prompt showed the site, action, date/time, party size, total/deposit, and account. Approval ran the call once with the same terms. HTTP and real iMessage checks passed.

## Findings that shape the implementation

- F1. Eve's transform rewrote the bundled Composio provider and lost `this`, producing `Cannot read properties of undefined (reading 'strict')`. `build.externalDependencies: ["@composio/experimental"]` kept the provider outside that transform and made the check pass. See D2.
- F2. Eve 0.83.3 could not return provider tools from `defineDynamic`, failing with `returned "kind" without defineTool()`. The application therefore avoids a model turn entirely for unknown iMessage senders. See D4.
- F3. The approval choices in Eve 0.83.3 are `approve` and `cancel`. A dislike Tapback must answer `cancel`.
- F4. Cross-channel `send` in Eve 0.83.3 takes only `auth` and `turnPolicy`, with no idempotency key. Application deduplication cannot provide exactly-once Photon delivery across a crash.
- F5. Browser Use created two queued messages for one repeated `deduplication_key`. Never blindly retry an ambiguous queue request. This finding concerns the superseded Browser Use path.
- F6. Browser Use's `max_cost_usd` bounded LLM spend at step boundaries, with slight overshoot. Browser-time and proxy charges were outside the cap. The D5 `browser_tool` path has no equivalent dollar-cap input.
- F7. `BROWSER_TOOL_WATCH_TASK` returned another user's task output when given its task ID. The application must keep remote IDs server-side and verify its own ownership row before watch, stop, and file access. Provider checks alone were insufficient in this test.
- F8. Composio Instant charges were absent despite an Instant-enabled session policy. Neither these spike checks nor the later MVP runs proved project spend accounting or budget enforcement. Operators must verify their own billing controls before relying on them.

## Human setup used for these tests

The operator supplied AI Gateway, Composio, and Photon accounts and credentials. The superseded Browser Use path also required a connected standard Browser Use account. Secrets and raw test outputs were kept outside Git. Public setup instructions belong in the README; this historical record contains no usable auth link or deployment credential.
