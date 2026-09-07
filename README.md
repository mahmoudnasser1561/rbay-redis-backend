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

Concurrent bids on the same item are the one place a naive read-modify-write breaks correctness (lost updates). Two approaches were built and compared:

1. **Optimistic transactions** (`WATCH`/`MULTI`) — the first implementation.
2. **A custom distributed lock** (`SET NX PX` + a Lua-scripted unlock that only deletes the key if the token still matches) — replaced (1) after it showed a higher success rate under contention. The lock hands the callback a `Proxy`-wrapped client that throws once the lock's timeout has elapsed, so a stalled transaction can't keep writing after its safety window expires.

See `src/services/redis/lock.ts` and `src/services/queries/bids.ts`.

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
| `lock:<key>` | String (`NX`/`PX`) | Distributed lock for bid concurrency |

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

This is a checkpoint, not a finished product. The Redis persistence layer above is implemented and working; **load-testing/benchmarking the concurrency handling and search, plus a cloud deployment, are the next phase**. Known gaps at this point:

- `getSimilarItems` (`src/services/queries/items/similar.ts`) is an unimplemented stub.
- No automated test suite yet.
- No benchmark numbers yet — that's the next milestone.
