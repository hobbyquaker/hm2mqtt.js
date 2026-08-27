/**
 * Item names and the resolution of incoming topics to CCU targets.
 *
 * Items are the CCU's names, verbatim (H-3): <channelName>/<DATAPOINT>, <sysvarName>, <programName>,
 * counter/<iface>/rx|tx, interface/<iface>/connected, <ifaceAddress>/DUTY_CYCLE.
 */

export const DEFAULT_ITEM_TEMPLATE = '${channelName|channel}/${datapoint}';
export const DEFAULT_SYSVAR_ITEM_TEMPLATE = '${name}';
export const DEFAULT_PROGRAM_ITEM_TEMPLATE = '${name}';

/** first topic levels an adapter uses itself; a channel or variable with such a name gets a suffix */
export const RESERVED = new Set(['counter', 'interface', 'rega', 'paramset', 'rpc', 'response']);

/**
 * Makes a CCU name usable as topic level(s): `+`, `#` and empty levels are replaced, `/` is kept
 * (a deeper topic, as node-red-contrib-ccu did). Returns the name and whether it was changed.
 * @param {string} name
 * @returns {{name: string, changed: boolean}}
 */
export function sanitizeName(name) {
    const original = String(name);
    let out = original.replace(/[+#]/g, '_');
    out = out
        .split('/')
        .map((level) => (level === '' ? '_' : level))
        .join('/');
    if (RESERVED.has(out.split('/')[0])) {
        out = out.replace(/^[^/]+/, (m) => m + '_');
    }
    return {name: out, changed: out !== original};
}

/**
 * Status item of a datapoint event.
 * @param {string} channelName ReGa name or the address when unknown
 * @param {string} datapoint
 */
export function datapointItem(channelName, datapoint) {
    return sanitizeName(channelName).name + '/' + datapoint;
}

/**
 * Resolves the levels of <name>/set/<...> to a target.
 *   [<channelNameOrAddress...>, <datapoint>] → datapoint
 *   [<sysvarOrProgramName...>]              → sysvar or program
 *   ['rega', 'sync']                        → command
 * The last level is the datapoint when the rest names a channel; a sysvar/program name wins when
 * the whole path is one (they may contain "/" too).
 * @param {string[]} parts
 * @param {{channelAddress: (name: string) => string | undefined, isSysvar: (name: string) => boolean,
 *          isProgram: (name: string) => boolean}} lookup
 * @returns {{kind: 'datapoint', address: string, datapoint: string} | {kind: 'sysvar' | 'program', name: string}
 *          | {kind: 'command', command: string} | null}
 */
export function resolveSet(parts, lookup) {
    if (parts.length === 0) {
        return null;
    }
    if (parts[0] === 'rega' && parts.length === 2) {
        return {kind: 'command', command: parts[1]};
    }
    const whole = parts.join('/');
    if (lookup.isSysvar(whole)) {
        return {kind: 'sysvar', name: whole};
    }
    if (lookup.isProgram(whole)) {
        return {kind: 'program', name: whole};
    }
    if (parts.length >= 2) {
        const datapoint = parts[parts.length - 1];
        const channel = parts.slice(0, -1).join('/');
        const address = lookup.channelAddress(channel);
        if (address) {
            return {kind: 'datapoint', address, datapoint};
        }
    }
    return null;
}

/**
 * Resolves the levels of <name>/paramset/<channelNameOrAddress...>/<paramset>[/<param>].
 * With `single`, the last level is the parameter name.
 * @param {string[]} parts
 * @param {{channelAddress: (name: string) => string | undefined}} lookup
 * @param {{single?: boolean}} [options]
 * @returns {{address: string, paramset: string, param?: string} | null}
 */
export function resolveParamset(parts, lookup, {single = false} = {}) {
    const need = single ? 3 : 2;
    if (parts.length < need) {
        return null;
    }
    const param = single ? parts[parts.length - 1] : undefined;
    const paramset = parts[parts.length - (single ? 2 : 1)];
    const channel = parts.slice(0, parts.length - (single ? 2 : 1)).join('/');
    const address = lookup.channelAddress(channel, true);
    if (!address) {
        return null;
    }
    return single ? {address, paramset, param} : {address, paramset};
}

/** Plain payload as the second ccu-mqtt node emitted it: booleans as 0/1, the rest as is. */
export function plainValue(value) {
    return typeof value === 'boolean' ? Number(value) : value;
}

/**
 * Compiles an item template like node-red-contrib-ccu's topic templates: `${field}` placeholders
 * with a `|` fallback chain (`${channelName|channel}`), field names case-insensitive, every field
 * of the `hm` block available. An empty result of a placeholder becomes `_`. The rendered item is
 * passed through sanitizeName().
 * @param {string} template
 * @returns {(fields: object) => {name: string, changed: boolean}}
 */
export function compileTemplate(template) {
    const parts = [];
    const re = /\$\{([^}]+)\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(template)) !== null) {
        if (m.index > last) {
            parts.push(template.slice(last, m.index));
        }
        parts.push(
            m[1]
                .split('|')
                .map((f) => f.trim().toLowerCase())
                .filter(Boolean),
        );
        last = m.index + m[0].length;
    }
    if (last < template.length) {
        parts.push(template.slice(last));
    }
    return (fields) => {
        const lower = {};
        for (const [k, v] of Object.entries(fields || {})) {
            lower[k.toLowerCase()] = v;
        }
        let out = '';
        for (const part of parts) {
            if (typeof part === 'string') {
                out += part;
                continue;
            }
            let value = '';
            for (const key of part) {
                const v = lower[key];
                if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
                    continue;
                }
                value = Array.isArray(v) ? v.join(',') : String(v);
                break;
            }
            out += value === '' ? '_' : value;
        }
        return sanitizeName(out);
    };
}

/**
 * Reverse map item → target for `set` topics: {address, datapoint} for datapoints,
 * {sysvar} / {program} for ReGa objects. The first target of a colliding item wins.
 */
export class ItemIndex {
    constructor() {
        this.items = new Map();
        this.collisions = new Map();
    }

    clear(kind) {
        if (!kind) {
            this.items.clear();
            this.collisions.clear();
            return;
        }
        for (const [item, target] of this.items) {
            if (target.kind === kind) {
                this.items.delete(item);
            }
        }
    }

    add(item, target) {
        const existing = this.items.get(item);
        if (!existing) {
            this.items.set(item, target);
            return true;
        }
        if (
            existing.kind === target.kind &&
            existing.address === target.address &&
            existing.datapoint === target.datapoint &&
            existing.name === target.name
        ) {
            return true;
        }
        this.collisions.set(item, [existing, target]);
        return false;
    }

    get(item) {
        return this.items.get(item);
    }

    get size() {
        return this.items.size;
    }
}
