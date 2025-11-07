import { AnyObject }        from '@itrocks/class-type'
import { inherits }         from '@itrocks/class-type'
import { isAnyFunction }    from '@itrocks/class-type'
import { isAnyType }        from '@itrocks/class-type'
import { KeyOf }            from '@itrocks/class-type'
import { ObjectOrType }     from '@itrocks/class-type'
import { Type }             from '@itrocks/class-type'
import { typeOf }           from '@itrocks/class-type'
import { compositeOf }      from '@itrocks/composition'
import { CollectionType }   from '@itrocks/property-type'
import { ReflectClass }     from '@itrocks/reflect'
import { ReflectProperty }  from '@itrocks/reflect'
import { Reverse }          from '@itrocks/sort'
import { sortOf }           from '@itrocks/sort'
import { DataSource }       from '@itrocks/storage'
import { Entity }           from '@itrocks/storage'
import { MayEntity }        from '@itrocks/storage'
import { Identifier }       from '@itrocks/storage'
import { Limit }            from '@itrocks/storage'
import { Options }          from '@itrocks/storage'
import { SearchType }       from '@itrocks/storage'
import { Sort }             from '@itrocks/storage'
import { Connection }       from 'mariadb'
import { createConnection } from 'mariadb'
import { UpsertResult }     from 'mariadb'

export const DEBUG = false

interface Dependencies<QF extends object = object> {
	applyReadTransformer:   <T extends object>(record: AnyObject, property: KeyOf<T>, object: T) => any
	applySaveTransformer:   <T extends object>(object: T, property: KeyOf<T>, record: AnyObject) => any
	columnOf:               (property: string) => string,
	componentOf:            <T extends object>(target: T, property: KeyOf<T>) => boolean
	ignoreTransformedValue: any
	QueryFunction:          Type<QF>,
	queryFunctionCall:      (value: QF) => [any, string]
	storeOf:                <T extends object>(target: ObjectOrType<T>) => string | false
}

const depends: Dependencies = {
	applyReadTransformer:   (record, property) => record[property],
	applySaveTransformer:   (object, property) => object[property],
	columnOf:               name => name.toLowerCase(),
	componentOf:            () => false,
	ignoreTransformedValue: Symbol('ignoreTransformedValue'),
	QueryFunction:          class {},
	queryFunctionCall:      () => [undefined, ' = ?'],
	storeOf:                target => typeOf(target).name.toLowerCase()
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

export class Mysql extends DataSource
{

	connection?: Connection

	saveQueue = new WeakMap<object, Promise<Entity<object> | void>>()

	constructor(public config: { host: string, user: string, password: string, database: string })
	{
		super()
	}

	async connect()
	{
		const mariaDbConfig = Object.assign(this.config, {
			allowPublicKeyRetrieval: true,
			dateStrings: false
		})
		return this.connection = await createConnection(mariaDbConfig)
	}

	async delete<T extends object>(object: Entity<T>, property: KeyOf<Entity<T>> = 'id')
	{
		await this.deleteId(object, object[property], property)
		return this.disconnectObject(object)
	}

	async deleteId<T extends object>(type: ObjectOrType<T>, id: any, property: KeyOf<Entity<T>> = 'id')
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

	async deleteRelatedId<T extends Entity>(object: T, property: KeyOf<T>, id: Identifier)
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
			callback(object)
		}

		return entity
	}

	async insertRelatedId<T extends Entity>(object: T, property: KeyOf<T>, id: Identifier)
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

	propertiesToSearchSql(search: AnyObject)
	{
		const sql = Object.entries(search)
			.map(([name, value]) => {
				let sql: string
				if (value instanceof depends.QueryFunction) {
					[search[name], sql] = depends.queryFunctionCall(value)
				}
				else {
					sql = ' = ?'
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
			const propertyType = property.type
			if (propertyType instanceof CollectionType) continue
			const propertyName = (isAnyType(propertyType.type) && depends.storeOf(propertyType.type))
				? property.name + 'Id'
				: property.name
			const columnName = depends.columnOf(propertyName)
			sql.push(
				(columnName.length !== propertyName.length)
					? ('`' + columnName + '` `' + propertyName + '`')
					: ('`' + propertyName + '`')
			)
		}
		return sql.join(', ')
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

	async readCollection<T extends object, PT extends object>(
		object:   Entity<T>,
		property: KeyOf<T>,
		type = new ReflectProperty(object, property).collectionType.elementType.type as Type<PT>
	) {
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
		const rows = await connection.query<Entity<PT>[]>(query, [object.id])

		return Promise.all(rows.map(row => this.valuesFromDb(row, type)))
	}

	async readCollectionIds<T extends object, PT extends object>(
		object:   Entity<T>,
		property: KeyOf<T>,
		type = new ReflectProperty(object, property).collectionType.elementType.type as Type<PT>
	) {
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
		if (DEBUG) console.log(
			'SELECT ' + propertiesSql + ' FROM `' + depends.storeOf(type) + '` WHERE id IN (' + questionMarks + ')', ids
		)
		const rows = await connection.query<Entity<T>[]>(
			'SELECT ' + propertiesSql + ' FROM `' + depends.storeOf(type) + '` WHERE id IN (' + questionMarks + ')', ids
		)

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

	async saveCollection<T extends object>(object: Entity<T>, property: KeyOf<T>, value: (Identifier | MayEntity)[])
	{
		if (property.endsWith('Ids')) {
			property = property.slice(0, -3) as KeyOf<T>
		}
		return depends.componentOf(object, property)
			? this.saveComponents(object, property, value)
			: this.saveLinks(object, property, value)
	}

	async saveComponents<T extends object>(object: Entity<T>, property: KeyOf<T>, components: (Identifier | MayEntity)[])
	{
		const connection   = this.connection ?? await this.connect()
		const propertyType = new ReflectProperty(object, property).collectionType.elementType.type as Type
		const stored       = await this.readCollectionIds(object, property, propertyType)
		const saved        = new Array<Identifier>

		let compositeProperty: ReflectProperty<object> | false | undefined
		for (const component of components) {
			if (typeof component !== 'object') {
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
				// @ts-ignore TS2322 Don't understand this error
				component[compositeProperty.name] = object
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
						+ ' used by @Component ' + new ReflectClass(object).name + '.' + property
				}
			}
			await connection.query('DELETE FROM `' + componentTable + '` WHERE id = ?', [storedId])
		}
	}

	async saveLinks<T extends object>(object: Entity<T>, property: KeyOf<T>, links: (Identifier | MayEntity)[])
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
		const connection    = this.connection ?? await this.connect()
		const propertiesSql = this.propertiesToSqlSelect(type)

		let limitOption: Limit | undefined = undefined
		let sortOption:  Sort  | undefined = undefined
		for (const option of this.options(options)) {
			if (option === Sort) {
				sortOption = new Sort(sortOf(type))
			}
			if (option instanceof Limit) {
				limitOption = option
			}
			if (option instanceof Sort) {
				sortOption = option.properties.length ? option : new Sort(sortOf(type))
			}
		}

		Object.setPrototypeOf(search, type.prototype)
		const sql      = this.propertiesToSearchSql(search)
		const [values] = await this.valuesToDb(search)
		if (DEBUG) console.log('SELECT ' + propertiesSql + ' FROM `' + depends.storeOf(type) + '`' + sql, '[', values, ']')
		const limit  = limitOption?.limit  ? ' LIMIT '  + limitOption.limit  : '';
		const offset = limitOption?.offset ? ' OFFSET ' + limitOption.offset : '';
		const sort   = sortOption?.properties.length
			? ' ORDER BY '
				+ sortOption.properties
					.map(property => '`' + property + '`' + (property instanceof Reverse ? ' DESC' : ''))
					.join(', ')
			: ''
		const rows = await connection.query<Entity<T>[]>(
			'SELECT ' + propertiesSql + ' FROM `' + depends.storeOf(type) + '`' + sql + sort + limit + offset,
			Object.values(values)
		)

		return Promise.all(rows.map(row => this.valuesFromDb(row, type)))
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
			callback(object)
		}

		return object
	}

	async valuesFromDb<T extends object>(record: Entity<T>, type: Type<T>)
	{
		const object = (new type) as Entity<T>
		let property: KeyOf<Entity<T>>
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
		for (const property of Object.keys(object) as KeyOf<T>[]) {
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
