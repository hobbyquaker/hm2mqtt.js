/**
 * Comparison of two status trees (the Node-RED flow's `hm/...` and hm2mqtt's `hm3/...` during
 * the parallel run before the cutover, ROADMAP §9): which items exist on one side only, and
 * where `val` or the `hm` fields differ.
 */

/** hm fields that legitimately differ between the two implementations */
export const IGNORED_HM_FIELDS = new Set([
    'ts',
    'tsPrevious',
    'lc',
    'lcPrevious',
    'cache',
    'uncertain',
    'change',
    'valuePrevious',
    'valueEnumPrevious',
]);

/** hm fields hm2mqtt adds (missing on the flow side is expected) */
export const ADDED_HM_FIELDS = new Set(['datapointUnit', 'datapointEnum', 'valueEnum']);

/** items hm2mqtt publishes that the flow never had */
export const ADDED_ITEMS = /^(interface\/|.*\/(CARRIER_SENSE_LEVEL|CONNECTED)$)/;

function parse(raw) {
    try {
        const p = JSON.parse(raw);
        return p && typeof p === 'object' && 'val' in p ? p : {val: p};
    } catch {
        return {val: raw};
    }
}

function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {Map<string, string>} left item → raw payload (the reference, e.g. the flow)
 * @param {Map<string, string>} right item → raw payload (hm2mqtt)
 * @returns {{leftOnly: string[], rightOnly: string[], differences: Array<{item: string, field: string, left: *, right: *}>, same: number}}
 */
export function compareTrees(left, right) {
    const leftOnly = [];
    const rightOnly = [];
    const differences = [];
    let sameCount = 0;
    for (const item of left.keys()) {
        if (!right.has(item)) {
            leftOnly.push(item);
        }
    }
    for (const item of right.keys()) {
        if (!left.has(item) && !ADDED_ITEMS.test(item)) {
            rightOnly.push(item);
        }
    }
    for (const [item, rawLeft] of left) {
        if (!right.has(item)) {
            continue;
        }
        const l = parse(rawLeft);
        const r = parse(right.get(item));
        let differs = false;
        if (!same(l.val, r.val)) {
            differences.push({item, field: 'val', left: l.val, right: r.val});
            differs = true;
        }
        const hl = l.hm || {};
        const hr = r.hm || {};
        for (const field of new Set([...Object.keys(hl), ...Object.keys(hr)])) {
            if (IGNORED_HM_FIELDS.has(field)) {
                continue;
            }
            if (!(field in hl) && ADDED_HM_FIELDS.has(field)) {
                continue;
            }
            if (!same(hl[field], hr[field])) {
                differences.push({item, field: 'hm.' + field, left: hl[field], right: hr[field]});
                differs = true;
            }
        }
        if (!differs) {
            sameCount += 1;
        }
    }
    leftOnly.sort();
    rightOnly.sort();
    return {leftOnly, rightOnly, differences, same: sameCount};
}

export function formatReport(
    {leftOnly, rightOnly, differences, same},
    {leftName = 'left', rightName = 'right', limit = 50} = {},
) {
    const lines = [];
    lines.push(
        `${same} items identical, ${differences.length} differences, ${leftOnly.length} only in ${leftName}, ${rightOnly.length} only in ${rightName}`,
    );
    const list = (title, items) => {
        if (items.length === 0) {
            return;
        }
        lines.push('', `${title} (${items.length}):`);
        for (const i of items.slice(0, limit)) {
            lines.push('  ' + i);
        }
        if (items.length > limit) {
            lines.push(`  … ${items.length - limit} more`);
        }
    };
    list(`only in ${leftName}`, leftOnly);
    list(`only in ${rightName}`, rightOnly);
    if (differences.length > 0) {
        lines.push('', `differences (${differences.length}):`);
        for (const d of differences.slice(0, limit)) {
            lines.push(`  ${d.item} ${d.field}: ${JSON.stringify(d.left)} → ${JSON.stringify(d.right)}`);
        }
        if (differences.length > limit) {
            lines.push(`  … ${differences.length - limit} more`);
        }
    }
    return lines.join('\n');
}
