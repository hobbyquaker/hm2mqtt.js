/**
 * What every names provider does with its result, whatever it read it from: apply the name file
 * on top, index the names for the reverse lookup, and resolve a name or address coming in on a
 * set topic. Shared by lib/rega.js (ReGaHSS) and lib/meta.js (openccu-lite).
 */

/**
 * Overrides the names read from the box with the ones from `--name-file` and returns the reverse
 * index (name -> address). `channelNames` is mutated, as the providers' own state.
 * @param {Object<string, string>} channelNames
 * @param {Object<string, string>} [nameFile]
 * @returns {Object<string, string>} name -> address
 */
export function indexNames(channelNames, nameFile = {}) {
    for (const [address, name] of Object.entries(nameFile)) {
        if (typeof name === 'string' && name !== '') {
            channelNames[address] = name;
        }
    }
    const addresses = {};
    for (const [address, name] of Object.entries(channelNames)) {
        // the first address of a duplicate name wins; channels win over devices
        if (!addresses[name] || (address.includes(':') && !addresses[name].includes(':'))) {
            addresses[name] = address;
        }
    }
    return addresses;
}

/**
 * Address of a channel (or device, with `devices`) by name or address.
 * @param {{addresses: Object<string, string>, metadata?: object}} provider
 * @param {string} nameOrAddress
 * @param {boolean} [devices]
 */
export function resolveAddress({addresses, metadata}, nameOrAddress, devices = false) {
    let address;
    if (metadata && metadata.findIface(nameOrAddress)) {
        address = nameOrAddress;
    } else if (addresses[nameOrAddress]) {
        address = addresses[nameOrAddress];
    } else if (!metadata && /^[\w-]+(:\d+)?$/.test(nameOrAddress)) {
        address = nameOrAddress;
    }
    if (!address) {
        return undefined;
    }
    return devices || address.includes(':') ? address : undefined;
}
