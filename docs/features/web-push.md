# Web push

Card: WR617.S3.J6

## System design before implementation

The browser owns one typed setup controller and the service worker owns presentation and navigation. CARR owns actor-scoped subscription records and partner-needed eligibility. This slice uses a synthetic transport, not speculative live RPC contracts. Live setup remains unavailable until the producer revisions and schemas are pinned after P3/P4a merge.

The controller compares a receipt with the current browser endpoint and separately commits the existing notification preference using its observed base_version. A successful registration alone never means enabled. Disable commits the preference first. Uncertain registration and revoke requests retain their operation UUID and exact request in session-bound storage for explicit retry. Logout clears that binding and retires pending work.

There is no new interval. Load and visible resume reconcile at most once per minute. Reconciliation reads configuration plus subscription/preference state, never per-card state, and never prompts or blindly subscribes. A deliberate Enable tap alone requests permission and creates a subscription. Denied permission requires browser settings. iOS outside an installed app gets installation guidance.

Notification data contains only event identity and its canonical encoded Inbox route. Titles and bodies are generic. A tag coalesces the same event. A tap navigates through the ordinary authentication gate. Home reads fresh state and uses read-partner-needed-card only when the exact card is absent from its bounded snapshot. No approval operation is dispatched.

## Acceptance rules and named tests

| Rule | Named test |
| --- | --- |
| Architecture and receipt consistency | browser_state_matches_server_receipt |
| One installation per browser profile, three per actor remain server authority; no added polling | no_interval_added |
| Reconcile without duplicate registration | repeated_resume_does_not_reregister |
| No persisted business payload or private key | logout_clears_installation_binding |
| Distinct unavailable, denied and unsupported states | registration_failure_truthful |
| Stable event tags | distinct_cards_remain_distinct |
| Bounded setup reads | setup_request_count_bounded |
| Server preference is send authority | disabled_preference_overrides_local_subscription |
| Recoverable partial success | partial_success_reconcile |
| No automatic failure retry | failure_does_not_loop |
| One active setup operation | double_click_single_registration |
| Replay uncertain operation | unknown_result_reuses_key |

## Verification limits

Synthetic transport and browser capability fakes cannot prove delivery by a push provider or iOS installation behavior on hardware. Live adapters must pin P3/P4a, validate their response schemas and preserve existing authenticated RPC timeouts before rollout. Session storage intentionally gives a session-bound installation identity; the server must enforce endpoint uniqueness and its three-installation cap across sessions.

## Design and debt pass

Codebase Design compared page-owned subscription state with a controller at the browser and transport seam. The controller keeps reconciliation, replay and preference ordering together. The settings island renders status and deliberate actions.

Zero Tech Debt removed the old form's independent device-opt-in write. Quiet-hours saves now leave the send preference unchanged. The disabled checkbox reports the saved preference. No new navigation or Home source discriminants were added.

## Model verification

TLC explored 34 states and 61 steps. EnabledMeansConfirmed, DeniedNeverRegisters, OneActiveOperation and NoDeadlock held. The readable chart combines states by visible status and hides 11 steps that stay within the same status, including registration progress and terminal stuttering. The model abstracts browser APIs, network bytes, logout and endpoint authorization. Executable tests cover those seams with synthetic adapters.

The model's initial permission check is implicit. The application starts at unavailable while it reads. Configuration and unavailable states do not authorize a write. The chart records the checked interaction model, not every possible lifecycle transition.

The following finite TLA+ model and configuration reproduce the check with the installed pstack statechart tool. Save the blocks as WebPush.tla and WebPush.cfg in a scratch folder, then run `statechart WebPush.tla --out result`.

```tla
--------------------------- MODULE WebPush ---------------------------
EXTENDS Naturals
VARIABLES state, preference, receipt, permission, pending
vars == <<state, preference, receipt, permission, pending>>
Init == /\ state = "permission_default" /\ preference = FALSE /\ receipt = FALSE /\ permission = "default" /\ pending = FALSE
Enable == /\ state \in {"permission_default", "preference_disabled", "revoked", "unavailable"} /\ permission # "denied" /\ state' = "registering" /\ pending' = TRUE /\ UNCHANGED <<preference, receipt, permission>>
Deny == /\ state = "registering" /\ state' = "permission_denied" /\ permission' = "denied" /\ pending' = FALSE /\ UNCHANGED <<preference, receipt>>
Register == /\ state = "registering" /\ ~receipt /\ receipt' = TRUE /\ permission' = "granted" /\ UNCHANGED <<state, preference, pending>>
PreferenceOK == /\ state = "registering" /\ receipt /\ state' = "subscribed" /\ preference' = TRUE /\ permission' = "granted" /\ pending' = FALSE /\ UNCHANGED receipt
PreferenceFail == /\ state = "registering" /\ receipt /\ state' = "preference_disabled" /\ preference' = FALSE /\ pending' = FALSE /\ UNCHANGED <<receipt, permission>>
RegisterFail == /\ state = "registering" /\ state' = "unavailable" /\ pending' = FALSE /\ UNCHANGED <<preference, receipt, permission>>
Disable == /\ state = "subscribed" /\ preference' = FALSE /\ state' = "preference_disabled" /\ UNCHANGED <<receipt, permission, pending>>
Rotate == /\ state = "subscribed" /\ state' = "revoked" /\ receipt' = FALSE /\ UNCHANGED <<preference, permission, pending>>
Settings == /\ state = "permission_denied" /\ state' = "permission_default" /\ permission' = "default" /\ UNCHANGED <<preference, receipt, pending>>
Unsupported == /\ state = "permission_default" /\ state' \in {"unsupported", "not_installed"} /\ UNCHANGED <<preference, receipt, permission, pending>>
Done == /\ state \in {"unsupported", "not_installed"} /\ UNCHANGED vars
Next == Enable \/ Deny \/ Register \/ PreferenceOK \/ PreferenceFail \/ RegisterFail \/ Disable \/ Rotate \/ Settings \/ Unsupported \/ Done
EnabledMeansConfirmed == state = "subscribed" => preference /\ receipt /\ permission = "granted"
DeniedNeverRegisters == permission = "denied" => state = "permission_denied"
OneActiveOperation == pending = (state = "registering")
Spec == Init /\ [][Next]_vars
=====================================================================
```

```text
SPECIFICATION Spec
INVARIANT EnabledMeansConfirmed DeniedNeverRegisters OneActiveOperation
```
