/**
 * Casting of incoming values to what the interface process expects, driven by the paramset
 * description of the datapoint (node-red-contrib-ccu's paramCast, with the bugs fixed).
 */

/** OPERATIONS bit 2 = write */
export function isWriteable(description) {
    return !description || typeof description.OPERATIONS !== 'number' || Boolean(description.OPERATIONS & 2);
}

function enumIndex(value, description) {
    const list = description.VALUE_LIST || description.ENUM;
    if (typeof value === 'string' && Array.isArray(list)) {
        const index = list.indexOf(value);
        if (index !== -1) {
            return index;
        }
        const lower = list.findIndex((v) => String(v).toLowerCase() === value.toLowerCase());
        if (lower !== -1) {
            return lower;
        }
    }
    return value;
}

/**
 * Casts a value for setValue/putParamset. FLOATs are wrapped as {explicitDouble} so the XML-RPC
 * serializer emits <double> even for integral numbers. MIN/MAX are not enforced
 * (https://github.com/rdmtc/node-red-contrib-ccu/issues/74).
 * @param {*} value parsed payload (number, boolean, string, object)
 * @param {object} [description] paramset description of the parameter
 * @returns {*}
 */
export function castValue(value, description) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value; // already typed, e.g. {explicitDouble: 1}
    }
    switch (description && description.TYPE) {
        case 'ACTION':
        case 'BOOL':
            return toBool(value);
        case 'FLOAT': {
            const n = typeof value === 'boolean' ? Number(value) : Number.parseFloat(value);
            return {explicitDouble: Number.isFinite(n) ? n : 0};
        }
        case 'ENUM':
            return toInt(enumIndex(value, description));
        case 'INTEGER':
            return toInt(value);
        case 'STRING':
            return String(value);
        default:
            // unknown description: numbers as strings work for both double and integer datapoints
            return typeof value === 'number' ? String(value) : value;
    }
}

function toBool(value) {
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (['false', 'off', 'no', '0', ''].includes(s)) {
            return false;
        }
        if (['true', 'on', 'yes', '1'].includes(s)) {
            return true;
        }
        const n = Number(s);
        return Number.isNaN(n) ? true : n !== 0;
    }
    return Boolean(value);
}

function toInt(value) {
    if (typeof value === 'boolean') {
        return Number(value);
    }
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Casts a value for a ReGa variable (State()).
 * @param {*} value
 * @param {{type: 'boolean' | 'number' | 'string', enum?: string[]}} variable
 * @returns {boolean | number | string}
 */
export function castVariable(value, variable) {
    switch (variable && variable.type) {
        case 'boolean':
            if (typeof value === 'string' && variable.enum && variable.enum.includes(value)) {
                return variable.enum.indexOf(value) === 1;
            }
            return toBool(value);
        case 'string':
            return String(value);
        default:
            if (typeof value === 'string' && variable && variable.enum && variable.enum.includes(value)) {
                return variable.enum.indexOf(value);
            }
            if (typeof value === 'boolean') {
                return Number(value);
            }
            return Number.parseFloat(value) || 0;
    }
}
