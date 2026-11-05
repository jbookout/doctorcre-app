# System design before code

The audit returns source violations. The parser owns syntax and lexical bindings. The scanner owns tracked-file enumeration. Receiver classification is trusted harness, locally defined method, or unknown. Unknown includes all external imports, re-exports, aliases, dynamic imports and require calls. Import spelling cannot exempt a call.

| Receiver and operation | Arguments | Verdict |
| --- | --- | --- |
| Pinned harness Chromium/WebKit direct launch | Any | Accept, harness injects safety args |
| Locally defined method or native audio connection | Any | Accept, independently scan its body |
| Unknown launch, persistent launch or connect | Verified shared constant or leading shared spread | Accept |
| Unknown launch, persistent launch or connect | Anything else | Reject |
| Unknown escaped/computed browser method | Any | Reject |
| Parse error or changed pinned harness | Any | Reject |

Only the canonical shared import proves args. Literal flag arrays are rejected under the Round 3 direction. Existing safe launch sites must pass the complete repository scan. Local method proof follows constant bindings and single-return local factories with no method writes. The only native receiver proof is an unshadowed AudioContext oscillator used by the synthetic tour recording.

Alternative designs considered were transitive import resolution and receiver-independent default refusal. Import resolution would require a project-wide module graph and still leave runtime specifiers unknown. Default refusal makes spelling irrelevant and keeps one private audit interface.

Parsing is local and linear in source size; bounded lexical factory resolution refuses cycles. At 10x load parsing dominates. No remote calls, caching, queues, persistent storage, fan-out or distributed consistency apply. Fixture subprocesses run sequentially with a 30-second deadline and finally cleanup. Writes are synthetic temporary Git fixtures only. The board navigation behavior stays unchanged.

Throughput checkpoint. One builder, no subagents. First reproduce complete-source fixtures, then change the scanner, then run safety and board suites plus check and typed surfaces, then push once and read hosted CI once.
