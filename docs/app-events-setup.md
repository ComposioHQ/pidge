# Set up app-event work

Use a dedicated Composio project for this Pidge deployment. Complete the existing [Pidge setup](setup.md) first. No trigger instance or project webhook is created automatically by installation, migration, or build.

## Configure delivery

1. Apply `pnpm db:migrate` against your deployment database. Apply memory migrations `0005_memory` and `0006_memory_safety` first, then the `0007_app_event_triggers` migration adds `app_event_subscriptions` and `app_event_runs`.
2. Give the deployment's Composio project key permission to read trigger types and instances and manage trigger instances. Keep the existing session and connected-account permissions.
3. Inspect the project's current outbound webhook subscription in the Composio dashboard. If another application uses that subscription, use a separate project. Do not replace another application's destination.
4. Register `https://YOUR_PUBLIC_HOST/api/triggers/composio` as the project's outbound webhook URL. Select payload version `V3` and event type `composio.trigger.message`. Use the dashboard or the documented `composio.webhooks.subscriptions` API. Provider ingress webhooks are a separate Composio setting.
5. Store the returned signing secret in the server's `COMPOSIO_WEBHOOK_SECRET` environment variable. Restart the app with that variable. Keep the secret out of chat, URLs, logs, and source control.
6. Keep the existing Eve minute dispatcher running on the single persistent app process. If you change the signing secret in Composio, update the server configuration and restart together.

See Composio's [receiving events guide](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events) for project subscriptions and signatures. The installed `@composio/core@0.28.0` supports V3 verification, explicit account selection, and trigger lifecycle calls.

## Verify locally without accounts or model calls

Start a disposable PostgreSQL database on an unused local port, then run:

```sh
TEST_DATABASE_URL=postgres://pidge:pidge@127.0.0.1:55433/pidge_triggers_test \
	pnpm exec vitest run agent/lib/triggers agent/lib/composio/client.test.ts
```

The test database is dropped and recreated. Use a database with no wanted data.

`events.test.ts` signs a synthetic `GITHUB_COMMIT_EVENT` using HMAC-SHA256 and sends it through the real installed SDK verifier. The event enters PostgreSQL and the dispatcher supplies a queued turn to a mocked Eve send boundary. The test invokes the actual ownership and completion hooks. It checks the stored instruction, account, user, conversation, event run, duplicate-turn rejection, and completion.

The synthetic commit includes an instruction to send secrets. The test keeps that text inside the untrusted event JSON and verifies that it cannot replace auth or the saved instruction. A stubbed final response demonstrates the intended output boundary. No model generates that response, and the test does not establish that a model will resist every prompt injection.

`client.test.ts` checks that an event-triggered write still requires the existing approval guard, executes once, and stops if the subscription is disabled while approval is pending. The combined event test exercises Eve recall and durable memory callbacks, checks owner isolation, and refuses memory writes, correction, promotion, and deletion. Only preexisting inferred notes reach the mocked dreamer. Crash/replay and compaction tests restore serialized Eve state; forgetting a recalled item fails replay closed. The migration test compares empty and preexisting memory-0005 upgrade paths.

The subscription tests mock Composio writes and also check that the installed SDK transport sends a failed creation request only once.

## Verify live after review and deployment

These steps are for the operator to run later. They were not run as part of implementation. They require a real model call and an iMessage reply.

1. Choose an existing active GitHub connection in your Pidge user's Composio project. Use an expendable repository owned by that account. Do not relink an account for this check.
2. In your linked iMessage conversation, send: "When a commit lands in OWNER/REPO on my ACCOUNT_ALIAS GitHub connection, summarize it in one sentence and send its link here. Discover the event and show me the setup first."
3. Confirm that Pidge discovers `GITHUB_COMMIT_EVENT` with config fields `owner` and `repo`. Check the selected account and saved instruction in the approval request. Approve creation once.
4. Ask Pidge to list app-event subscriptions. Record the local subscription ID and verify its status is `active`.
5. Push one harmless commit to the expendable repository. Wait for provider delivery, the next minute dispatcher tick, and any queued conversation work. Confirm that Pidge replies in the original conversation with the commit summary and link.
6. Inspect Composio's delivery log and ask Pidge for recent app-event statuses. Confirm one completed run for that trigger log. If the dashboard offers redelivery, redeliver the same log. Expect a duplicate acknowledgement and no second execution.
7. Ask Pidge to disable that subscription and approve the change. Push a second harmless commit. Confirm no event work runs. Ask Pidge to remove the subscription and approve removal. Confirm the remote instance is absent in Composio.

To check write approval separately, create a test subscription whose saved instruction requests a harmless app write. Produce one test event. Confirm the exact action is parked for your approval and cancel it. Do not use a real recipient or production channel for this check.

## Recover an uncertain setup

If creation times out, Pidge keeps a `creating` or `uncertain` reservation and runs no events for it. Do not repeat setup, delete the reservation, or create a second remote instance.

Inspect the Composio instances for the exact user, connected account, event type, and configuration recorded on that reservation. If an instance exists, disable and delete that instance through Composio. Confirm that no matching instance remains. Only then mark the local reservation `removed` through an operator database change scoped to its ID and user ID. You can now start a fresh setup from chat with a new approval.

If remote removal times out, Pidge remains disabled locally. Inspect the remote instance before retrying cleanup. A disabled subscription stays disabled until removal. To change the instruction or configuration, remove it and create a new subscription.
