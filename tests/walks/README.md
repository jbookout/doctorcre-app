# Partner walks

These specs use the production app and Playwright Test directly. They import no staging or live test infrastructure. Each numbered spec retains its original acceptance steps and source PR links in `walks.json`.

Run both commands from `/tmp/wr622-s2-j7-walks`. The first opens the real sign-in UI for Joe. It waits up to five minutes. The second reuses that session without running setup again.

```sh
npx playwright test --config tests/walks/playwright.config.ts --project=setup --headed
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/WR622.S2.J7-results.json npx playwright test --config tests/walks/playwright.config.ts --project=walks --no-deps --reporter=list,json
```

The setup follows [Authentication, Basic shared account](https://playwright.dev/docs/auth#basic-shared-account-in-all-tests), including the setup project, dependency and `storageState`. Running only the setup project and later using `--no-deps` follows [Test projects, Dependencies](https://playwright.dev/docs/test-projects#dependencies). The state file stays outside Git at `/Users/booko/.config/doctorcre-walks/state.json`. Its directory is mode 700 and its file is mode 600.

Read-only walks find names starting with `TEST`, `[test]` or `QA` through the app. Mutation walks require names starting with `TEST WALK <number>` or `QA WALK <number>`. Before a mutation, the shared helper matches contract-parsed inbox item and action IDs to the owning deal ID on the numbered TEST deal in the Deals list. The context guard admits only that walk's operations and exact verified IDs, including batch undo identities. Numbered-looking action titles on ordinary deals skip. Drafts whose canonical inbox contract exposes no owning deal remain skipped. Service workers are blocked. Each mutation walk owns its numbered records. This prevents the two workers from changing each other's records. No walk creates prerequisite business records. Missing prerequisites produce a named skip. A skip does not certify the walk. Walks requiring unavailable native receipts or private manifests remain explicitly skipped rather than asserting a weaker app-only check.

Screenshots, traces and videos are off. `PLAYWRIGHT_NO_COPY_PROMPT` also disables Playwright's automatic failure DOM snapshot. Every spec imports the automatic privacy fixture, which guards the whole context, including secondary pages, and removes private locator diagnostics before the stock reporters run. HTTP error annotations retain only resource type and status, so an edge error page or failed module is distinguishable from an absent control. Assertions retain booleans, counts and IDs only. Do not enable verbose API debugging, browser console forwarding or DOM snapshots for a production run.

`node --test test/walk-privacy-browser.test.mjs` checks consecutive spec files, secondary pages, blocked writes and failure redaction against a synthetic loopback server without a saved session.

List tests without signing in or opening a browser:

```sh
npx playwright test --config tests/walks/playwright.config.ts --list
```

With no saved session, the walk command refuses at configuration loading with `no saved session`, before a browser or network call.

`walks.json` distinguishes implemented walks, partial walks that deliberately end in a skip, and skipped walks. Partial walks exercise only the stated portion and never pass the full acceptance. The current source does not provide every independent receipt requested by the original human walks. This suite is partial coverage of those acceptance steps.

The authentication flow is `no session -> human sign-in -> saved session -> isolated walk context`. Missing state with `--no-deps` refuses before launching a browser. The saved state is reused by both workers. Session invalidation tests clear cookies only in their own context. The sign-out walk stays skipped because server sign-out can revoke the common session.

Notification discovery waits for the feed state to become ready, empty or no_match. Unavailable, refused and stuck-loading feeds fail. Deal discovery waits for the rendered opening snapshot, and Tours discovery waits for a list or a successful empty state before counting prerequisites.

Without a designated TEST deal, MCP POSTs are limited to the exact `readOnlyVerbs` names in `privacy.ts`. Other methods and envelopes are refused. Each name must exist with `write: false` in `test/fixtures/walk-verb-registry.json`, a name/write projection of the deployed list-verbs response recorded by J15 at the release SHA in that file. On a registry change, refresh that recorded response and release provenance together, then run the browser regression. It fails if any allowlisted name is absent or write-flagged. New names require explicit admission; naming prefixes grant no access. This snapshot check does not detect unrecorded deployment changes.
