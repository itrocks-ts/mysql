import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { Mysql, mysqlDependsOn } = require('@itrocks/mysql')
const { sqlBuildDependsOn } = require('@itrocks/sql-build')
const { greater } = require('@itrocks/sql-functions')
const { sqlJoinDependsOn } = require('@itrocks/sql-join')
const { DataSource, Identifiers, Limit, SelectionError } = require('@itrocks/storage')
const ignored = Symbol('ignored')
class City
{

	constructor()
	{
		throw new Error('No construction')
	}

}
class Invoice
{

	constructor()
	{
		throw new Error('No construction')
	}

}
const definitions = new Map([
	[City, { code: {}, name: {} }],
	[Invoice, { city: { target: City }, alternate: { target: City }, number: {} }]
])
for (const [type, columns] of definitions) for (const [name, column] of Object.entries(columns)) {
	Object.assign(column, { name, class: { type } })
}
sqlJoinDependsOn({ columnDefinitionsOf: type => definitions.get(type), tableOf: type => type.name })
sqlBuildDependsOn({ columnOf: property => property.name })
const configure = overrides => mysqlDependsOn({
	applyReadTransformer: (record, property) => record[property],
	applySaveTransformer: (object, property) => object[property],
	columnOf: property => String(property), ignoreTransformedValue: ignored, ...overrides
})
configure()
const datasource = (tables = [{ t0: { id: 1, number: 'One' }, t1: { id: 3, name: 'Paris', code: 'FR' },
	t2: { id: 3, name: 'Paris', code: 'FR' } }]) => {
	const dao = new Mysql({})
	const queries = []
	dao.connection = { query: async (sql, values) => {
		queries.push({ sql, values })
		if (sql.includes('COUNT(*)')) return [{ count: 1n }]
		return tables.map(tables => Object.fromEntries([...sql.matchAll(/`(t\d+)`\.`(\w+)` AS `(p\d+)`/g)]
			.map(([, table, column, alias]) => [alias, tables[table]?.[column] ?? null])))
	} }
	return { dao, queries }
}

test('projection merges identities and selected fields without constructors or additional reads', async () => {
	let conversions = 0
	configure({ applyReadTransformer: async (record, name, object) => {
		assert.ok(object instanceof City)
		assert.equal(record.code, 'FR')
		conversions ++
		return record[name].toUpperCase()
	} })
	const { dao, queries } = datasource()
	const result = await dao.select(Invoice, [
		{ path: 'city', objectFields: ['name'] }, 'city.name', { path: 'alternate', objectFields: ['code'] }
	])
	const [city, scalar, alternate] = result.rows[0].cells
	assert.equal(city.value, alternate.value)
	assert.equal(city.value.name, scalar.value)
	assert.equal(city.value.name, 'PARIS')
	assert.equal(city.value.code, 'FR')
	assert.deepEqual(city.loadedFields, ['id', 'name'])
	assert.deepEqual(alternate.loadedFields, ['id', 'code'])
	assert.equal(conversions, 2)
	assert.equal(queries.length, 1)
	configure()
})

test('ignored and undefined scalar and object fields have distinct loading states', async () => {
	configure({ applyReadTransformer: async (_record, name) => name === 'name' ? ignored : undefined })
	const { dao } = datasource()
	const result = await dao.select(Invoice, ['city', 'city.name', 'city.code'])
	const [object, name, code] = result.rows[0].cells
	assert.deepEqual(name, { kind: 'unloaded', reason: 'ignored' })
	assert.deepEqual(code, { kind: 'value', value: undefined })
	assert.ok(!Object.hasOwn(object.value, 'name'))
	assert.ok(Object.hasOwn(object.value, 'code'))
	assert.deepEqual(object.loadedFields, ['id', 'code'])
	configure()
})

test('criteria use final owners and preserve trusted operators and caller inputs', async () => {
	configure({ applySaveTransformer: async (object, name) => {
		assert.ok(object instanceof City)
		assert.equal(name, 'code')
		return object[name].toLowerCase()
	} })
	const { dao, queries } = datasource()
	const operand = greater('FR')
	await dao.select(Invoice, [], { 'city.code': operand })
	await dao.count(Invoice, { 'city.code': operand })
	assert.equal(operand.value, 'FR')
	assert.deepEqual(queries.map(query => query.values), [['fr'], ['fr']])
	assert.ok(queries.every(query => query.sql.includes(' > ?')))
	configure()
})

test('validation precedes connection and conversion errors preserve path and cause', async () => {
	const { dao, queries } = datasource()
	for (const options of [{}, 'SQL', [new Limit(1), new Limit(2)], new Identifiers([Infinity])]) {
		await assert.rejects(() => dao.select(Invoice, [], {}, options), { code: 'unsupported-option' })
	}
	await assert.rejects(() => dao.select(Invoice, ['number', ['number']]), { code: 'invalid-path' })
	assert.equal(queries.length, 0)
	const cause = new Error('conversion')
	configure({ applyReadTransformer: () => { throw cause } })
	await assert.rejects(() => dao.select(Invoice, ['city.name']), error =>
		error instanceof SelectionError && error.code === 'conversion'
		&& error.path === 'city.name' && error.cause === cause)
	configure({ applySaveTransformer: () => ignored })
	await assert.rejects(() => dao.count(Invoice, { 'city.name': 'x' }), { code: 'conversion' })
	configure()
})

test('identity values preserve large integers and null relation cells', async () => {
	const { dao } = datasource([{ t0: { id: 9007199254740993n }, t1: { id: null } }])
	const result = await dao.select(Invoice, ['city', 'city.name'])
	assert.equal(result.rows[0].rootId, 9007199254740993n)
	assert.deepEqual(result.rows[0].cells, [{ kind: 'absent', at: 'city' }, { kind: 'absent', at: 'city' }])
})

test('unsupported adapters reject without invoking full entity search', async () => {
	class Unsupported extends DataSource
	{

		search()
		{
			throw new Error('No search fallback')
		}

	}
	await assert.rejects(() => new Unsupported().select(Invoice, ['number']), { code: 'unsupported-selection' })
})

test('batched relation identities become one parameterised IN query and reject invalid ids', async () => {
	configure()
	const { dao, queries } = datasource()
	await dao.select(Invoice, ['number'], { city: [3, 4] })
	assert.equal(queries.length, 1)
	assert.match(queries[0].sql, /IN \(\?, \?\)/)
	assert.deepEqual(queries[0].values, [3, 4])
	await dao.select(Invoice, [], { city: [] })
	assert.match(queries[1].sql, /1 = 0/)
	await assert.rejects(dao.select(Invoice, [], { city: [3, {}] }), { code: 'conversion' })
	assert.equal(queries.length, 2)
})
