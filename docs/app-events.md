# App-event behavior

`app_events` is a chat tool with `discover`, `create`, `list`, `disable`, and `remove` actions. Discovery returns active accounts owned by the authenticated user and Composio's event config schema. Creation pins an explicit account and saves the instruction and current iMessage destination. Creation, disabling, and removal require Eve approval.

An example creation input, after discovery and the person's approval, is:

```json
{
	"action": "create",
	"connected_account_id": "ca_test",
	"trigger_slug": "GITHUB_COMMIT_EVENT",
	"config": { "owner": "example", "repo": "demo" },
	"instruction": "Summarize each new commit in one sentence and send its link here."
}
```

The account ID is illustrative. Pidge obtains real account choices from Composio for the signed-in user. Composio validates the trigger configuration. Pidge refuses a duplicate local account/event combination or an existing upstream instance. It does not adopt another automation.

## Delivery and execution

`POST /api/triggers/composio` accepts bodies up to 64 KiB. The installed SDK verifies `webhook-id`, `webhook-timestamp`, and `webhook-signature` over the raw body. Its timestamp tolerance is five minutes. Pidge requires a V3 trigger envelope with a stable `metadata.log_id` and the local user's UUID.

The subscription's trigger ID, event slug, account ID, and user ID must all match before Pidge stores work. The event cannot select an instruction, user, conversation, handle, or model. A unique database index on subscription ID and log ID deduplicates delivery retries, including retries with a different webhook message ID. Events that arrive while creation is still in progress receive 503 so Composio can retry after setup.

The existing minute dispatcher claims pending events, checks the live connection and linked conversation, and queues an Eve turn into the saved iMessage conversation. The principal is the subscription creator. This invokes the agent model and normal user-scoped tools. Owner notification relay is not involved.

`turn.started` records the accepted Eve turn ID. Only that turn can run and settle the event. A second delivery cannot cancel or complete the original run. The same durable Eve turn can resume after a restart. Before each model step, Pidge checks ownership, delivery eligibility, subscription status, and run expiry. Before each Composio execution, Pidge checks that the event run is still active.

The saved instruction is distinct from external event JSON. Trusted system context labels that JSON as untrusted evidence. Event data grants no approval. App writes use the existing approval policy and durable execution guard. Event turns cannot manage subscriptions, schedules, or connections, or start browser errands.

## Retries and retention

A successful webhook acknowledgement means the inbox transaction committed, not that a reply was delivered. Storage failure returns 503. Invalid signatures return 401, missing required V3 routing fields return 400, and oversized bodies return 413. Other project event types and unmatched or stopped subscriptions receive 200 and are ignored. Unset `COMPOSIO_WEBHOOK_SECRET` returns 503 and disables creation.

Pidge retries an unaccepted Eve hand-off after one minute, up to three attempts. An event expires after 24 hours, including a run waiting for approval. A run that already started never starts a new model turn automatically after failure or expiry. An ambiguous outcome requires inspection before a person requests another attempt.

Disabling first stops the subscription and queued or running work locally, then asks Composio to disable the instance. Remote failure leaves the local stop intact. Removal stops locally before remote deletion. An already executing external action cannot be recalled by disabling the subscription.

Pidge clears its inbox payload on completion, failure, suppression, or expiry. Subscription metadata and event deduplication rows remain until user deletion through an operator process. Eve conversation history still contains the event input and response under its existing retention rules. Composio retains its own delivery logs.

## Limits

- Setup and proactive replies use an existing linked iMessage conversation. Web chat can inspect and stop subscriptions but cannot create a delivery destination.
- One subscription per connected account and event type is supported. Multiple rules for the same type, resume, and editing are deferred. Remove and recreate to change a rule.
- A retired Eve session or unlinked destination suppresses work. Create the replacement rule from the current linked conversation.
- Composio chooses webhook or polling using the event type's supported defaults. Provider delays add to the minute dispatch delay.
- Pidge deduplicates Composio delivery logs. Distinct logs for the same underlying provider action can still cause separate runs.
- Creation has no automatic retry. A crash or timeout can leave a remote instance requiring operator cleanup. Events already in flight during setup depend on Composio redelivery.
- The single-process deployment and existing Eve workflow persistence requirements still apply. Third-party writes and replies have no universal exactly-once guarantee.

## Memory and migration order

This branch stacks on searchable memory PR #2. Merge #2 first and #3 second. Run `pnpm db:migrate` before starting the combined application: `0005_memory`, `0006_memory_safety`, then `0007_app_event_triggers`. The memory journal and snapshots are retained; only the trigger migration is regenerated after the memory schema. The migration regression compares an empty database with one containing the original memory-0005 schema and synthetic data, and verifies repeat application.

The Eve memory slot resolves from the app-event creator's trusted internal user ID. Event turns receive recall and `memory__search` only. The provider also refuses durable save/forget callback reconstruction for event turns, so old tool names cannot bypass that restriction. Events add no notes for dreaming and cannot confirm, correct, or delete memories. Automatic notes and dreamed facts from ordinary user turns remain unconfirmed data; only authenticated `/memory` actions establish explicit facts. Recalled and searched data never supplies instructions or write approval.

Memory recall retains operation-scoped references for crash replay. Ordinary additions do not change an in-flight recall. Forgetting or correcting a referenced item fails that replay closed, requiring a new turn; the cache holds no forgotten plaintext. Conversation history and provider logs keep their existing retention. Inferred text remains untrusted after dreaming, and exact-text tombstones do not provide semantic erasure.

Shared execution files are `agent/hooks/session-owner.ts`, `agent/lib/identity/principal.ts`, `agent/lib/composio/client.ts`, `agent/lib/composio/sessions.ts`, `agent/lib/schedules/tools.ts`, `agent/tools/run_browser.ts`, `agent/schedules/dynamic.ts`, and `agent/lib/memory/provider.ts`. Environment registration is in `shared/environment/env.ts` and `.env.example`. Eve discovers the tool, hooks, instructions, and memory slot by directory. Synthetic combined tests cover signed replay, owner-scoped recall/search, refused durable memory callbacks, inferred-source handling, approval restarts, subscription disable, and migrations. They do not measure live model prompt-injection resistance.

The Composio contract was checked against the installed SDK types and source, the CLI's `GITHUB_COMMIT_EVENT` metadata, and the primary [creation](https://docs.composio.dev/docs/setting-up-triggers/creating-triggers), [delivery](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events), and [lifecycle](https://docs.composio.dev/docs/setting-up-triggers/managing-triggers) documentation.
