Card: WR39.S1.J37

Base e85b379f. Synthetic fixtures only.

Browser reproduction before the fix found active INPUT and headingFocused false after pressing Enter in the password field. The keyboard regression was committed first as 6a34c4e1 and failed with false !== true at the heading focus assertion. After the fix it passes across 390 and 1280, light and dark.

Checks passed locally:

- node scripts/prepare-offline-tour.mjs
- node --test test/client-portal-browser.test.mjs test/client-portal.test.mjs. 18 pass, zero failures or skips.
- npm run check
- npm run lint
- node scripts/check-typed-surfaces.mjs origin/main
- git diff --check

Inspected all four committed PNG captures. The roadmap heading has visible focus, the shared text remains view-only, and the browser asserts no horizontal overflow. Held response tests cover retained unlock focus, moved Lock focus, lost focus, locking, a late obsolete response after a new unlock, page retirement, session invalidation, and mismatched slugs. Existing refusal, password clearing, nonpersistence and safe text tests stay green.

The app has neither run.sh pre-pr nor ops/ci.sh. App-specific checks above apply. The typed surface check requires the base argument; its initial invocation without one was rejected, then passed with origin/main. Shared node_modules lacked current dependencies; an isolated npm ci repaired preparation. Preview automation reported unavailable, and opening about:blank was rejected as an invalid preview URL. Verification used the existing headless Chromium fixture runner instead.

No staging or production verification. Independent review and taste approval are coordinator follow-ups.
