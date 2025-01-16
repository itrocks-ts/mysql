[![npm version](https://img.shields.io/npm/v/@itrocks/mysql?logo=npm)](https://www.npmjs.org/package/@itrocks/mysql)
[![npm downloads](https://img.shields.io/npm/dm/@itrocks/mysql)](https://www.npmjs.org/package/@itrocks/mysql)
[![GitHub](https://img.shields.io/github/last-commit/itrocks-ts/mysql?color=2dba4e&label=commit&logo=github)](https://github.com/itrocks-ts/mysql)
[![issues](https://img.shields.io/github/issues/itrocks-ts/mysql)](https://github.com/itrocks-ts/mysql/issues)
[![discord](https://img.shields.io/discord/1314141024020467782?color=7289da&label=discord&logo=discord&logoColor=white)](https://25.re/ditr)

# mysql

Transforms model objects to and from MySQL database records.

## Summary

The `@itrocks/mysql` package provides a seamless integration with MySQL storage, supporting the common
[@itrocks/storage](https://www.npmjs.com/package/@itrocks/storage) API
while enabling advanced features for efficient data handling.

## Standard API

The MySQL data source follows the standard [@itrocks/storage](https://www.npmjs.com/package/@itrocks/storage) API.
For detailed usage, please refer to the [official documentation](https://github.com/itrocks-ts/storage)

## Advanced Features

To fully utilize MySQL storage capabilities, integrate and configure the following advanced features:

### mysqlDependsOn

Configure custom behaviours for MySQL data operations. Example usage (the default):
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
	storeOf:                target => typeOf(target).name.toLowerCase()
})
```

### applyReadTransformer

```ts
applyReadTransformer: <T extends object>(record: AnyObject, property: KeyOf<T>, object: T) => any
```
Transforms a property value when reading data from the database,
useful for deserialization or type conversion (e.g. string to Date).

**Parameters:**
- `record` ([AnyObject](https://github.com/itrocks-ts/class-type#anyobject)):
  The data record from MySQL.
- `property` ([KeyOf&lt;T&gt;](https://github.com/itrocks-ts/class-type#keyof)):
  The property to transform.
- `object` (T extends object):
  The object being constructed.
  It may be incomplete, as not all properties may have been transformed yet.

**Return value:**
- The transformed value of `property` to assign to `object`.
- Alternatively, return [ignoreTransformedValue](#ignoretransformedvalue)
  to leave the property value unchanged in `object`.

### applySaveTransformer

```ts
applySaveTransformer: <T extends object>(object: T, property: KeyOf<T>, record: AnyObject) => any
```
Transforms a property value before saving to the database, e.g., for serialization (Date to string).

**Parameters:**
- `object` (T extends object):
  The object being saved.
- `property` ([KeyOf&lt;T&gt;](https://github.com/itrocks-ts/class-type#keyof)):
  The property to transform.
- `record` ([AnyObject](https://github.com/itrocks-ts/class-type#anyobject)):
  The database record to save.
  It may be incomplete, as not all properties may have been transformed yet.

**Return value:**
- The transformed value of `property` to assign to `record`.
- Alternatively, return [ignoreTransformedValue](#ignoretransformedvalue)
  to exclude the property and its value from `record`.

### columnOf

```ts
columnOf: (property: string) => string
```
Maps a property name to a database column name, enabling custom naming conventions.

### componentOf

```ts
componentOf: <T extends object>(target: T, property: KeyOf<T>) => boolean
```
Determines whether a property represents a tightly bound component relationship (e.g., `one-to-one` or `many-to-one`).
Defining this function is highly recommended to ensure proper data access from your MySQL relational database.

By default, properties are assumed to represent related collections
(e.g., `many-to-many` or `one-to-many` relationships).

### ignoreTransformedValue

```ts
ignoreTransformedValue: any
```
This marker value is used to skip property transformation during read or save operations.
It is returned by your implementation of [applyReadTransformer](#applyreadtransformer)
and [applySaveTransformer](#applysavetransformer), as needed.

### QueryFunction

```ts
QueryFunction: Type<QF>
```
Specificies a custom query function type for advanced search operations.

### queryFunctionCall

```ts
queryFunctionCall: (value: QF) => [value: any, sql: string]
```
Processes custom query functions, returning the SQL fragment and associated values.

**Parameters:**
- `value`: An object of a class derived from the one defined by [QueryFunction](#queryfunction).

**Returns:**
- `value`: The value associated with the query function
- `sql`: The corresponding SQL fragment 

### storeOf

```ts
storeOf: <T extends object>(target: ObjectOrType<T>) => string | false
```
Maps a class ([ObjectOrType](https://github.com/itrocks-ts/class-type#objectortype))
to its corresponding database table name, allowing for custom naming conventions.
