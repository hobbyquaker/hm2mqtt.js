import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {viteSingleFile} from 'vite-plugin-singlefile';

// One self-contained index.html: the CCU's lighttpd serves it through settings.cgi (which checks
// the session first), and a single file means no asset paths, no MIME surprises and one thing to
// copy into the package.
export default defineConfig({
    plugins: [svelte(), viteSingleFile()],
    build: {
        target: 'es2020',
        outDir: 'dist',
        emptyOutDir: true,
        assetsInlineLimit: 100000000,
        chunkSizeWarningLimit: 2000,
    },
});
