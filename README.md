# rbay

A real-time bidding/auction platform (SvelteKit) where **Redis is the sole persistence layer** — no relational or document database sits underneath it. Every entity (users, sessions, items, bids, likes, views) is modeled directly as a Redis data structure, chosen per access pattern rather than defaulted to a single generic store.

## Why Redis as the system of record

Rather than using Redis as a cache in front of another database, this project pushes each feature onto whichever native Redis data structure fits its access pattern:

- **Hashes** for entity records (`items#<id>`, `users#<id>`) — direct field reads/writes without serialization overhead.
- **Sorted sets** as secondary indexes — items by price, by view count, by ending time, and username → user ID lookup — giving O(log N) ranked/range queries without a separate index table.
- **Sets** for membership and relations — username uniqueness, per-user likes, and set intersection for "items liked in common."
- **Lists** for append-only bid history per item.
- **HyperLogLog** for unique-viewer counts — O(1) memory per item regardless of view count, instead of storing a full set of viewer IDs.
- **RediSearch** for full-text + faceted item search with weighted relevance and multi-field sorting.
- **Lua scripting** for operations that need to be atomic across multiple keys in one round trip.

## Concurrency handling

Concurrent bids on the same item are the one place a naive read-modify-write breaks correctness (lost updates). Two approaches were built:

- **A custom distributed lock** (`SET NX PX` + a Lua-scripted unlock that only deletes the key if the token still matches, `src/services/redis/lock.ts`) — the original approach. It hands the callback a `Proxy`-wrapped client that throws once the lock's timeout has elapsed, and throws itself if its retry budget is exhausted without ever acquiring the lock. It's kept in the codebase as a utility but is no longer used by bid creation.
- **Optimistic transactions** (`WATCH`/`MULTI` with a jittered retry loop, `src/services/queries/bids.ts`) — **what bid creation actually uses now.** A dedicated benchmark suite (on this repo's [`bench`](../../tree/bench) branch — full methodology and raw numbers in its `BENCHMARKS.md`) measured both approaches under real concurrent load and found the lock lost outright: it never corrupted data, but it failed to admit the correct winning bid in up to 100% of trials at high concurrency, and got *worse*, not better, under its own real (larger) retry budget, because unjittered retries synchronize waiting clients into thundering-herd rounds. Optimistic held zero lost updates and zero price deficit at every concurrency level tested, up to 500 simultaneous bidders, and was switched to in production on that basis.

## Features

- **Auth** — signup/signin with `scrypt` password hashing, cookie-signed sessions (`keygrip`) backed by session records in Redis.
- **Items** — create, fetch by ID, list, sort by price / views / ending-soonest, and a per-user dashboard view.
- **Bidding** — concurrency-safe bid creation (see above) plus full bid history per item.
- **Likes** — like/unlike an item, and look up items liked in common between two users via `SINTER`.
- **Views** — unique-view counting via HyperLogLog, feeding a "most viewed" ranking.
- **Search** — RediSearch query across item name/description, with name weighted above description in relevance scoring.
- **Page caching** — rendered HTML for a handful of static routes (`/about`, `/privacy`, auth pages) cached directly in Redis.

## Data model

| Key pattern | Structure | Purpose |
|---|---|---|
| `users#<id>` | Hash | User record |
| `sessions#<id>` | Hash | Session record |
| `usernames:unique` | Set | Username reservation for uniqueness checks |
| `usernames` | Sorted set | username → user ID lookup |
| `items#<id>` | Hash | Item record |
| `items:price` | Sorted set | Items ranked by current price |
| `items:views` | Sorted set | Items ranked by view count |
| `items:endingAt` | Sorted set | Items ranked by auction end time |
| `items:views#<id>` | HyperLogLog | Unique viewers for one item |
| `history#<id>` | List | Bid history (`amount:timestamp` entries) |
| `idx:items` | RediSearch index | Full-text + faceted search over item hashes |
| `users:likes#<id>` | Set | Item IDs a user has liked |
| `pagecache#<route>` | String | Cached rendered HTML for static routes |
| `lock:<key>` | String (`NX`/`PX`) | Distributed lock utility — not currently used by bid creation (see Concurrency handling) |

## Stack

SvelteKit, TypeScript, `redis` (node-redis v4) against **Redis Stack** (for the `RediSearch` module), Luxon for date handling, Docker Compose for local Redis + RedisInsight.

## Running locally

```bash
docker-compose up -d      # Redis Stack on :6379, RedisInsight on :5540
npm install
npm run seed               # populate sample data
npm run dev
```

## Status

This is a checkpoint, not a finished product. The Redis persistence layer above is implemented and working. Known gaps at this point:

- `getSimilarItems` (`src/services/queries/items/similar.ts`) is an unimplemented stub.
- No automated test suite yet.
- The full benchmark suite that validated the concurrency decision above — correctness testing, sustained-load throughput, HyperLogLog memory/accuracy, exact Redis command-count measurements — lives on the [`bench`](../../tree/bench) branch, not this one. This branch carries the resulting code fixes; the scripts, raw results, and `BENCHMARKS.md` methodology stay on `bench`.
