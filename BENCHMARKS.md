# Benchmarks

Methodology, results, and known limitations for the measurements behind this repo's concurrency-handling and data-structure decisions. Every script here is committed and runnable (`npm run bench:*`); every result file under `bench/results/` is raw output, not a cherry-picked summary.

## Environment

All numbers below were captured on:

- AMD Ryzen 5 3400G (4C/8T), 21GB RAM, Linux 6.8.0 (Ubuntu 22.04)
- Node v22.21.1
- Redis 7.4.7 (Redis Stack, standalone), `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`
- Client and server on the same machine (loopback), idle `redis-cli --latency-history` noise floor of 0ms at this resolution

Absolute timings are specific to this machine. The comparisons (X vs. Y under identical conditions) are the actual claim; commands-per-op and memory-byte counts are exact regardless of hardware.

## §1.0.3 — No-op control

`bench/noop-load.ts` — `npm run bench:noop`. Establishes the throughput/latency ceiling of the app's own HTTP + session-middleware pipeline (which touches Redis on every request via `src/hooks.ts`), independent of any bid-concurrency strategy — so later experiments' results can be told apart from "the app itself saturated." Raw: `bench/results/noop-baseline.json`.

## Experiment A — Concurrency & correctness

`bench/bids-concurrency.ts` — `npm run bench:a`. 150 runs: 3 strategies (naive / optimistic / lock, equalized 5-attempt/5-25ms-jitter retry budget) × 5 concurrency levels (10/50/100/250/500) × 10 repeats. Oracle: N bids with unique amounts fired concurrently at one item; a correct implementation always ends at `price == max(amounts)` regardless of internal processing order, since nothing submitted can exceed the global max.

| Strategy | Violation rate @ N=500 | price_deficit @ N=500 (median) |
|---|---|---|
| naive | 100% | 356 |
| optimistic | **0%** | **0** |
| lock (equalized budget) | 100% | 7 |

A fourth, informal arm (`bench/bids/lock-prod-budget.ts`) re-ran `lock` at production's real 20-attempt/fixed-100ms budget: worse on every axis (80-100% violation rate at N≥50, 5-15x slower per batch), traced to the unjittered retry delay causing waiting clients to synchronize into thundering-herd rounds — a larger nominal budget doesn't help if most rounds only produce one winner regardless. Raw: `bench/results/experiment-a.json`, `experiment-a-lock-prod-budget.json`.

**Outcome:** production (`src/services/queries/bids.ts`) uses optimistic transactions, not a lock — a decision this data drove, reversing what the code's own prior commit history had assumed ("the lock provides a higher success rate than the watched pipeline").

Building this harness also found and fixed two real correctness bugs, both "claims success, writes nothing": a missing `await` on the lock strategy's write batch, and `withLock` silently returning `undefined` instead of throwing when its retry budget was exhausted.

## Experiment D — HyperLogLog memory & accuracy

`bench/hll-memory.ts` — `npm run bench:d`. `items:views#<id>` (HLL, the app's real key) vs. an equivalent Set, at 1k/10k/100k/1M unique viewers.

| Scale | HLL | Set | Ratio | PFCOUNT error |
|---|---|---|---|---|
| 1,000 | 2,624 B | 48,320 B | 18.4x | 0.30% |
| 10,000 | 14,400 B | 531,200 B | 36.9x | 0.54% |
| 100,000 | 14,400 B | 5,572,992 B | 387.0x | 1.06% |
| 1,000,000 | 14,400 B | 48,388,736 B | **3,360.3x** | 0.06% |

HLL memory plateaus at 14.4KB between 10k and 1M — Redis's sparse→dense encoding switch, not a measurement artifact. Raw: `bench/results/experiment-d.json`.

## Experiment B — Sustained contention (real HTTP, k6)

`bench/k6/contention.js` (load) + `bench/k6/run-protocol.sh` (orchestration: 30s warmup discarded + 60s measured per run, `CONFIG RESETSTAT` fired as the measured window starts) + `bench/k6/aggregate.ts` (parses the raw `--out json=` stream, discards anything before the measured window, computes median + IQR across repeats) — `npm run bench:b && npm run bench:b:aggregate`. Real HTTP through `/bench/bid`, hot-item workload (sustained bidding on one item — "the case that matters" per the design). **Scoped down from the full 6-level × 5-repeat protocol** (would be ~90min) **to N ∈ {1, 100, 500} × 2 repeats** (~18min) — Experiment A had already produced the decisive correctness finding, so the full sweep's marginal value didn't justify the time; this scope is enough to confirm or refute a crossover.

| Strategy | N | Raw req/s | **Accepted/s** | p50 | retry-exhausted/60s |
|---|---|---|---|---|---|
| lock | 1 | 341.4 | 341.4 | 2.4ms | 0 |
| lock | 100 | 713.1 | **52.3** | 145.3ms | 39,338 |
| lock | 500 | 810.4 | **4.9** | 600.8ms | 48,290 |
| optimistic | 1 | 347.1 | 347.1 | 2.2ms | 0 |
| optimistic | 100 | 455.3 | 418.8 | 206.8ms | 0 |
| optimistic | 500 | 478.4 | 429.0 | 1039.5ms | 0 |

**Raw throughput is actively misleading here, which is the actual finding.** At N=500, lock posts a *higher* raw req/s than optimistic (810 vs 478) and a *lower* p50 (600ms vs 1040ms) — read naively, lock looks faster. But a retry-exhausted request fails in ~125ms and still counts as one completed request, so a strategy that mostly fails posts a high raw number for doing almost nothing. Looking at what actually got accepted: lock delivers 4.9 successful bids/sec at N=500 versus optimistic's 429 — about **1% of optimistic's real throughput**, at the same concurrency, on the same hardware. No crossover at any tested level; optimistic wins or ties everywhere. Raw: `bench/results/experiment-b.json`.

## Experiment C1 — Exact command counts

`bench/command-count.ts` — `npm run bench:c1`. `CONFIG RESETSTAT` → 1000 sequential (uncontended) ops → `INFO commandstats`, parsed per-command rather than summed blindly — a Lua script's internal `redis.call()`s show up as their own `cmdstat_*` entries, so a naive sum of every line conflates server-side script execution with actual client-server round trips.

| Path | Round trips/op |
|---|---|
| `incrementView` (Lua) | **1.000** |
| `incrementView` (naive, unscripted) | 2.972 |
| `createBid` (production, uncontended) | 7.001 |

The 2.972 (not a flat 3) is real: ~1.4% of `PFADD` calls don't register as "new" per HyperLogLog's internal sketch behavior, identically in both the Lua and naive paths — cross-validating that they're doing the same underlying work, not noise. Raw: `bench/results/experiment-c1.json`.

## Threats to validity

- Single Redis node — no failover/replication tested.
- Optimistic transactions' retry budget (5 attempts, 5-25ms jitter) was chosen to match the equalized-budget lock for a fair A/B comparison, then kept in production because it measured well — not independently tuned as an optimum.
- All experiments ran client-and-server on one machine (loopback, ~0ms idle RTT). This doesn't affect Experiment A/C1/D's correctness or command-count claims (they don't depend on RTT), but a future latency-based experiment needs real network RTT to mean anything.
- HyperLogLog counts are approximate (~0.81% standard error, per Redis's documented behavior); the four data points above are each a single sample per scale, not a distribution.
- Experiment A's bid amounts are synthetic and uniformly distributed (1..N); real auction bidding is bursty and clustered near a closing time, not modeled here.
- `src/services/redis/lock.ts` (kept for the benchmark suite, no longer used by production) is single-instance — not Redlock, and makes no safety claim across a Redis failover.

## Reproducing

```bash
docker-compose up -d
npm install
npm run bench:noop   # §1.0.3 no-op control
npm run bench:a      # Experiment A (~a few minutes)
npm run bench:d      # Experiment D
npm run bench:c1     # Experiment C1

# Experiment B needs the dev server running separately, and k6 installed
# (this repo used the static binary, no sudo: see bench/k6/run-protocol.sh)
npm run dev &
npm run bench:b            # full protocol: 6 levels x 2 strategies x 5 repeats, ~90min
npm run bench:b:aggregate  # writes bench/results/experiment-b.json
# or scope it down, e.g.:
CONCURRENCY_LEVELS="1 100 500" REPEATS=2 npm run bench:b   # ~18min
```

Each writes its raw results to `bench/results/`, overwriting the committed ones — diff before committing a re-run.

## Status

Done: §1.0.3 (no-op control), §1.0.1 (three strategies), §1.0.2 (deterministic reset), Experiment A, Experiment D, Experiment C1, Experiment B (scoped).

Not yet built: Experiment C2 (netem RTT sweep), Experiment E (search), CI regression gate. AWS deployment and the observability dashboard were deliberately dropped — redundant with two other portfolio projects (`automated-monitoring-stack`, `zero-credential-pipeline`) that already cover Terraform/AWS and Prometheus/Grafana; see `project_plan.md` in the planning directory for the reasoning.
