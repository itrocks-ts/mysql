import { AnyObject, isAnyFunction }     from '@itrocks/class-type'
import { KeyOf, ObjectOrType, Type }    from '@itrocks/class-type'
import { typeOf }                       from '@itrocks/class-type'
import { ReflectProperty }              from '@itrocks/reflect'
import { DataSource }                   from '@itrocks/storage'
import { Entity, MayEntity }            from '@itrocks/storage'
import { Identifier, SearchType }       from '@itrocks/storage'
import { Connection, createConnection } from 'mariadb'

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

export function mysqlDependsOn<QF extends object = object>(dependencies: Partial<Dependencies<QF>>)
{
	Object.assign(depends, dependencies)
}

export { Mysql }
export default class Mysql extends DataSource
{

	connection?: Connection

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
		const propertyTable = depends.storeOf(new ReflectProperty(object, property).collectionType.elementType as Type)
		const joinTable     = [objectTable, propertyTable].sort().join('_')

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
		const result = await connection.query(query, Object.values(values))
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
		const propertyTable = depends.storeOf(new ReflectProperty(object, property).collectionType.elementType as Type)
		const joinTable     = [objectTable, propertyTable].sort().join('_')

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

	async read<T extends object>(type: Type<T>, id: Identifier)
	{
		const connection = this.connection ?? await this.connect()

		if (DEBUG) console.log('SELECT * FROM `' + depends.storeOf(type) + '` WHERE id = ?', [id])
		const rows: Entity<T>[] = await connection.query(
			'SELECT * FROM `' + depends.storeOf(type) + '` WHERE id = ?',
			[id]
		)

		return this.valuesFromDb(rows[0], type)
	}

	async readCollection<T extends object, PT extends object>(
		object:   Entity<T>,
		property: KeyOf<T>,
		type = new ReflectProperty(object, property).collectionType.elementType as Type<PT>
	) {
		const connection = this.connection ?? await this.connect()

		const objectTable = depends.storeOf(object)
		const table       = depends.storeOf(type)

		let query: string
		if (depends.componentOf(object, property)) {
			query = 'SELECT * FROM `' + table + '` WHERE ' + objectTable + '_id = ?'
		}
		else {
			const joinTable = [objectTable, table].sort().join('_')
			query = 'SELECT `' + table + '`.* FROM `' + table + '`'
				+ ' INNER JOIN `' + joinTable + '` ON `' + joinTable + '`.' + table + '_id = `' + table + '`.id'
				+ ' WHERE `' + joinTable + '`.' + objectTable + '_id = ?'
		}
		const rows: Entity<PT>[] = await connection.query(query, [object.id])

		return Promise.all(rows.map(row => this.valuesFromDb(row, type)))
	}

	async readCollectionIds<T extends object, PT extends object>(
		object:   Entity<T>,
		property: KeyOf<T>,
		type = new ReflectProperty(object, property).collectionType.elementType as Type<PT>
	) {
		const connection = this.connection ?? await this.connect()

		const objectTable   = depends.storeOf(object)
		const propertyTable = depends.storeOf(type)

		let query: string
		if (depends.componentOf(object, property)) {
			query = 'SELECT id FROM `' + propertyTable + '` WHERE ' + objectTable + '_id = ?'
		}
		else {
			const joinTable = [objectTable, propertyTable].sort().join('_')
			query = 'SELECT ' + propertyTable + '_id id FROM `' + joinTable + '`'
				+ ' WHERE `' + joinTable + '`.' + objectTable + '_id = ?'
		}
		const rows: { id: Identifier }[] = await connection.query(query, [object.id])

		return Promise.all(rows.map(row => row.id))
	}

	async readMultiple<T extends object>(type: Type<T>, ids: Identifier[])
	{
		if (!ids.length) return []
		const connection = this.connection ?? await this.connect()

		const questionMarks = Array(ids.length).fill('?').join(', ')
		if (DEBUG) console.log('SELECT * FROM `' + depends.storeOf(type) + '` WHERE id IN (' + questionMarks + ')', ids)
		const rows: Entity<T>[] = await connection.query(
			'SELECT * FROM `' + depends.storeOf(type) + '` WHERE id IN (' + questionMarks + ')',
			ids
		)

		return Promise.all(rows.map(row => this.valuesFromDb(row, type)))
	}

	async save<T extends object>(object: MayEntity<T>)
	{
		return this.isObjectConnected(object)
			? this.update(object)
			: this.insert(object)
	}

	async search<T extends object>(type: Type<T>, search: SearchType<T> = {}): Promise<Entity<T>[]>
	{
		const connection = this.connection ?? await this.connect()

		Object.setPrototypeOf(search, type.prototype)
		const sql      = this.propertiesToSearchSql(search)
		const [values] = await this.valuesToDb(search)
		if (DEBUG) console.log('SELECT * FROM `' + depends.storeOf(type) + '`' + sql, '[', values, ']')
		const rows: Entity<T>[] = await connection.query(
			'SELECT * FROM `' + depends.storeOf(type) + '`' + sql,
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
			if (property.endsWith('_id')) {
				delete (object as Record<string, any>)[property.slice(0, -3)]
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
			if (value === depends.ignoreTransformedValue) continue
			if (isAnyFunction(value)) {
				deferred.push(value)
				continue
			}
			record[property] = value
		}
		return [record, deferred]
	}

}
