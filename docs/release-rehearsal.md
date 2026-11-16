# Rehearse an independent deployment

Status: backlog. The maintainer deferred the independent operator rehearsal on 2026-11-14. It is not completed validation.

Use this checklist to prove that another operator can run Pidge with their own accounts. Run it on an isolated deployment with synthetic data. Never reuse the original operator's line, project credentials, connected accounts, or production database.

A local install, tests, and build verify source compatibility. They do not satisfy this live rehearsal. Record only dates, the candidate commit, outcomes, and sanitized errors. Keep phone numbers, Connect Links, account IDs, message text, and secrets out of the evidence.

## Complete the rehearsal

1. Start from a clean candidate export and follow [Set up Pidge](setup.md) without copying files from another deployment. Record the Node and pnpm versions, candidate commit, and documentation gaps.
2. Run `pnpm install --frozen-lockfile`, `pnpm check` with a disposable `TEST_DATABASE_URL`, `pnpm build`, and `pnpm release:check`. Confirm they need no live provider credentials.
3. Provision your own Photon Stable project and line, Composio project, AI Gateway key, PostgreSQL database, and public HTTPS origin. Confirm callback requests reach the app without an upstream login redirect. Keep account verification and spending controls under your control.
4. Migrate the application database, create an owner, and start one persistent app process. Check the public `/eve/v1/health` route.
5. Text the line while unlinked. Confirm it returns a sign-in link and performs no app work. Sign in, complete linking, and send a new message. Confirm an ordinary harmless iMessage round trip.
6. Request a harmless read from one app you own. Confirm discovery, Connect Link handling, and successful continuation after connecting. Confirm the intended account is selected. Do not post, book, delete, or send anything as this smoke test.
7. Ask one public research question. Confirm the chosen model and Exa search work. Review provider usage to confirm charges land on your project.
8. Schedule one harmless iMessage a few minutes ahead in your timezone. Close the web browser and confirm the report arrives in the originating conversation. Remove the test schedule afterward.
9. Restart the isolated app once. Confirm sign-in, linked identity, and prior conversation remain. Confirm a harmless scheduled message still works. Keep the database, artifacts, and workflow store across that restart.
10. For the Undici override/provider compatibility check, exercise dynamic app discovery and connection-needed handling above. On the isolated account, request a harmless write, inspect its exact approval terms, then cancel it. Restart once while another harmless write approval is parked, then confirm its later approval fails closed without executing. Test the mixed read/write batch policy with the regression suite. This does not require a real third-party write.
11. If enabling owner notifications, use a new token. Confirm unauthenticated requests fail, a small authorized message reaches only your linked owner, and repeating the same idempotency key produces a duplicate response. Do not retry an ambiguous handoff blindly.
12. Stop test jobs and revoke disposable credentials when the rehearsal ends. Preserve only sanitized evidence.

## Record the result

The independent live rehearsal is **backlogged**, not passed. The maintainer deferred it on 2026-11-14. Do not replace pending evidence with a build result or historical verification from the original deployment.

| Evidence | Result |
| --- | --- |
| Operator and date, without private contact details | Pending |
| Candidate commit | Pending |
| Frozen install, disposable-DB checks, build, release scan | Pending |
| Independent account provisioning and callback | Pending |
| Unknown-sender link and linked iMessage round trip | Pending |
| App discovery, connect, and harmless read | Pending |
| Gateway model and Exa search | Pending |
| Scheduled delivery with browser closed | Pending |
| Persistence after isolated restart | Pending |
| Provider approval/cancel and parked-restart failure | Pending |
| Optional notification smoke or explicitly disabled | Pending |
| Setup corrections or remaining limitations | Pending |

Keep release approval separate from this checklist. Composio is the approved license holder and security contact. Public release timing still needs the repository owner's decision.
