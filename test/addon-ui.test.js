/**
 * The addon UI must offer every option hm2mqtt has (H-38): a new CLI option cannot ship without a
 * place in the configuration page. The UI renders from the app's own `--config-schema` output, so
 * the only thing that can drift is the descriptor table that says which group and widget an option
 * belongs to - which is exactly what this checks.
 */

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {GROUPS, OPTIONS, NOT_APPLICABLE, widgetFor} from '../addon/ui/src/options.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// via a file, not a pipe: --config-schema prints and calls process.exit(), which truncates a
// pipe at its buffer (8 KB) while a file write is synchronous and always complete - core G-7.
const schemaFile = path.join(os.tmpdir(), `hm2mqtt-schema-${process.pid}.json`);
const fd = fs.openSync(schemaFile, 'w');
try {
    execFileSync(process.execPath, [path.join(root, 'index.js'), '--config-schema'], {
        stdio: ['ignore', fd, 'inherit'],
    });
} finally {
    fs.closeSync(fd);
}
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
fs.rmSync(schemaFile, {force: true});
const options = Object.keys(schema.properties);

describe('addon configuration UI', () => {
    it('covers every option of the CLI', () => {
        const missing = options.filter((key) => !OPTIONS[key] && !NOT_APPLICABLE[key]);
        assert.deepEqual(
            missing,
            [],
            `these options have no place in the addon UI - add them to OPTIONS in addon/ui/src/options.js, ` +
                `or to NOT_APPLICABLE with a reason: ${missing.join(', ')}`,
        );
    });

    it('describes no option that does not exist', () => {
        const unknown = [...Object.keys(OPTIONS), ...Object.keys(NOT_APPLICABLE)].filter(
            (key) => !options.includes(key),
        );
        assert.deepEqual(unknown, [], `unknown options in the UI descriptors: ${unknown.join(', ')}`);
    });

    it('puts every option in a group that exists, with a label in both languages', () => {
        const groups = new Set(GROUPS.map((group) => group.id));
        for (const [key, ui] of Object.entries(OPTIONS)) {
            assert.ok(groups.has(ui.group), `${key} is in unknown group "${ui.group}"`);
            assert.ok(ui.de && ui.en, `${key} needs a German and an English label`);
        }
    });

    it('gives every option a widget that fits its type', () => {
        for (const key of options) {
            if (NOT_APPLICABLE[key]) continue;
            const property = schema.properties[key];
            const widget = widgetFor(key, property);
            assert.ok(widget, `${key} has no widget`);
            if (property['x-secret']) {
                assert.equal(widget, 'password', `${key} is a secret and must render masked`);
            }
            if (Array.isArray(property.enum) && !OPTIONS[key].widget) {
                assert.equal(widget, 'select', `${key} has fixed choices and should be a select`);
            }
            if (property.type === 'boolean' && !OPTIONS[key].widget) {
                assert.equal(widget, 'switch', `${key} is a boolean and should be a switch`);
            }
        }
    });

    it('has no empty group', () => {
        for (const group of GROUPS) {
            const count = Object.values(OPTIONS).filter((ui) => ui.group === group.id).length;
            assert.ok(count > 0, `group "${group.id}" has no options`);
        }
    });
});
