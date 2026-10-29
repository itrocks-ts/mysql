import assert            from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test }          from 'node:test'

const require = createRequire(import.meta.url)
const { Mysql, mysqlDependsOn } = require('@itrocks/mysql')
const { DateRecord } = require('./fixtures/date.cjs')
mysqlDependsOn({ applySaveTransformer: (object, name) => object[name], columnOf: name => name })

test('clearing a Date writes a zero date instead of NULL, while populated dates remain unchanged', async () => {
	const dao = new Mysql({})
	for (const value of [undefined, null, '', new Date(NaN)]) {
		const record = new DateRecord()
		record.date = value
		const [values] = await dao.valuesToDb(record)
		assert.deepEqual(values, { date: '0000-00-00' })
	}
	const record = new DateRecord()
	record.date = new Date(2026, 9, 29)
	const [values] = await dao.valuesToDb(record)
	assert.equal(values.date, record.date)
	const [plain] = await dao.valuesToDb({ name: null })
	assert.deepEqual(plain, { name: null })
})
