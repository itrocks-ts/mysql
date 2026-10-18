[![npm version](https://img.shields.io/npm/v/@itrocks/mysql?logo=npm)](https://www.npmjs.org/package/@itrocks/mysql)
[![npm downloads](https://img.shields.io/npm/dm/@itrocks/mysql)](https://www.npmjs.org/package/@itrocks/mysql)
[![GitHub](https://img.shields.io/github/last-commit/itrocks-ts/mysql?color=2dba4e&label=commit&logo=github)](https://github.com/itrocks-ts/mysql)
[![issues](https://img.shields.io/github/issues/itrocks-ts/mysql)](https://github.com/itrocks-ts/mysql/issues)
[![discord](https://img.shields.io/discord/1314141024020467782?color=7289da&label=discord&logo=discord)](https://25.re/ditr)

# mysql

Transforms model objects to and from MySQL database records.

`Mysql` implements the standard [storage DataSource API](https://github.com/itrocks-ts/storage).
Configure the model/schema and conversion [dependencies](docs/dependencies.md) before accessing the database.
The framework supplies those bindings during bootstrap. The constructor accepts the usual connection configuration;
`close()` releases its connection.

## Project property paths

```ts
import { dataSource, Identifiers, Limit, Sort } from '@itrocks/storage'

// Invoice is the application's stored model class.
const result = await dataSource().select(Invoice, [
	'number',
	'customer.address.city.name',
	{ path: 'deliveryAddress.city', objectFields: ['name', 'country.name'] }
], { 'customer.name': 'Alice' }, [new Sort(['number']), new Limit(50)])

const reload = await dataSource().select(Invoice, ['customer.address.city'], {},
	new Identifiers(result.rows.map(row => row.rootId)))
```

`select(type, columns, search = {}, options?)` returns ordered column descriptors and rows with a separate `rootId`.
Each row's `cells` follows the requested column order. Strings and segment arrays name the same path; duplicate or
invalid paths reject. An empty column list returns identities and empty cells. Empty results retain their descriptors.

A cell is a loaded value, an absent relation with its first missing path, or an unloaded ignored value. Loaded null
and undefined remain distinct from absence. Object cells contain partial instances with the target prototype and id,
plus their actual `loadedFields`. They include directly stored scalars by default, or the requested relative fields
and intermediate identities. Constructors are not called. Do not save these partial values as complete entities.
Objects with the same target type and id share one identity within the result and merge selected fields. There is no
cross-request cache or follow-up read per cell. Representation code must request every field it uses.

`Sort` and empty `Sort` use default sort metadata; explicit sorts preserve their order. A root id tie-breaker makes
pages stable for a fixed dataset. Selection without a limit is unbounded; `Limit(0)` returns no rows. Invalid limits,
duplicate options and unknown options reject. `Identifiers` deduplicates and binds ids, intersects the criteria and
returns no rows for an empty list. Keep mandatory scope criteria when reloading a visible page.

Plural selected or sorted paths reject with `multiple-values`. Plural criteria use correlated existence predicates,
so multiple matching children do not multiply roots or counts. Flat equality, null and trusted
[SQL functions](https://github.com/itrocks-ts/sql-functions) use bound operands. Scalar operands pass through the final
property's save conversion; object operands compare identities. `count(type, search)` shares those criteria and
returns the number of roots without pagination.

`search()` still returns complete constructed entities with relation ids. It shares criterion preparation and SQL
predicate semantics, while retaining legacy option handling, including the unbounded meaning of its zero limit.
New projections use the stricter neutral storage contract. Driver errors propagate; conversion errors preserve their
cause and property path through `SelectionError`.

## Additional exports

`joinTableName(first, second)` returns the sorted conventional link table name for store names or stored types/objects.
`DEBUG` is the adapter's diagnostic logging flag. Dependency wiring through `mysqlDependsOn` is described separately
in [dependency configuration](docs/dependencies.md).

## Batched criteria

An array criterion matches any supplied value through a parameterised SQL `IN` predicate. An empty array matches
no rows. All operands are bound separately; they are never interpolated into SQL.
Relation identity operands are validated individually before querying the database.
