# Data Modeling Guide (schema-altitude)

Guidance for **schema and data-modeling decisions** made during discovery and planning. This is the modeling half of Shipyard's database playbook; the implementation half (indexing, query optimization, code-time anti-patterns) lives in `data-implementation-guide.md` and is read at execute/review time.

## GATE — read this only when the feature actually models data

Read and apply this guide **only when the feature persists or models data** — i.e. when **any** of these hold:
- The Phase 1.5 Step 4 **ER / data-model diagram trigger** fires (the feature introduces or changes **2+ related entities** or a non-trivial schema).
- The feature will have a `## Data Model` section (new tables/collections, schema changes, entity relationships, data constraints).
- The feature introduces a new **data category** flagged by the Constitution-Gap pass (PII, tenant-scoped, audit-logged).

**If the feature has no persistence concern** (pure UI, pure compute, a copy/config change, an integration that stores nothing), **skip this guide entirely.** Loading database guidance into a non-data feature is exactly the over-engineering this gate prevents — the same significance discipline as the diagram triggers.

When it applies, fold the conclusions into the feature's `## Technical Notes` (prescriptive: "Use X"), the `## Data Model` section, and the ER diagram. Don't dump the guide into the spec — apply it.

---

## 1. Model in altitudes: conceptual → logical → physical

Decide *what* before *how*. Don't jump straight to `CREATE TABLE`.

- **Conceptual** — the business entities and relationships. No attributes/keys yet. This is what the ER diagram in the spec captures.
- **Logical** — entities + attributes + keys + normalization + cardinality, DBMS-independent.
- **Physical** — exact tables/columns/types/indexes/partitions for the target engine. (Index/type detail is execute-time — see the implementation guide.)

Resolve every **many-to-many** into a junction/associative table with its own foreign keys. State cardinality and optionality explicitly.

## 2. Normalize to 3NF/BCNF for OLTP; denormalize only with measured cause

**Default: normalize transactional schemas to 3NF / BCNF.** That removes insert/update/delete anomalies — each fact lives in exactly one place.

| Form | One-line rule | Target? |
|---|---|---|
| 1NF | Atomic columns; no repeating groups / CSV-in-a-column | required |
| 2NF | Non-key attributes depend on the *whole* composite key | required |
| 3NF | No non-key-to-non-key (transitive) dependencies | **target** |
| BCNF | Every determinant is a superkey | **target** |
| 4NF/5NF | Remove multivalued / join-dependency redundancy | rare; only if the anomaly is real |
| 6NF | Row = PK + ≤1 attribute | columnar/temporal only |

4NF/5NF eliminate real but rare anomalies — don't reach for them by default. 6NF is for specialized columnar/temporal stores.

**Denormalize deliberately, never as a starting excuse.** Legitimate triggers: a profiled read-hot path doing the same join millions of times; analytics/reporting (star schemas are denormalized by design); pre-computed aggregates. Cost: every duplicated fact must be kept in sync on write — you re-introduce update anomalies and own the consistency. Prefer DB-maintained materialized views / CQRS projections over hand-duplicated columns. **Rule: normalize until it hurts, denormalize until it works — after measuring.**

## 3. Keys, constraints, types, naming (standards)

**Keys — default to a hybrid:** a **surrogate primary key** (auto-increment `BIGINT`, or a time-ordered UUID like UUIDv7/ULID if you need client-generatable/global IDs) **plus the natural key as a `UNIQUE` alternate key.** Surrogates are resilient to business-value changes; the unique constraint still enforces real-world identity. Avoid random v4 UUIDs as the clustered PK on large tables (index fragmentation).

**Constraints — let the database enforce integrity, not the app.** Multiple writers, scripts, and migrations all bypass app code. Define `FOREIGN KEY` (referential integrity), `NOT NULL`, `UNIQUE` (natural keys), `CHECK` (domain rules / status whitelists), and `DEFAULT`. Define FKs even on high-write tables unless you've *measured* the overhead is unacceptable.

**Types — narrowest correct type.** `DECIMAL/NUMERIC` for money (never `FLOAT`). UTC timestamps with timezone semantics (`TIMESTAMPTZ`). Native `BOOLEAN`/`ENUM` or a `CHECK`-constrained code + lookup table — not magic integers. `JSONB` only for genuinely variable/sparse attributes (see anti-patterns).

**Naming — pick one convention and enforce it project-wide.** `snake_case`, lowercase, descriptive words. FKs named for their target (`customer_id` → `customer.id`). Don't use reserved words (`order`, `user`, `group`), `tbl_`/`sp_` prefixes, or type-encoding names. Be consistent on singular-vs-plural table names — just don't mix. **Check the project's constitution rules (`.claude/rules/project-*.md`) first — project conventions override these defaults.**

## 4. Right-size the schema (over- vs under-engineering)

Most schemas fail in one of two opposite directions; correct for both.

**Governing question:** *Is this complexity paying for a problem I have now (or a one-way door I can't cheaply walk back), or for a problem I might never have?*

**Reversibility asymmetry — invest up front only on one-way doors:**
- Cheap to change later → start simple: adding a column, an index, a cache, a read replica; denormalizing a hot path later.
- Expensive to change later → decide carefully now: **primary-key shape, table grain, normalization shape, types on soon-to-be-huge tables, NoSQL-for-the-system-of-record.**

| Decision | Over-complicated ⛔ | Over-simplified ⛔ | Calibrated ✅ |
|---|---|---|---|
| Normalization | 5NF/6NF everywhere | one wide table, duplicated facts | 3NF/BCNF; denormalize with measured cause |
| Flexibility | EAV / OTLT / metadata engine | hardcoded columns that can't evolve | typed columns + one `JSONB` column for the variable remainder |
| Keys | composite natural keys everywhere | a mutable business value as PK | surrogate PK + `UNIQUE` natural key |
| Store choice | a polyglot zoo for v1 | force every workload into one store | relational core; add a specialized store per *proven* access pattern |

**Decision routine per non-trivial choice:** (1) name the *current* problem with evidence — none + reversible → choose simple; (2) check reversibility — one-way door → invest, cheap-to-add-later → defer; (3) weigh cost-of-being-wrong each way; (4) YAGNI unless retrofitting is genuinely expensive *and* the need is near-certain; (5) document the *why* behind any added complexity so it isn't ripped out or cargo-culted. **Maxim: as simple as the invariants allow, as rigorous as the integrity demands.**

## 5. OLTP vs OLAP, and relational vs NoSQL (the modeling choice)

- **OLTP** (operational, many small reads/writes) → normalized (3NF), row-oriented. **OLAP** (analytics, big aggregate scans) → denormalized **dimensional** model (star schema; declare the **grain** first; facts + dimensions; SCD Type 2 for history; conformed dimensions across fact tables). Don't run heavy analytics on the OLTP primary — offload to a columnar engine/warehouse via replica/CDC/ETL.
- **Warehouse methodology** (if building one): **Kimball** (dimensional, bottom-up, fastest BI value) / **Inmon** (3NF enterprise model, top-down) / **Data Vault** (hubs+links+satellites, auditable, many heterogeneous sources). Often layered: raw 3NF/Vault → Kimball marts.
- **Relational vs NoSQL:** choose **relational** for structured data needing referential integrity, joins, complex queries, and ACID. Choose **NoSQL** for high-volume predictable-low-latency at scale, dynamic/denormalizable data, simple no-join retrieval, geo-replication. CAP: relational favors C+A (vertical scale); NoSQL favors A+P (horizontal, tunable consistency). **NewSQL** (Cockroach/TiDB/Yugabyte) combines horizontal scale with ACID. **Polyglot persistence is legitimate** — relational core + a specialized store per proven access pattern, not by fashion.

## 6. Schema-shape anti-patterns — reject these at design time

- ⛔ **EAV (Entity-Attribute-Value)** — `(entity, attribute, value)` rows. Query explosion (self-join per filter), no type safety, no constraints. ✅ Use typed columns for known fields; one **`JSONB`** column for the variable remainder (benchmarks show JSONB orders of magnitude faster than EAV and indexable via GIN). Note JSONB can't enforce DB-level FK/type constraints — validate in-app / with `CHECK`.
- ⛔ **OTLT / MUCK (One True Lookup Table)** — one giant `lookup(type, code, value)` for every enumeration. Kills FK integrity, forces type chaos and two-column joins, confuses the optimizer. ✅ One small, typed, FK-referenceable lookup table per domain.
- ⛔ **God table** — 80-column table serving every use case, full of NULLs. ✅ Split by concern/bounded context; move blobs/rarely-used columns to a satellite table.
- ⛔ **CSV/delimited list in a column** (violates 1NF) → junction table.
- ⛔ **Polymorphic association without FK integrity** (`commentable_type`/`commentable_id`) → exclusive-arc FKs or per-type join tables.
- ⛔ **`FLOAT` money, timezone-less timestamps, nullable-everything, "the app handles integrity"** — see §3.

---

**Sources** (long-form, with citations, in the team's `database-design-best-practices.md`): Kimball Group (dimensional modeling), Wikipedia (normal forms), Microsoft Learn (relational vs NoSQL, CAP/PACELC), liambx (surrogate keys), Oracle-Base (OTLT), Cybertec/EDB/coussej (EAV→JSONB).
