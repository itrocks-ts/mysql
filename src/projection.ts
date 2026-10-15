import { Type }             from '@itrocks/class-type'
import { ReflectProperty }  from '@itrocks/reflect'
import { ProjectionQuery }  from '@itrocks/sql-build'
import { ProjectionCell }   from '@itrocks/storage'
import { ProjectionResult } from '@itrocks/storage'
import { SelectionError }   from '@itrocks/storage'

type Query = ProjectionQuery<ReflectProperty<any>, Type>
type RecordValue = Record<string, any>
type State = { object: RecordValue, record: RecordValue, values: Map<string, Promise<any>> }


function assign(object: object, property: string, value: unknown): void
{
	Object.defineProperty(object, property, { configurable: true, enumerable: true, value, writable: true })
}

export async function hydrateProjection<T extends object>(
	type: Type<T>, query: Query, records: readonly RecordValue[],
	read: (record: RecordValue, property: string, object: RecordValue) => any, ignored: unknown,
	columnOf: (property: string) => string
): Promise<ProjectionResult<T>>
{
	const identities = new Map<Type, Map<string, State>>()
	const state = (target: Type, id: any): State => {
		let objects = identities.get(target)
		if (!objects) identities.set(target, objects = new Map())
		const key = String(id)
		let item = objects.get(key)
		if (!item) {
			item = { object: Object.create(target.prototype), record: { id: identity(id) }, values: new Map() }
			assign(item.object, 'id', identity(id))
			objects.set(key, item)
		}
		return item
	}
	const rows = records.map(record => {
		const contexts = new Map<string, State | null>([['', state(type, record[query.rootIdentityAlias])]])
		const add = (path: string, alias: string): void => {
			if (contexts.has(path)) return
			const id = record[alias]
			const target = query.graph.getPath(path).tableDefinition!
			contexts.set(path, id == null ? null : state(target, id))
		}
		for (const column of query.columns) {
			for (const presence of column.presence) add(presence.path, presence.alias)
			if (column.kind === 'object') {
				for (const field of column.fields) {
					if (field.role !== 'identity') continue
					const relative = field.relativePath === 'id' ? '' : field.relativePath.slice(0, -3)
					add(relative ? `${column.path}.${relative}` : column.path, field.alias)
				}
			}
		}
		for (const [path, child] of contexts) {
			if (!path) continue
			const dot = path.lastIndexOf('.')
			const parent = contexts.get(path.slice(0, Math.max(0, dot)))
			if (parent) assign(parent.object, path.slice(dot + 1), child?.object ?? null)
		}
		for (const column of query.columns) for (const field of column.fields) {
			if (field.role !== 'value') continue
			const path = column.kind === 'object' ? `${column.path}.${field.relativePath}` : column.path
			const ownerPath = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : ''
			const owner = contexts.get(ownerPath)
			if (!owner) continue
			const name = String(field.definition!.name)
			owner.record[name] = record[field.alias]
			owner.record[columnOf(name)] = record[field.alias]
		}
		return { contexts, record }
	})
	const result: ProjectionResult<T> = {
		rootType: type,
		columns: query.columns.map(column => ({
			path: column.path, kind: column.kind,
			...(column.kind === 'object' ? {
				objectFields: column.objectFields, objectType: query.graph.getPath(column.path).tableDefinition
			} : {})
		})),
		rows: []
	}
	const output = []
	for (const { contexts, record } of rows) {
		const cells: ProjectionCell[] = []
		for (const column of query.columns) {
			const absent = column.presence.find(presence => record[presence.alias] == null)
			if (absent) {
				cells.push({ kind: 'absent', at: absent.path })
				continue
			}
			const loadedFields: string[] = []
			let scalar: unknown
			for (const field of column.fields) {
				const path = column.kind === 'object' ? `${column.path}.${field.relativePath}` : column.path
				const ownerPath = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : ''
				const owner = contexts.get(ownerPath)
				if (!owner) continue
				let value: any
				if (field.role === 'identity') value = identity(record[field.alias])
				else {
					const name = String(field.definition!.name)
					let pending = owner.values.get(name)
					if (!pending) {
						pending = Promise.resolve().then(() => read(owner.record, name, owner.object)).catch(cause => {
							throw new SelectionError('conversion', path, { cause })
						})
						owner.values.set(name, pending)
					}
					value = await pending
					if (value !== ignored) assign(owner.object, name, value)
				}
				if (value !== ignored) loadedFields.push(field.relativePath)
				scalar = value
			}
			cells.push(column.kind === 'object'
				? { kind: 'value', value: contexts.get(column.path)!.object, loadedFields }
				: scalar === ignored ? { kind: 'unloaded', reason: 'ignored' } : { kind: 'value', value: scalar })
		}
		output.push({ rootId: identity(record[query.rootIdentityAlias]), cells })
	}
	return { ...result, rows: output }
}

export function identity(value: any)
{
	return ((typeof value === 'bigint') && (value >= Number.MIN_SAFE_INTEGER) && (value <= Number.MAX_SAFE_INTEGER))
		? Number(value) : value
}
