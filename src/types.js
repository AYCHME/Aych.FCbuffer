const BN = require('bn.js')
const {Long} = require('bytebuffer')

const types = {
  Bytes: () => [bytebuf],
  String: () => [string],
  Vector: type => [vector, {type}],
  Optional: type => [optional, {type}],
  Time: () => [time],

  FixedString16: () => [string, {maxLen: 16}],
  FixedString32: () => [string, {maxLen: 32}],

  FixedBytes16: () => [bytebuf, {len: 16}],
  FixedBytes28: () => [bytebuf, {len: 28}],
  FixedBytes32: () => [bytebuf, {len: 32}],
  FixedBytes33: () => [bytebuf, {len: 33}],
  FixedBytes64: () => [bytebuf, {len: 64}],
  FixedBytes65: () => [bytebuf, {len: 65}],

  UInt8: () => [intbuf, {bits: 8}],
  UInt16: () => [intbuf, {bits: 16}],
  UInt32: () => [intbuf, {bits: 32}],
  UInt64: () => [intbuf, {bits: 64}],
  // ,128,224,256,512 TODO

  Int8: () => [intbuf, {signed: true, bits: 8}],
  Int16: () => [intbuf, {signed: true, bits: 16}],
  Int32: () => [intbuf, {signed: true, bits: 32}],
  Int64: () => [intbuf, {signed: true, bits: 64}]
  // ,128,224,256,512 TODO

  // VarInt32: ()=> [intbuf, {signed: true, bits: 32}],
}

/*
  @arg {SerializerConfig} config
  @return {object} {[typeName]: function(args)}
*/
module.exports = config => {
  config = Object.assign({defaults: false, debug: false, customTypes: {}}, config)

  const allTypes = Object.assign({}, types, config.customTypes)

  const createTypeReducer = baseTypes => (map, name) => {
    map[name] = (...args) => {
      const type = createType(name, config, args, baseTypes, allTypes)
      return type
    }
    return map
  }

  const baseTypes = Object.keys(types)
    .reduce(createTypeReducer(), {})

  const customTypes = Object.keys(config.customTypes || {})
    .reduce(createTypeReducer(baseTypes), {})

  return Object.assign({}, baseTypes, customTypes, {config})
}


/**
    @args {string} typeName - matches types[]
    @args {string} config - Additional arguments for types
*/
function createType (typeName, config, args, baseTypes, allTypes) {
  const Type = baseTypes ? allTypes[typeName] : types[typeName]
  const [fn, v = {}] = Type(...args)
  const validation = Object.assign(v, config)
  validation.typeName = typeName
  // if(typeName === 'Vector') console.log('typeName', validation)
  const type = fn(validation, baseTypes)
  return type
}

const isSerializer = type =>
    typeof type === 'object' &&
    typeof type.fromByteBuffer === 'function' &&
    typeof type.appendByteBuffer === 'function' &&
    typeof type.fromObject === 'function' &&
    typeof type.toObject === 'function'

const vector = validation => {
  if (!isSerializer(validation.type)) { throw new TypeError('Vector type should be a serializer') }

  return {
    fromByteBuffer (b) {
      const size = b.readVarint32()
            // if (validation.debug) {
            //     console.log("constint32 size = " + size.toString(16))
            // }
      const result = []
      for (let i = 0; i < size; i++) {
        result.push(validation.type.fromByteBuffer(b))
      }
      return result
    },
    appendByteBuffer (b, value) {
      validate(value, validation)
      b.writeVarint32(value.length)
      for (const o of value) {
        validation.type.appendByteBuffer(b, o)
      }
    },
    fromObject (value) {
      validate(value, validation)
      const result = []
      for (const o of value) {
        result.push(validation.type.fromObject(o))
      }
      return result
    },
    toObject (value) {
      if (validation.defaults && value == null) {
        return [validation.type.toObject(value)]
      }
      validate(value, validation)

      const result = []
      for (const o of value) {
        result.push(validation.type.toObject(o))
      }
      return result
    }
  }
}

const optional = validation => {
  const {type} = validation
  if (!isSerializer(type)) { throw new TypeError('Optional parameter should be a serializer') }

  return {
    fromByteBuffer (b) {
      if (!(b.readUint8() === 1)) {
        return null
      }
      return type.fromByteBuffer(b)
    },
    appendByteBuffer (b, value) {
      if (value != null) {
        b.writeUint8(1)
        type.appendByteBuffer(b, value)
      } else {
        b.writeUint8(0)
      }
    },
    fromObject (value) {
      if (value == null) {
        return null
      }
      return type.fromObject(value)
    },
    toObject (value) {
            // toObject is only null save if defaults is true
      let resultValue
      if (value == null && !validation.defaults) {
        resultValue = null
      } else {
        resultValue = type.toObject(value)
      }
      return resultValue
    }
  }
}

const intbufType = ({signed = false, bits}) =>
    // variable ? `${signed ? 'Varint' : 'Uint'}${bits}` : // Varint32 was used at some point
    `${signed ? 'Int' : 'Uint'}${bits}`

const intbuf = (validation) => ({
  fromByteBuffer (b) {
    const value = b[`read${intbufType(validation)}`]()
    return Long.isLong(value) ? value.toString() : value
  },
  appendByteBuffer (b, value) {
    // noOverflow(value, validation)
    // value = typeof value === 'string' ? Long.fromString(value) : value
    b[`write${intbufType(validation)}`](value)
  },
  fromObject (value) {
    noOverflow(value, validation)
    // if(validation.bits > 53 && typeof value === 'number')
    //     value = String(value)

    return value
  },
  toObject (value) {
    if (validation.defaults && value == null) {
      return validation.bits > 53 ? '0' : 0
    }

    noOverflow(value, validation)
    // if(validation.bits > 53 && typeof value === 'number')
    //     value = String(value)

    return Long.isLong(value) ? value.toString() : value
  }
})

const bytebuf = (validation) => {
  const _bytebuf = {
    fromByteBuffer (b) {
      const {len} = validation
      let bCopy
      if (len == null) {
        const lenPrefix = b.readVarint32()
        bCopy = b.copy(b.offset, b.offset + lenPrefix)
        b.skip(lenPrefix)
      } else {
        bCopy = b.copy(b.offset, b.offset + len)
        b.skip(len)
      }
      return Buffer.from(bCopy.toBinary(), 'binary')
    },
    appendByteBuffer (b, value) {
      // value = _bytebuf.fromObject(value)

      const {len} = validation
      if (len == null) {
        b.writeVarint32(value.length)
      }
      b.append(value.toString('binary'), 'binary')
    },
    fromObject (value) {
      if (typeof value === 'string') { value = Buffer.from(value, 'hex') }

      validate(value, validation)
      return value
    },
    toObject (value) {
      const {defaults, len} = validation
      if (defaults && value == null) {
        return Array(len ? len + 1 : 1).join('00')
      }
      validate(value, validation)
      return value.toString('hex')
    }
  }
  return _bytebuf
}

const string = (validation) => ({
  fromByteBuffer (b) {
    return b.readVString()
  },
  appendByteBuffer (b, value) {
    validate(value, validation)
    b.writeVString(value.toString())
  },
  fromObject (value) {
    validate(value, validation)
    return value
  },
  toObject (value) {
    if (validation.defaults && value == null) {
      return ''
    }
    validate(value, validation)
    return value
  }
})

const time = (validation) => {
  const _time = {
    fromByteBuffer (b) {
      return b.readUint32()
    },
    appendByteBuffer (b, value) {
      // if(typeof value !== "number")
      //     value = _time.fromObject(value)

      validate(value, validation)
      b.writeUint32(value)
    },
    fromObject (value) {
      validate(value, validation)

      if (typeof value === 'number') { return value }

      if (value.getTime) { return Math.floor(value.getTime() / 1000) }

      if (typeof value !== 'string') { throw new Error('Unknown date type: ' + value) }

      // Chrome assumes Zulu when missing, Firefox does not
      if (typeof value === 'string' && !/Z$/.test(value)) { value += 'Z' }

      return Math.floor(new Date(value).getTime() / 1000)
    },
    toObject (value) {
      if (validation.defaults && value == null) { return (new Date(0)).toISOString().split('.')[0] }

      validate(value, validation)

      // if(typeof value === "string") {
      //     if(!/Z$/.test(value))
      //         value += "Z"
      //
      //     return value
      // }

      // if(value.getTime)
      //     return value.toISOString().split('.')[0] + 'Z'

      noOverflow(value, spread(validation, {bits: 32}))
      const int = parseInt(value)
      return (new Date(int * 1000)).toISOString().split('.')[0]
    }
  }
  return _time
}

const validate = (value, validation) => {
  if (isEmpty(value)) {
    throw new Error(`Required ${validation.typeName}`)
  }

  if (validation.len != null) {
    if (value.length == null) { throw new Error(`len validation requries a "length" property`) }

    const {len} = validation
    if (value.length !== len) { throw new Error(`${validation.typeName} length ${value.length} does not equal ${len}`) }
  }

  if (validation.maxLen != null) {
    const {maxLen} = validation
    if (value.length == null) { throw new Error(`maxLen validation requries a "length" property`) }

    if (value.length > maxLen) { throw new Error(`${validation.typeName} length ${value.length} exceeds maxLen ${maxLen}`) }
  }
}

const ZERO = new BN()
const ONE = new BN('1')

function noOverflow (value, validation) {
  if (isEmpty(value)) {
    throw new Error(`Required ${validation.typeName}`)
  }
  const {signed = false, bits = 54} = validation

  const max = signed ? maxSigned(bits) : maxUnsigned(bits)
  const min = signed ? minSigned(bits) : ZERO
  const i = new BN(String(value))

  // console.log('i.toString(), min.toString()', i.toString(), min.toString())
  if (i.cmp(min) < 0 || i.cmp(max) > 0) {
    throw new Error(`Overflow ${validation.typeName} ${value}, ` +
            `max ${max.toString()}, min ${min.toString()}, signed ${signed}, bits ${bits}`)
  }
}

const spread = (...args) => Object.assign(...args)
const isEmpty = value => value == null

// 1 << N === Math.pow(2, N)
const maxUnsigned = bits => new BN(1).ishln(bits).isub(ONE)
const maxSigned = bits => new BN(1).ishln(bits - 1).isub(ONE)
const minSigned = bits => new BN(1).ishln(bits - 1).ineg()
