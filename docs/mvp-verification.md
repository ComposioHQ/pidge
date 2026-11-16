# Video MVP verification

This is a sanitized record of historical live tests on 2026-11-04 and 2026-11-05. The tests used real Photon Stable iMessage delivery, Composio, AI Gateway models, and one self-hosted deployment. They have not been repeated for the public release or on another operator's accounts. Private addresses, phone numbers, account/session/run/channel IDs, booking confirmations, and itinerary details are omitted.

The original evidence came from Eve session streams, application database rows, service logs, and operator confirmations. This summary preserves the observed failures and limits. It is not a transcript or a current release certification.

## Video acceptance

| Experiment | Historical result |
|---|---|
| Restaurant research with real availability | Passed over iMessage. Clarifying questions and a later corrected search returned real options. |
| Mid-task change to four people at 8 PM, followed by an approved reservation | Passed only with the operator's scope exception in D13. Steering replaced the active research task. Two approved reservations completed in separate attempts and were cancelled. One used a different time from the script, and the other used the wrong date. The final corrected-date run stopped at a correct approval that the operator declined. |
| Next-afternoon booking details and directions while the laptop is closed | Not run as scripted. Proactive scheduled delivery passed separately, including recovery after downtime. With no kept booking, Pidge correctly refused to invent booking details. See D13. |

## Phase 1: identity and conversations

An unknown iMessage sender received a one-time link, signed in, linked the handle, and started an authenticated conversation on a new inbound message. Bot and group checks remained at the Photon boundary.

A replay of a captured, correctly signed Photon event did not create a second turn or reply. An altered body failed signature verification. The temporary capture was removed afterwards.

Two near-simultaneous research messages reached the same turn. The second changed the requested area. The reply answered only the updated request. A Tapback tool call produced a heart reaction without a text reply.

Photos and screenshots arrived as `image/heic` file parts. The model reported that it could not view that format rather than inventing image content. HEIC conversion remains unimplemented. See D8.

Two temporary member accounts exercised web chat. User A created a chat and received the requested response. User B could use B's own stream and could not access A's chat or session.

| Request by user B | Result |
|---|---|
| `GET /chat/<user-a-session>` | 404 |
| `POST /api/chat/token` for A's session | 404 |
| A's Eve stream with B's valid token | 403 |
| Send to A's Eve session with B's valid token | 403 |
| B's own stream | 200 |
| Stream without a token | 401 |

The temporary accounts were deleted after testing. These checks do not establish complete multi-user isolation across every Phase 5 feature.

## Phase 2: Composio discovery, connections, and approvals

With Slack disconnected, a request to post a test message caused tool search followed by a Connect Link. The agent did not claim that it had posted. After connection and a new message from the operator, the agent rechecked the account and searched for the channel. A private channel required clarification from the operator. The eventual `SLACK_SEND_MESSAGE` call paused for approval, showed destination and text, and posted only after a like Tapback. The operator confirmed receipt.

A separate cross-app request read Linear issues and emailed the result through Gmail. Only the missing connections were requested. Paginated reads needed no approval. The Gmail approval showed the recipient, subject, and beginning of the body; the send executed after approval and the operator confirmed receipt.

Action-audit rows recorded tool slug, risk, approval status, outcome, and Composio log reference, without tool arguments or results. No app-specific Slack, Gmail, or Linear integration code was needed.

Two findings led to fixes:

- Connection status/list actions had required approval. The policy now treats these as reads.
- The model once referred to narration and Connect Links that the recipient had never received. iMessage delivers only the final reply. Instructions now require returned raw URLs in the final reply and forbid references to unsent narration.

## Phase 3: browser research, steering, and approved booking

A mid-errand change superseded the first hosted research run, stopped it through Composio, and started a corrected run in the same application errand. The reply covered only the new constraints.

Approved OpenTable booking attempts reached `booking/details` but never saw the guest contact form. Headless access also returned "Access Denied". No booking was submitted and Pidge reported failure. The application now refuses OpenTable commit runs before asking for approval. Research remains allowed. SevenRooms and restaurant-hosted forms were reachable in these tests. See D11.

A guest form introduced an unapproved deposit. The hosted task stopped before submission, so nothing was charged. A later approved guest booking completed with the approved terms. Another attempt completed on the wrong day because the model reused an older interpretation of "tomorrow". Both completed reservations were cancelled by the operator.

SevenRooms field entry initially failed repeatedly. Indexed and JavaScript-set values were ignored or reached the wrong field. The application split committing work into two tasks in one hosted browser session:

1. Prepare navigates to the form, enters no contact data, and must return `READY`.
2. Complete receives a fresh step budget, fills one field at a time using keyboard entry, checks the values, and submits once.

Contact details appear only in the completion phase. A smoke test without stored contact details reached the form and then stopped to request those details. It did not book anything.

The first date fix supplied a system-role date anchor, but an older errand still caused the wrong date to be copied into a later approval. The operator approved that incorrect date. A second fix added a user-role date anchor immediately before each incoming message. The final test resolved the date correctly, superseded active research after steering, and presented the intended time and party size in the approval. The operator declined that approval, and no commit task started. Pidge then refused to schedule details for a booking that did not exist.

Composio Instant charges remained absent in the observed browser-run records. A 25-step task limit is not a dollar budget. F8 in [spike.md](spike.md) remains unresolved by these historical tests.

## Phase 4: schedules and restart behavior

A recurring iMessage job stored a timezone-aware cron schedule, ran from the minute dispatcher without another inbound message, delivered the requested text, and advanced its next occurrence. The run record reached `completed`. DST behavior also has automated tests in `shared/schedules/recurrence.test.ts`.

An unlinked destination was recorded as `suppressed` without a send. A one-time job due while the service was stopped ran on the first dispatch tick after startup. The operator confirmed a single delivery.

An interrupted browser research task recovered after restart. Eve re-enqueued its workflow, but the in-flight step remained owned by the old process until the default 860-second inline lease expired. The retry found the existing remote task finished and returned its result. The database held one remote run, with no duplicate start. Recovery took about 14 minutes. Scheduled-run leases are 20 minutes. See D12.

A Composio write approved just before restart completed once. After the interrupted step resumed, the provider refused to replay it with `Composio tool "COMPOSIO_MULTI_EXECUTE_TOOL" has no executor in this process`. The agent requested fresh approval. An approval parked across a second restart also failed closed and produced no write.

The application adds its own `approval_guards` check rather than relying on that provider failure. Calls can execute once and only in the process that parked their approval. A missing, already-started, or previous-process approval fails closed and asks for a fresh decision. Automated coverage lives in `agent/lib/composio/client.test.ts` and `db/services/approval-guards.test.ts`.

## Remaining limits

These tests did not complete Phase 5 or Phase 6. They do not demonstrate Composio triggers, profile memory, workstreams, 1Password/browser-vault flows, production retention and backups, every tenant-isolation scenario, or an independent fresh deployment. The exact three-experiment video script was not completed end to end. The experimental release must disclose those limits and keep the historical evidence separate from its current validation results.
