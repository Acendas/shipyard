# Data Implementation Guide (code-altitude)

Guidance for **writing and reviewing database code** — indexes, queries, migrations, repositories, and the scaling primitives around them. This is the implementation half of Shipyard's database playbook; the modeling half (schema shape, normalization, keys, store choice) lives in `data-modeling-guide.md` and is settled earlier at discuss/sprint time.

## GATE — read this only when the work touches the database

Read and apply this guide **only when the task or diff actually touches persistence** — i.e. when the files-to-modify or the changed lines include **any** of:
- Migrations / DDL / schema changes.
- SQL queries, query builders, or ORM models/repositories/DAOs.
- Index, partition, or constraint changes.
- Caching or connection-pool configuration for a datastore.

**If the change doesn't touch the database** (pure UI, pure business logic over in-memory data, docs, config unrelated to a datastore), **skip this guide.** Don't apply database review criteria to non-database code — that's noise, the same significance discipline as the schema-altitude gate.

When it applies: a **builder** uses this to implement DB code correctly; a **code-review scanner** uses §5 as its rubric to flag findings on the diff. Always check the project's own constitution rules (`.claude/rules/project-*.md`) first — project conventions override these defaults.

---

## 1. Indexing

- **Index the columns your hot queries filter/join/sort on** — not every column. Every index adds write-maintenance cost to INSERT/UPDATE/DELETE; over-indexing degrades write throughput and causes concurrency problems.
- **Index type:** B-Tree (default) serves equality **and** range (`=, >, <, BETWEEN`), sorting, and prefix `LIKE 'abc%'`. Hash serves equality only. GIN/GiST (Postgres) for full-text/JSONB/arrays/geo. Columnstore for OLAP scans.
- **Composite index column order matters:** equality-predicate column first, then range, then most-distinct → least-distinct. The **leftmost-prefix rule**: an index on `(a, b)` cannot serve a query filtering only on `b`. Order to match real query predicates.
- **Covering index / index-only scan:** include every column a query needs (filter columns in the key, projected columns via `INCLUDE`) so the query is satisfied from the index without a table lookup. **But don't over-cover** — fat covering indexes inflate storage/memory/write cost. **Index for the `WHERE` clause first; add covering columns only for a proven hot query, never speculatively.**
- **When indexes hurt:** tiny tables (a scan beats the index, yet the index still costs on writes); low-cardinality columns (few distinct values). Periodically drop unused/duplicate indexes.
- ✅ **Always index foreign-key columns** used in joins/lookups — a missing FK index is a classic slow-join cause.

## 2. Query optimization & reading plans

- **Keep predicates SARGable.** Don't wrap the indexed column in a function (`WHERE YEAR(created_at)=2025`, `UPPER(email)=…`) or use a leading-wildcard `LIKE '%x'` — it defeats the index. Rewrite to ranges: `created_at >= '2025-01-01' AND < '2026-01-01'`.
- **Read the execution plan** (`EXPLAIN ANALYZE` / `SET STATISTICS`): an **Index Seek** navigates directly to rows (good); a **Scan** examines every row (the slow-query signature on large tables). Find the most expensive operator, ask "can an index turn this scan into a seek, or remove this key lookup / sort?", change one thing, re-measure.
- Watch for: large **estimated-vs-actual row** divergence (stale statistics — refresh them), expensive sorts/hashes/spools, key lookups (a covering index removes them), nested-loop joins over big inputs.

## 3. Code-time anti-patterns — reject these in implementation/review

- ⛔ **N+1 queries** — one query for N rows, then one query per row (1 + N round trips); endemic with ORM lazy-loading. ✅ Eager-load / `JOIN`, batch with `WHERE id IN (...)`, or use the ORM's `JOIN FETCH`/`includes`/dataloader. Detect via repeated near-identical statements in query logs/APM.
- ⛔ **`SELECT *`** — pulls unneeded columns, defeats covering indexes, bloats I/O. Select only what's used.
- ⛔ **Non-SARGable predicates / implicit type conversion** (`WHERE varchar_col = 123`) — force scans.
- ⛔ **Deep `OFFSET` pagination** — slow on deep pages; prefer keyset/seek pagination (`WHERE id > :last ORDER BY id LIMIT n`).
- ⛔ **Unbounded result sets** — always paginate/limit list endpoints.
- ⛔ **Missing index on a foreign key** used for joins or cascade.
- ⛔ **Soft-delete `is_deleted` without a partial index/filter** — silently bloats every query.

## 4. Performance & scaling primitives

- **Partitioning** (within one DB) helps manageability and lets the planner **prune** partitions — but only if queries filter on the partition key; a cross-partition scan gets no benefit.
- **Replication scales reads + fault tolerance, NOT writes** — all writes go to a primary and are copied; each read replica adds ~1× read capacity. Beware replication lag → stale reads on async replicas.
- **Sharding scales writes/storage but is costly** — cross-shard joins/transactions/referential integrity carry steep penalties. Don't shard until query tuning + caching + vertical scale + read replicas are exhausted. The shard key (even distribution, matches access pattern, no hotspots) is the make-or-break decision.
- **Scale in order (cheapest → most disruptive):** fix queries/indexes → cache hot reads → vertical scale → read replicas → partition → shard.
- **Caching:** cache-aside (lazy) is the common default; read-through/write-through keep it fresher at a latency cost; write-behind is fast but risks loss on cache failure. On write, **invalidate or update** the entry; set TTLs as a safety net. Choose by what you prioritize — consistency vs read-perf vs write-perf.
- **Connection pooling:** always pool; **bound the pool size** (more connections ≠ more throughput — past the server's capacity they cause contention; start near a small multiple of CPU cores and tune by measurement); set acquire/idle/max-lifetime timeouts.

## 5. Code-review checklist (scanner rubric)

When reviewing a DB-touching diff, flag (confidence ≥ 80, cite file:line):
- N+1 query patterns (loop issuing per-row queries / lazy-loaded relations in a loop).
- Missing index on a new FK or a new hot-query predicate; or a new redundant/duplicate index.
- Non-SARGable predicates; `SELECT *` in hot paths; unbounded/`OFFSET`-deep pagination.
- Migrations: missing FK/`NOT NULL`/`CHECK`/`UNIQUE`; `FLOAT` for money; timezone-less timestamp; non-reversible/locking migration on a large table (e.g. adding a non-null column with a default that rewrites the table; creating an index non-concurrently).
- Schema-shape anti-patterns leaking into code (EAV access, OTLT joins) — cross-reference `data-modeling-guide.md`.
- Writes without transactions where multiple statements must be atomic.

---

**Sources** (long-form, with citations, in the team's `database-design-best-practices.md`): Microsoft Learn (SQL Server index design guide), MySQL manual (B-Tree/Hash), use-the-index-luke (covering/index-only scans), PlanetScale (N+1), iam.slys.dev & VeloDB (partitioning/replication/sharding), Oracle Coherence & Redis (caching strategies).
