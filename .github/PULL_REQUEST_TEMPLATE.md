Card: WRn.Sn.Jn

Bot-authored PRs are exempt from the Card requirement; docs PRs still need a Card.

## What changed
<!-- Describe the user-visible change or repair. -->

## System design
<!-- Before code, write a short note answering these questions. What are the components, their interfaces, and the data each owns? What capacity do we need today and at 10x, and what breaks first? How is load spread? What is cached, and how is it invalidated and evicted? Which operations run in sequence or in parallel, and what happens when each part fails? How does the system scale? What are the storage access patterns and N+1 risks? For each piece of data, do we serve stale data or refuse? What goes on a queue, and who produces and consumes it? For every external call, what are the circuit breaker's failure threshold, fallback, and alert? What rate limit bounds every loop, fan-out, and external API call? What idempotency key protects every write or send? Use "n/a: <reason>" where a question does not apply. Give each answered rule a test that fails when the rule is broken. Proceed without waiting for design approval. -->

## How verified
<!-- Name the checks and any remaining limits. -->

## Production proof
<!-- Name one runnable declaration, for example proofs/requirements/app-proof-admission.json.
Use the pinned contracts/production-proof-plan.v1.json runner registry and safety budgets.
For paths exempted by that contract, write n/a: followed by a concrete reason instead. -->
proofs/requirements/<change>.json
