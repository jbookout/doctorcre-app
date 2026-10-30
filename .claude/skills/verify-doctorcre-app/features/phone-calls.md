# Phone capture

## Sub-features

Recording import, Tours microphone capture, scoped pending audio, authenticated session review, explicit candidate confirmation, and applied changes with Undo.

## How to get to it (user POV)

Open More, then Phone capture. Confirm recording consent, choose a native recording or voice memo, and enter the original recording and consent times. Save recording keeps audio on this device. Transfer recording retries admission and transfer without clearing audio until confirmed. Record microphone captures in-person audio or a post-call recap. Stop recording leaves audio available to review before transfer.

Open the review link on another device signed in to the same authorized partner account. Refresh review checks processing and filing. Pending single-track items need partner confirmation. Undo uses the current applied change and deal version.

## Driving it with Playwright

Run `node --test test/phone-call-browser.test.mjs`. It uses the existing fixture server and browser harness with synthetic WAV bytes and a synthetic microphone. It drives import, reload, unavailable transfer, verified transfer, incorrect receipts, partner isolation, microphone interruption, review links, explicit confirmations and Undo. Four review screenshots cover 390 and 1440 pixels in light and dark under `out/test-artifacts/phone-calls/`.

## Gotchas

Server PR DoctorCRE/carr-system#2721 must be merged and deployed first. It provides individual session reads but no session list. Review needs the original link or session ID. Only pending audio is stored locally, scoped by origin and the verified partner slug. Logout fences the active controller; it does not delete an untransferred recording. Calls configure the shared recorder for 60 minutes and 50 MiB; Tours retain ten minutes and 25 MiB. A limit stop is saved and labelled on the row. Screen Wake Lock is requested while recording and again on return to the page. Hiding without a held lock saves and labels the interruption. Imported recordings allow up to 60 minutes and 50 MiB. Native export of both cellular call sides, device interruptions, browser storage eviction and signed-in remote persistence require separate real-device proof. The pinned producer exposes Undo only for unreviewed automatic changes. Human-confirmed changes remain readable but must be revised on the deal. No Outlook draft is created.
