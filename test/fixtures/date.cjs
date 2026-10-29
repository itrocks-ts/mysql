const { File } = require('@itrocks/class-file')
class DateRecord
{
	date = undefined
}
File(__filename)(DateRecord)
module.exports = { DateRecord }
