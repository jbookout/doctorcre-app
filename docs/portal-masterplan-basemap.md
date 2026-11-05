# Master-plan overlay and basemap adapter

Card: WR227.S16.J1

## Contract and grounding

CARR schema, fixture, design and probes are pinned to
865fefee26fcbbe50a04c7515c5f3d3bc8913cd1. Assigned rows are A-T06, A-T08 and
A-A40. App main was 28a1a144cc6659b83617a19f06f504332570fe38. S10 PR #665
owns common types, map construction and bundling. The live map-architecture
verb was read. The existing self-hosted MapLibre assets are pinned at 6.4.1.

Replacing the whole style would require restoring every property layer.
The chosen design adds namespaced sources and layers to S10's existing map.
It owns no camera or selection. The host supplies a loaded map and protocol
registry. The input projection accepts the relevant validated package fields.

## System design

Architecture uses one controller and React controls. S10 owns map lifetime,
camera, property selection and permitted local layers. This controller owns
only namespaced overlay/vector resources and abortable reads. Rights arrive
separately from the trusted host, never as client package claims.

Capacity is bounded to 32 overlays, eight vector sources and 64 vector layers.
At ten times current load, limits refuse excess data before resource creation.
Each provider session allows two concurrent reads and 60 attempts per minute.
Overload refuses immediately, with no growing queue. Vector sources require
direct tile templates. TileJSON, symbols, glyphs and sprites refuse to local
fallback. Their support remains an explicit A-A40 gap.

Load spread follows renderer tile demand. The style loads before installation.
Style or tile failure restores local layers while preserving the host and list.
Overlay failures remove only owned resources. Visible status is the failure
alert. Tests cover failures and late completion.

Caching is n/a. Reads use no-store, omit credentials and refuse redirects.
Each response has a two MiB byte limit and five second timeout. No provider
content persists. Each failed read has at most one retry. Two failed attempts
open the publication's circuit permanently. Recovery requires a fresh mount.
Every attempt rechecks current rights. Unmount aborts all reads and listeners.

Availability uses the existing permitted local layers. The host must supply
them even for vector packages because the pinned schema has no fallback field.
No invented geometry or provider substitutes for them. Missing, future, expired,
over-90-day or mismatched rights refuse access. The receipt names provider/SKU,
terms, reviewer, dates, storage, fields, retention/purge, attribution, renderer,
export and quota gate. The host authenticates its provenance.

Scaling is per browser publication. Database access, N+1, queues and write
idempotency are n/a because no database read, business write or send exists.
Consistency uses immutable package data. Stale provider content is not cached.
Resource replacement is idempotent and cannot alter camera or property selection.

## Throughput checkpoint

1. Blocking steps were source pin, doctrine, main and S10 inspection.
2. Independent streams are n/a because the brief forbids children.
3. Shared map state remains with S10. Only new S16 files change here.
4. One controller plus controls is the smallest safe decomposition.

## Statechart and integration

The checked model covers local, loading, vector, fallback and disposed states.
Overlay visibility is independent. Transition tests check cancellation and
stable context. Model scope excludes renderer internals and actual rights.
TLC reached 16 states and 52 steps. StableContext, Licensed and NoDeadlock held.
Run the pstack statechart script with test/models/masterplan/Basemap.tla and
its Basemap.cfg in a fresh output directory to reproduce the report. The coarse
chart omits overlay toggles, authorization and terminal self-transitions.

The committed synthetic fixture extends the pinned fixture's overlay with a
polygon, road-context line and dashed closure line. The GeoJSON schema permits
these features. No client reference source was copied into this checkout.
Controls provide project-opening buttons; reference floating-label positioning
and full private visual parity remain unproven.

S10 must mount the controls after map load, pass the same map and MapLibre
protocol registry, and retire the controller before removing the map. No sibling
files are modified. This adapter is not yet reachable from the publication.
Private parity and deployed proof remain the coordinator's integration work.
