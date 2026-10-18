import { inherits }              from '@itrocks/class-type'
import { isAnyFunction }         from '@itrocks/class-type'
import { isAnyType }             from '@itrocks/class-type'
import { ObjectOrType }          from '@itrocks/class-type'
import { Type }                  from '@itrocks/class-type'
import { typeOf }                from '@itrocks/class-type'
import { compositeOf }           from '@itrocks/composition'
import { CollectionType }        from '@itrocks/property-type'
import { ReflectClass }          from '@itrocks/reflect'
import { ReflectProperty }       from '@itrocks/reflect'
import { Reverse }               from '@itrocks/sort'
import { sortOf }                from '@itrocks/sort'
import { Count }                 from '@itrocks/sql-build'
import { ProjectionError }       from '@itrocks/sql-build'
import { ProjectionOptions }     from '@itrocks/sql-build'
import { Select }                from '@itrocks/sql-build'
import { SqlQuery }              from '@itrocks/sql-build'
import { SqlFunction }           from '@itrocks/sql-functions'
import { RelationshipError }     from '@itrocks/sql-join'
import { RelationshipGraph }     from '@itrocks/sql-join'
import { DataSource }            from '@itrocks/storage'
import { Entity }                from '@itrocks/storage'
import { Identifier }            from '@itrocks/storage'
import { Identifiers }           from '@itrocks/storage'
import { isIdentifier }          from '@itrocks/storage'
import { Limit }                 from '@itrocks/storage'
import { MayEntity }             from '@itrocks/storage'
import { Options }               from '@itrocks/storage'
import { ProjectionResult }      from '@itrocks/storage'
import { SearchType }            from '@itrocks/storage'
import { Selection }             from '@itrocks/storage'
import { SelectionError }        from '@itrocks/storage'
import { SelectionPath }         from '@itrocks/storage'
import { Sort }                  from '@itrocks/storage'
import { type Connection }       from 'mariadb'
import { type ConnectionConfig } from 'mariadb'
import { createConnection }      from 'mariadb'
import { type UpsertResult }     from 'mariadb'
import { hydrateProjection }     from './projection'

export const DEBUG = false

type AnyObject = Record<string, any>

interface Dependencies<QF extends object = object> {
	applyReadTransformer:   <T extends object>(record: AnyObject, property: keyof T, object: T) => any
	applySaveTransformer:   <T extends object>(object: T, property: keyof T, record: AnyObject) => any
	columnOf:               (property: number | string | symbol) => string,
	componentOf:            <T extends object>(target: T, property: keyof T) => boolean
	ignoreTransformedValue: any
	QueryFunction:          Type<QF>,
	queryFunctionCall:      (value: QF) => [any, string]
	storeOf:                <T extends object>(target: ObjectOrType<T>) => string | false
}

const depends: Dependencies = {
	applyReadTransformer:   (record, property) => record[depends.columnOf(property)],
	applySaveTransformer:   (object, property) => object[property],
	columnOf:               name => name.toString().toLowerCase(),
	componentOf:            () => false,
	ignoreTransformedValue: Symbol('ignoreTransformedValue'),
	QueryFunction:          class {},
	queryFunctionCall:      () => [undefined, ' = ?'],
	storeOf:                target => typeOf(target).name.toLowerCase()
}

function graphTypes(graph: RelationshipGraph<Type, ReflectProperty<any>>): Type[]
{
	return [...new Set([graph.root, ...[...graph.getPaths().values()]
		.flatMap(node => node.tableDefinition ? [node.tableDefinition] : [])])]
}

export function joinTableName(object1: string | ObjectOrType, object2: string | ObjectOrType)
{
	if (typeof object1 !== 'string') object1 = depends.storeOf(object1) as string
	if (typeof object2 !== 'string') object2 = depends.storeOf(object2) as string
	return [object1, object2].sort().join('_')
}

export function mysqlDependsOn<QF extends object = object>(dependencies: Partial<Dependencies<QF>>)
{
	Object.assign(depends, dependencies)
}

function normalise(path: SelectionPath): string
{
	const segments = Array.isArray(path) ? path : typeof path === 'string' ? path.split('.') : []
	if (!segments.length || segments.some(segment =>
		(typeof segment !== 'string') || !segment || segment.includes('.'))) {
		throw new SelectionError('invalid-path', String(path))
	}
	return segments.join('.')
}

async function selectionErrors<T>(operation: () => Promise<T>): Promise<T>
{
	try { return await operation() }
	catch (cause) {
		if (cause instanceof RelationshipError) {
			throw new SelectionError(cause.code === 'unsupported-relationship' ? 'unsupported-selection' : cause.code,
				cause.path, { cause })
		}
		if (cause instanceof ProjectionError) throw new SelectionError(cause.code, cause.path, { cause })
		throw cause
	}
}

function validIdentifier(value: unknown): boolean
{
	return isIdentifier(value) && ((typeof value !== 'number') || Number.isSafeInteger(value))
}

export class Mysql extends DataSource
{

	connection?: Connection

	saveQueue = new WeakMap<object, Promise<Entity<object> | void>>()

	constructor(public config: { host: string, user: string, password: string, database: string })
	{
		super()
	}

	async close()
	{
		if (this.connection === undefined) return
		await this.connection.end()
		this.connection = undefined
	}

	columnName<T extends object>(property: ReflectProperty<T>)
	{
		if (typeof property.name !== 'string') throw 'No column name for non-string property'
		if (property.name === 'id') return 'id'
		const propertyType = property.type
		if (propertyType instanceof CollectionType) return
		return depends.columnOf(this.targetName(property))
	}

	async connect()
	{
		const mariaDbConfig: ConnectionConfig = Object.assign(this.config, {
			allowPublicKeyRetrieval: true,
			dateStrings: false,
			debugLen: 100000,
			logParam: true,
			trace: true
		})
		return this.connection = await createConnection(mariaDbConfig)
	}

	async count<T extends object>(type: Type<T>, search: SearchType<T> = {})
	{
		const prepared = await selectionErrors(() => this.prepareCriteria(type, search))
		const query = await selectionErrors(async () => new Count(type, prepared.conditions).build())
		const rows = await this.querySelection<{ count: number | bigint }>(query, prepared.types)
		return Number(rows[0]?.count ?? 0)
	}

	async delete<T extends object>(object: Entity<T>, property: keyof Entity<T> = 'id')
	{
		await this.deleteId(object, object[property], property)
		return this.disconnectObject(object)
	}

	async deleteId<T extends object>(type: ObjectOrType<T>, id: any, property: keyof Entity<T> = 'id')
	{
		const connection = this.connection ?? await this.connect()
		if (DEBUG) console.log(
			'DELETE FROM `' + depends.storeOf(type) + '` WHERE `' + depends.columnOf(property) + '` = ?',
			[id]
		)
		await connection.query(
			'DELETE FROM `' + depends.storeOf(type) + '` WHERE `' + depends.columnOf(property) + '` = ?',
			[id]
		)
	}

	async deleteRelatedId<T extends Entity>(object: T, property: keyof T, id: Identifier)
	{
		const connection = this.connection ?? await this.connect()

		const objectTable   = depends.storeOf(object)
		const propertyTable = depends.storeOf(new ReflectProperty(object, property).collectionType.elementType.type as Type)
		if (!objectTable || !propertyTable) {
			throw 'Collection objects are not stored'
		}
		const joinTable = joinTableName(objectTable, propertyTable)

		const query  = 'DELETE FROM `' + joinTable + '` WHERE ' + objectTable + '_id = ? AND ' + propertyTable + '_id = ?'
		const values = [object.id, id]
		if (DEBUG) console.log(query, JSON.stringify(values))
		connection.query(query, values)
	}

	async insert<T extends object>(object: T)
	{
		const connection = this.connection ?? await this.connect()

		const [values, deferred] = await this.valuesToDb(object)
		const sql   = this.propertiesToSql(values)
		const query = 'INSERT INTO `' + depends.storeOf(object) + '` SET '  + sql
		if (DEBUG) console.log(query, JSON.stringify(Object.values(values)))
		const result = await connection.query<UpsertResult>(query, Object.values(values))
		const id     = result.insertId
		const entity = this.connectObject(
			object,
			((id >= Number.MIN_SAFE_INTEGER) && (id <= Number.MAX_SAFE_INTEGER)) ? Number(id) : id
		)
		for (const callback of deferred) {
			await callback(object)
		}

		return entity
	}

	async insertRelatedId<T extends Entity>(object: T, property: keyof T, id: Identifier)
	{
		const connection = this.connection ?? await this.connect()

		const objectTable   = depends.storeOf(object)
		const propertyTable = depends.storeOf(new ReflectProperty(object, property).collectionType.elementType.type as Type)
		if (!objectTable || !propertyTable) {
			throw 'Collection objects are not stored'
		}
		const joinTable = joinTableName(objectTable, propertyTable)

		const query  = 'INSERT INTO `' + joinTable + '` SET ' + objectTable + '_id = ?, ' + propertyTable + '_id = ?'
		const values = [object.id, id]
		if (DEBUG) console.log(query, JSON.stringify(values))
		connection.query(query, values)
	}

	orderBy<T extends object>(type: Type<T>, sort = new Sort(sortOf(type)))
	{
		const orderBy = sort.properties
			.map(property => ({
				column:  this.columnName(new ReflectProperty(type, '' + property as keyof T)),
				reverse: property instanceof Reverse
			}))
			.filter(property => property.column)
			.map(property => '`' + property.column + '`' + (property.reverse ? ' DESC' : ''))
			.join(', ')
		return orderBy.length ? ' ORDER BY ' + orderBy : ''
	}

	protected async prepareCriteria<T extends object>(type: Type<T>, search: SearchType<T>)
	{
		const paths = Object.keys(search)
		const graph = new RelationshipGraph<Type, ReflectProperty<any>>(type,
			paths.filter(path => path !== 'id').map(path => path.endsWith('.id') ? path.slice(0, -3) : path))
		const result: Record<string, unknown> = Object.create(null)
		for (const path of paths) {
			const original = search[path]
			if (Array.isArray(original)) {
				if (original.some(Array.isArray)) throw new SelectionError('conversion', path)
				const operands = await Promise.all(original.map(value =>
					this.prepareCriteria(type, { [path]: value } as SearchType<T>)))
				const values = operands.map(operand => operand.conditions[path])
				if (values.some(value => value instanceof SqlFunction)) throw new SelectionError('conversion', path)
				result[path] = values
				continue
			}
			let fn = original instanceof SqlFunction ? original : undefined
			if (!fn && (original instanceof depends.QueryFunction)) {
				const [value, sql] = depends.queryFunctionCall(original)
				fn = new SqlFunction(original.constructor.name, sql, value)
			}
			let value = fn ? fn.value : original
			const id = (path === 'id') || path.endsWith('.id')
			const node = id ? undefined : graph.getPath(path)
			if (id || node?.relationship) {
				if ((value !== null) && (typeof value === 'object')) value = value.id
				if ((value !== null) && !validIdentifier(value)) throw new SelectionError('conversion', path)
			}
			else {
				const property = node!.definition
				const object = Object.create(property.class.type.prototype)
				Object.defineProperty(object, property.name, { configurable: true, value, writable: true })
				try {
					value = await depends.applySaveTransformer(object, property.name, {})
					if ((value === depends.ignoreTransformedValue) || (typeof value === 'function') || Array.isArray(value)) {
						throw new Error('Criterion conversion did not return a SQL operand')
					}
				}
				catch (cause) { throw new SelectionError('conversion', path, { cause }) }
			}
			result[path] = fn ? new SqlFunction(fn.name, fn.sql, value) : value
		}
		return { conditions: result, types: graphTypes(graph) }
	}

	protected projectionOptions<T extends object>(type: Type<T>, options?: Options, legacy = false): ProjectionOptions
	{
		const result: ProjectionOptions = {}
		const seen = new Set<Function>()
		for (const option of this.options(options)) {
			const kind = option === Sort ? Sort : option?.constructor
			if (!legacy && seen.has(kind)) throw new SelectionError('unsupported-option')
			seen.add(kind)
			if (option instanceof Limit) {
				if (legacy && !option.limit) continue
				result.limit = option.limit
				result.offset = option.offset
			}
			else if ((option === Sort) || (option instanceof Sort)) {
				const properties = (option instanceof Sort) && option.properties.length ? option.properties : sortOf(type)
				result.orderBy = properties.map(property => ({
					path: String(property), descending: property instanceof Reverse
				}))
			}
			else if (option instanceof Identifiers) {
				if (!option.ids.every(validIdentifier)) throw new SelectionError('unsupported-option')
				result.rootIds = [...new Set(option.ids)]
			}
			else if (!legacy) throw new SelectionError('unsupported-option')
		}
		return result
	}

	propertiesToSearchSql(search: AnyObject)
	{
		const sql = Object.entries(search)
			.map(([name, value]) => {
				let sql: string
				if (value instanceof depends.QueryFunction) {
					[value, sql] = depends.queryFunctionCall(value)
					search[name] = value
				}
				else {
					sql = ' = ?'
				}
				if (((typeof value)[0] === 'o') && !(value instanceof Date)) {
					name = Array.isArray(value) ? 'id' : (name + '_id')
				}
				return '`' + depends.columnOf(name) + '`' + sql
			})
			.join(' AND ')
		return sql.length
			? ' WHERE ' + sql
			: ''
	}

	propertiesToSql(object: object)
	{
		return Object.keys(object).map(name => '`' + depends.columnOf(name) + '` = ?').join(', ')
	}

	propertiesToSqlSelect<T extends object>(type: Type<T>)
	{
		const sql = ['id']
		for (const property of new ReflectClass(type).properties) {
			const columnName = this.columnName(property)
			if (!columnName) continue
			const propertyName = this.targetName(property)
			sql.push(
				(columnName.length !== propertyName.length)
					? ('`' + columnName + '` `' + propertyName + '`')
					: ('`' + propertyName + '`')
			)
		}
		return sql.join(', ')
	}

	async query<T extends object>(type: Type<T>, query: string, values?: any)
	{
		const connection = this.connection ?? await this.connect()
		if (DEBUG) console.log(query, values)
		const rows       = await connection.query<Entity<T>[]>(query, values)
		return Promise.all(rows.map(row => this.valuesFromDb(row, type)))
	}

	protected async querySelection<T extends object>(query: SqlQuery, _types: readonly Type[]): Promise<T[]>
	{
		const connection = this.connection ?? await this.connect()
		return connection.query<T[]>(query.sql, query.values)
	}

	async read<T extends object>(type: Type<T>, id: Identifier)
	{
		const connection    = this.connection ?? await this.connect()
		const propertiesSql = this.propertiesToSqlSelect(type)

		if (DEBUG) console.log('SELECT ' + propertiesSql + ' FROM `' + depends.storeOf(type) + '` WHERE id = ?', [id])
		const rows = await connection.query<Entity<T>[]>(
			'SELECT ' + propertiesSql + ' FROM `' + depends.storeOf(type) + '` WHERE id = ?', [id]
		)

		return this.valuesFromDb(rows[0], type)
	}

	async readCollection<T extends object, PT extends object>(object: Entity<T>, property: keyof T, type?: Type<PT>)
	{
		if (!object.id) return []

		type              ??= new ReflectProperty(object, property).collectionType.elementType.type as Type<PT>
		const connection    = this.connection ?? await this.connect()
		const propertiesSql = this.propertiesToSqlSelect(type)

		const objectTable   = depends.storeOf(object)
		const propertyTable = depends.storeOf(type)
		if (!objectTable || !propertyTable) {
			throw 'Collection objects are not stored'
		}

		let query: string
		if (depends.componentOf(object, property)) {
			query = 'SELECT ' + propertiesSql + ' FROM `' + propertyTable + '` WHERE ' + objectTable + '_id = ?'
		}
		else {
			const joinTable = joinTableName(objectTable, propertyTable)
			query = 'SELECT `' + propertyTable + '`.' + propertiesSql + ' FROM `' + propertyTable + '`'
				+ ' INNER JOIN `' + joinTable + '` ON `' + joinTable + '`.' + propertyTable + '_id = `' + propertyTable + '`.id'
				+ ' WHERE `' + joinTable + '`.' + objectTable + '_id = ?'
		}
		query += this.orderBy(type)
		const rows = await connection.query<Entity<PT>[]>(query, [object.id])

		return Promise.all(rows.map(row => this.valuesFromDb(row, type)))
	}

	async readCollectionIds<T extends object, PT extends object>(object: Entity<T>, property: keyof T, type?: Type<PT>)
	{
		if (!object.id) return []

		type           ??= new ReflectProperty(object, property).collectionType.elementType.type as Type<PT>
		const connection = this.connection ?? await this.connect()

		const objectTable   = depends.storeOf(object)
		const propertyTable = depends.storeOf(type)
		if (!objectTable || !propertyTable) {
			throw 'Collection objects are not stored'
		}

		let query: string
		if (depends.componentOf(object, property)) {
			query = 'SELECT id FROM `' + propertyTable + '` WHERE ' + objectTable + '_id = ?'
		}
		else {
			const joinTable = joinTableName(objectTable, propertyTable)
			query = 'SELECT ' + propertyTable + '_id id FROM `' + joinTable + '`'
				+ ' WHERE `' + joinTable + '`.' + objectTable + '_id = ?'
				+ ' ORDER BY ' + propertyTable + '_id'
		}
		const rows = await connection.query<Entity[]>(query, [object.id])

		return Promise.all(rows.map(row => row.id))
	}

	async readMultiple<T extends object>(type: Type<T>, ids: Identifier[]): Promise<Entity<T>[]>
	{
		if (!ids.length) return []
		const connection    = this.connection ?? await this.connect()
		const propertiesSql = this.propertiesToSqlSelect(type)

		const questionMarks = Array(ids.length).fill('?').join(', ')
		const query = 'SELECT ' + propertiesSql + ' FROM `' + depends.storeOf(type) + '`'
			+ ' WHERE id IN (' + questionMarks + ')'
			+ this.orderBy(type)
		if (DEBUG) console.log(query)
		const rows = await connection.query<Entity<T>[]>(query, ids)

		return Promise.all(rows.map(row => this.valuesFromDb(row, type)))
	}

	async runSerialized<T extends object>(object: MayEntity<T>, task: () => Promise<Entity<T>>)
	{
		const prev = this.saveQueue.get(object) || Promise.resolve()
		const next = prev.then(task, task)
		this.saveQueue.set(
			object, next.then(() => { this.saveQueue.delete(object) }, () => { this.saveQueue.delete(object) })
		)
		return next
	}

	async save<T extends object>(object: MayEntity<T>)
	{
		return this.runSerialized(object, async () => {
			return this.isObjectConnected(object)
				? this.update(object)
				: this.insert(object)
		})
	}

	async saveCollection<T extends object>(object: Entity<T>, property: keyof T, value: (Identifier | MayEntity)[])
	{
		if (property.toString().endsWith('Ids')) {
			property = property.toString().slice(0, -3) as keyof T
		}
		return depends.componentOf(object, property)
			? this.saveComponents(object, property, value)
			: this.saveLinks(object, property, value)
	}

	async saveComponents<T extends object, C extends object>(
		object: Entity<T>, property: keyof T, components: (Identifier | MayEntity<C>)[]
	) {
		const connection   = this.connection ?? await this.connect()
		const propertyType = new ReflectProperty(object, property).collectionType.elementType.type as Type
		const stored       = await this.readCollectionIds(object, property, propertyType)
		const saved        = new Array<Identifier>

		let compositeProperty: ReflectProperty<C> | false | undefined
		for (const component of components) {
			if (isIdentifier(component)) {
				saved.push(component)
				continue
			}
			if (compositeProperty === undefined) {
				const objectType = typeOf(object)
				for (const candidate of new ReflectClass(component).properties) {
					if (!compositeOf(component, candidate.name)) continue
					const candidateType = candidate.type.type
					if (!isAnyType(candidateType)) continue
					if (!inherits(objectType, candidateType)) continue
					compositeProperty = candidate
					break
				}
			}
			if (compositeProperty) {
				component[compositeProperty.name] = object as any
			}
			saved.push((await this.save(component)).id)
		}

		let componentTable: string | false | undefined
		for (const storedId of stored) {
			if (saved.includes(storedId)) continue
			if (!componentTable) {
				componentTable = depends.storeOf(propertyType)
				if (!componentTable) {
					throw 'Missing @Store on type ' + propertyType.name
						+ ' used by @Component ' + new ReflectClass(object).name + '.' + property.toString()
				}
			}
			await connection.query('DELETE FROM `' + componentTable + '` WHERE id = ?', [storedId])
		}
	}

	async saveLinks<T extends object>(object: Entity<T>, property: keyof T, links: (Identifier | MayEntity)[])
	{
		const connection    = this.connection ?? await this.connect()
		const objectTable   = depends.storeOf(object) as string
		const propertyType  = new ReflectProperty(object, property).collectionType.elementType.type as Type
		const propertyTable = depends.storeOf(propertyType) as string
		const linkColumn    = depends.columnOf(propertyTable) + '_id'
		const linkTable     = joinTableName(objectTable, propertyTable)
		const objectColumn  = depends.columnOf(objectTable) + '_id'
		const objectId      = object.id
		const stored        = await this.readCollectionIds(object, property, propertyType)
		const saved         = new Array<Identifier>

		for (const link of links) {
			const linkId = (typeof link === 'object')
				? (this.isObjectConnected(link) ? link.id : (await this.save(link)).id)
				: link
			saved.push(linkId)
			if (stored.includes(linkId)) continue
			await connection.query(
				'INSERT INTO `' + linkTable + '` SET ' + objectColumn + ' = ?, ' + linkColumn + ' = ?',
				[objectId, linkId]
			)
			stored.push(linkId)
		}

		for (const storedId of stored) {
			if (saved.includes(storedId)) continue
			await connection.query(
				'DELETE FROM `' + linkTable + '` WHERE ' + objectColumn + ' = ? AND ' + linkColumn + ' = ?',
				[objectId, storedId]
			)
		}
	}

	async search<T extends object>(type: Type<T>, search: SearchType<T> = {}, options?: Options): Promise<Entity<T>[]>
	{
		// Full entity search retains constructor defaults, relation ids and legacy option handling.
		const properties = [...new ReflectClass(type).properties].filter(property => this.columnName(property))
		const columns = ['id', ...properties.map(property => {
			const name = String(property.name)
			return this.targetName(property) === name ? name : `${name}.id`
		})]
		const query = await selectionErrors(async () => new Select<Type<T>, ReflectProperty<any>>(type, columns,
			(await this.prepareCriteria(type, search)).conditions, this.projectionOptions(type, options, true)
		).buildProjection())
		const rows = await this.querySelection<AnyObject>(query, graphTypes(query.graph))
		return Promise.all(rows.map(row => {
			const record: AnyObject = { id: row[query.rootIdentityAlias] }
			properties.forEach((property, index) => {
				record[this.targetName(property)] = row[query.columns[index + 1].fields[0].alias]
			})
			return this.valuesFromDb(record as Entity<T>, type)
		}))
	}

	async select<T extends object>(
		type: Type<T>, columns: readonly Selection[], search: SearchType<T> = {}, options?: Options
	): Promise<ProjectionResult<T>>
	{
		const query = await selectionErrors(async () => new Select<Type<T>, ReflectProperty<any>>(type,
			columns.map(selection => {
				if ((typeof selection === 'string') || Array.isArray(selection)) return normalise(selection)
				const description = selection as { path: SelectionPath, objectFields?: readonly SelectionPath[] }
				return { path: normalise(description.path), objectFields: description.objectFields?.map(normalise) }
			}), (await this.prepareCriteria(type, search)).conditions, this.projectionOptions(type, options)
		).buildProjection())
		const records = await this.querySelection<AnyObject>(query, graphTypes(query.graph))
		return hydrateProjection(type, query, records, depends.applyReadTransformer,
			depends.ignoreTransformedValue, depends.columnOf)
	}

	targetName<T extends object>(property: ReflectProperty<T>)
	{
		const type = property.type.type
		return (isAnyType(type) && depends.storeOf(type))
			? property.name.toString() + 'Id'
			: property.name.toString()
	}

	async update<T extends object>(object: Entity<T>)
	{
		const connection = this.connection ?? await this.connect()

		const [values, deferred] = await this.valuesToDb(object)
		const sql   = this.propertiesToSql(values)
		const query = 'UPDATE `' + depends.storeOf(object) + '` SET '  + sql + ' WHERE id = ?'
		if (DEBUG) console.log(query, JSON.stringify(Object.values(values).concat([object.id])))
		await connection.query(query, Object.values(values).concat([object.id]))
		for (const callback of deferred) {
			await callback(object)
		}

		return object
	}

	async valuesFromDb<T extends object>(record: Entity<T>, type: Type<T>)
	{
		const object = (new type) as Entity<T>
		let property: keyof Entity<T>
		for (property in record) {
			const value = await depends.applyReadTransformer(record, property, object)
			if (value === depends.ignoreTransformedValue) continue
			object[property] = value
			if (property.endsWith('Id')) {
				delete (object as Record<string, any>)[property.slice(0, -2)]
			}
		}
		return object
	}

	async valuesToDb<T extends object>(object: T): Promise<[AnyObject, Function[]]>
	{
		const deferred: Function[] = []
		const record:   AnyObject  = {}
		for (const property of Object.keys(object) as (keyof T)[]) {
			const value = await depends.applySaveTransformer(object, property, record)
			if (value === depends.ignoreTransformedValue) {
				continue
			}
			if (Array.isArray(value)) {
				deferred.push((object: Entity<T>) => this.saveCollection(object, property, value))
				continue
			}
			if (isAnyFunction(value)) {
				deferred.push(value)
				continue
			}
			record[depends.columnOf(property)] = value
		}
		return [record, deferred]
	}

}
