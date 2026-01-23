# mysql

Transforms model objects to and from MySQL database records.

## Summary

The `@itrocks/mysql` package provides integration with MySQL storage and implements the
standard [@itrocks/storage](https://www.npmjs.com/package/@itrocks/storage)  `DataSource` API.

## Standard API

The MySQL data source follows the standard [@itrocks/storage](https://www.npmjs.com/package/@itrocks/storage) API.
Refer to the [storage documentation](https://github.com/itrocks-ts/storage) for generic behaviours.

## Advanced Features

To fully utilise MySQL storage capabilities, integrate and configure the following advanced dependency features:

### mysqlDependsOn

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

### applyReadTransformer

```ts
<T extends object>(record: AnyObject, property: KeyOf<T>, object: T) => any
```

Transforms a property value when reading data from the database, e.g. for deserialization (string to Date).

**Parameters:**
- `record` ([AnyObject](https://github.com/itrocks-ts/class-type#anyobject)): The data record from MySQL.
- `property` ([KeyOf&lt;T&gt;](https://github.com/itrocks-ts/class-type#keyof)): The name of the property.
- `object` (`T extends object`): The object the property value must be written to. It may be partially initialised.

**Returns:**
- The transformed value of `property` to assign to `object`.
- Returning [ignoreTransformedValue](#ignoretransformedvalue) leaves the property unchanged.

### applySaveTransformer

```ts
<T extends object>(object: T, property: KeyOf<T>, record: AnyObject) => any
```

Transforms a property value before saving to the database, e.g. for serialization (Date to string).

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

### columnOf

```ts
(property: string) => string
```

Maps an object property name to a database column name.

### componentOf

```ts
<T extends object>(target: T, property: KeyOf<T>) => boolean
```

Indicates whether a collection property is stored as components (one-to-many / owned) instead of a link table.

### ignoreTransformedValue

Marker value used by transformers to prevent persistence or assignment after the callback is executed.

### QueryFunction

```ts
Type<QF>
```

Base class for custom query functions.

### queryFunctionCall

```ts
(value: QF) => [any, string]
```

Converts a query function into a SQL fragment and its bound value.

**Parameters:**
- `value`: An object of a class derived from the one defined by [QueryFunction](#queryfunction).

**Returns:**
- `any`: The value associated with the query function
- `string`: The corresponding SQL fragment

### storeOf

```ts
<T extends object>(target: ObjectOrType<T>) => string | false
```

Maps a [class or object](https://github.com/itrocks-ts/class-type#objectortype) to its table name.
Returning `false` disables persistence for that type.
