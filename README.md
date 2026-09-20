# Release Dependency Studio

A **local-only** workbench for selecting package changes and simulating which
downstream packages must be released in the same train. It never contacts a
package registry and never publishes anything.

```
npm install
npm run dev        # tsx API server (4174) + Vite UI (4173, /api proxied)
npm test           # vitest: 33 tests (semver, engine, HTTP API)
npm run build      # tsc --noEmit + vite build
```

## What it does

1. **Select changes** — pick workspace packages and a `major` / `minor` /
   `patch` bump (or set an explicit candidate version, including prereleases).
2. **Range-driven impact propagation** — for each dependency edge the engine
   checks whether the producer's new version satisfies the consumer's declared
   range:
   * in-range moves are absorbed (a caret eats compatible minor/patch moves)
     and force **no** synchronized release;
   * out-of-range moves minimally widen the declaration (`^`, `~`, pins,
     x-ranges, hyphen, `||` unions are all understood). The consumer's minimum
     response is one notch below the break where the range shape allows it, and
     keeps the producer's level through exact pins;
   * multiple propagation paths merge with the **maximum** required level, so
     the resulting plan satisfies every constraint at once.
3. **Reason chains** — every candidate carries BFS-shortest chains back to each
   seed that reaches it, with the edge, declared range, target version and the
   required response. Hops and manifest-change rows are clickable and jump to
   the exact edge in the graph.
4. **Incremental refine** — adjusting a candidate calls `/api/refine`, which
   recomputes only the reverse-affected subgraph and returns unchanged
   `Candidate` objects by reference (`reused`). A monotonic request sequence
   plus `AbortController` guarantees an older result can never overwrite a
   newer adjustment.

## Dependency kinds

| kind     | effect                                                                          |
|----------|---------------------------------------------------------------------------------|
| runtime  | out-of-range producer moves force the consumer into the train                    |
| optional | an absent optional package is skipped with a warning and never causes a release |
| peer     | never forces a release; constraints are aggregated per installed peer           |

Peer constraints over each release closure are checked against the installed
version and against each other:

* **mutually exclusive** ranges (`^17` vs `^18`) → `peer-mutex`;
* installed peer outside a declared range → `peer-unsatisfied`;
* a released peer moving out of a declaration surfaces the suggested widened
  declaration as a `peer-widen` manifest change *and* a conflict — peer
  incompatibility is never silently auto-resolved.

When nothing can satisfy the constraints, the API returns the **minimal
conflict subgraph** (smallest offending edge/node set), clickable in the UI.

## Other covered cases

* **cycles** — fixed-point propagation over cyclic dependencies; Tarjan SCC
  detection collapses cycles into one release wave (dependencies still ship
  before consumers on the condensed DAG).
* **prereleases** — full semver precedence plus the npm prerelease-tuple rule;
  pinned prerelease anchors move with the train.
* **private packages** — bumped for local consistency but marked
  `publish: false` with a warning.
* **external packages** — registry packages participate in peer/install
  checks but can never be selected for release.
* **concurrent graph edits** — the graph is stored at a fixed monotonic
  `revision`; every plan/refine/mutate request carries its base revision and a
  stale writer gets `409` with the current graph instead of overwriting it.

## API

| endpoint               | purpose                                             |
|------------------------|-----------------------------------------------------|
| `GET /api/graph`       | current graph + revision                            |
| `POST /api/graph/mutate` | atomic batch of add/remove edge/node ops; `409` on stale revision |
| `POST /api/plan`       | `{revision, seeds, overrides}` → full `Plan`        |
| `POST /api/refine`     | same body + session cache → `{plan, affected, reused}` |

## Layout

```
src/shared/semver.ts   own semver: parse/compare/satisfy/intersect/widen/bump
src/shared/planner.ts  fixed-point propagation, SCC, peer aggregation, refine
src/server/            express API + revisioned in-memory graph (fixture)
src/client/            React workbench: selection, SVG graph, candidates
test/                  semver, engine (all edge cases), HTTP API tests
```
