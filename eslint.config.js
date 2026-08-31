import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/**', 'addon/ui/node_modules/**', 'addon/ui/dist/**', 'addon/work/**', 'dist/**'],
    },
    js.configs.recommended,
    prettier,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2025,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
        },
    },
    {
        // the addon's configuration UI runs in a browser, not in node
        files: ['addon/ui/src/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
        },
    },
];
