/**
 * Item names and the resolution of incoming topics to CCU targets.
 *
 * Items are the CCU's names, verbatim (H-3): <channelName>/<DATAPOINT>, <sysvarName>, <programName>,
 * counter/<iface>/rx|tx, interface/<iface>/connected, <ifaceAddress>/DUTY_CYCLE.
 */

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
