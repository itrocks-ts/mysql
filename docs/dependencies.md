# MySQL dependencies

To fully utilise MySQL storage capabilities, integrate and configure the following advanced dependency features:

## mysqlDependsOn

Configure custom behaviours for MySQL data operations.

```ts
import { mysqlDependsOn } from '@itrocks/mysql'

mysqlDependsOn({
	applyReadTransformer:   (record, property) => record[property],
	applySaveTransformer:   (object, property) => object[property],
	columnOf:               name => name.toLowerCase(),
	componentOf:            () => false,
	ignoreTransformedValue: Symbol('ignoreTransformedValue'),
	QueryFunction:          class {},
	queryFunctionCall:      () => [undefined, ' = ?'],
	storeOf:                target => target.constructor.name.toLowerCase()
})
```

## applyReadTransformer

```ts
<T extends object>(record: AnyObject, property: KeyOf<T>, object: T) => any
```

Transforms a property value when reading data from the database, e.g. for deserialisation (string to Date).

**Parameters:**

- `record` ([AnyObject](https://github.com/itrocks-ts/class-type#anyobject)): The data record from MySQL.
- `property` ([KeyOf&lt;T&gt;](https://github.com/itrocks-ts/class-type#keyof)): The name of the property.
- `object` (`T extends object`): The object the property value must be written to. It may be partially initialised.

**Returns:**

- The transformed value of `property` to assign to `object`.
- Returning [ignoreTransformedValue](#ignoretransformedvalue) leaves the property unchanged.

## applySaveTransformer

```ts
<T extends object>(object: T, property: KeyOf<T>, record: AnyObject) => any
```

Transforms a property value before saving to the database, e.g. for serialisation (Date to string).

**Parameters:**

- `object` (`T extends object`): The object which property value must be transformed.
- `property` ([KeyOf&lt;T&gt;](https://github.com/itrocks-ts/class-type#keyof)): The name of the property.
- `record` ([AnyObject](https://github.com/itrocks-ts/class-type#anyobject)): The data record for MySQL writing.
  It may be partially set.

**Returns:**

- The transformed value of `property` to assign to `record`.
- Returning [ignoreTransformedValue](#ignoretransformedvalue) excludes the property from persistence.
- Returning an array schedules a collection save.
- Returning a function schedules a deferred operation.

**Deferred operation** (returning a function):

When `applySaveTransformer()` returns a **function**, it is not written to the SQL record.\
Instead, it is stored and executed after the object save operation completes.

The callback will receive the persisted `object` as first argument.

## columnOf

```ts
(property: string) => string
```

Maps an object property name to a database column name.

## componentOf

```ts
<T extends object>(target: T, property: KeyOf<T>) => boolean
```

Indicates whether a collection property is stored as components (one-to-many / owned) instead of a link table.

## ignoreTransformedValue

Marker value used by transformers to prevent persistence or assignment after the callback is executed.

## QueryFunction

```ts
Type<QF>
```

Base class for custom query functions.

## queryFunctionCall

```ts
(value: QF) => [any, string]
```

Converts a query function into a SQL fragment and its bound value.

**Parameters:**

- `value`: An object of a class derived from the one defined by [QueryFunction](#queryfunction).

**Returns:**

- `any`: The value associated with the query function
- `string`: The corresponding SQL fragment

## storeOf

```ts
<T extends object>(target: ObjectOrType<T>) => string | false
```

Maps a [class or object](https://github.com/itrocks-ts/class-type#objectortype) to its table name.
Returning `false` disables persistence for that type.

## Projection composition

Bind these hooks before reading model metadata. The framework supplies the same public
[`bindSqlProjection()`](https://github.com/itrocks-ts/framework/blob/main/docs/sql-projection.md)
for bootstrap and isolated adapters. It maps names through `toColumn` and `storeOf`, and uses
`applyTransformer` with `SQL`/`READ` and `SQL`/`SAVE`.

A projection read callback receives the final owning object and local property name. Its record contains the selected
raw sibling fields and identity; it does not contain root-relative dotted keys. Objects use their target prototype,
without constructor defaults. Callbacks may be asynchronous. `IGNORE` leaves a field unloaded; `undefined` remains a
loaded value. For criteria, object operands use their identity without invoking persistence. Scalar operands use the
final property save callback; ignored, deferred or collection results reject with a conversion error.

The SQL builder and relationship graph are public lower-level dependencies. Outside the framework, configure
[`sqlBuildDependsOn`](https://github.com/itrocks-ts/sql-build) and
[`sqlJoinDependsOn`](https://github.com/itrocks-ts/sql-join) with the model's property definitions and schema mapping.
Property definitions passed to MySQL expose their final `name` and `class.type`, as provided by `ReflectProperty`.
The default object field expansion uses the builder's directly stored scalar discovery.

Adapter subclasses can override protected `querySelection<T>(query, types): Promise<T[]>` to surround the single
parameterised execution. `types` contains the deduplicated root and related model types from the query graph.
`mysql-maintainer` uses this hook for its existing asynchronous maintenance context. Hydration remains in MySQL.
