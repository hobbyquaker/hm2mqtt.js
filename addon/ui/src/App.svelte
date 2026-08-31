<script>
    /**
     * The addon's configuration page: every hm2mqtt option in a form, plus service control and the
     * log. The option list is not maintained here - it comes from the app's own --config-schema
     * output, so a new CLI option appears in this page by itself (H-38).
     */
    import {onMount} from 'svelte';
    import * as api from './api.js';
    import {GROUPS, OPTIONS, NOT_APPLICABLE, widgetFor} from './options.js';
    import Field from './Field.svelte';

    let lang = $state(localStorage.getItem('hm2mqtt-lang') || 'de');
    const t = (de, en) => (lang === 'de' ? de : en);

    let schema = $state(null);
    let values = $state({});
    let saved = $state({});
    let status = $state({});
    let logText = $state('');
    let showLog = $state(false);
    let error = $state('');
    let notice = $state('');
    let busy = $state('');
    let open = $state(Object.fromEntries(GROUPS.map((g) => [g.id, Boolean(g.open)])));

    let dirty = $derived(JSON.stringify(values) !== JSON.stringify(saved));

    /** Options of one group, in the order the descriptor table lists them. */
    function fieldsOf(groupId) {
        if (!schema) return [];
        return Object.keys(OPTIONS)
            .filter((key) => OPTIONS[key].group === groupId && schema.properties[key])
            .map((key) => ({key, schema: schema.properties[key], ui: OPTIONS[key]}));
    }

    /** The env variable an option is stored under. */
    const envOf = (key) => schema.properties[key]['x-env'];

    async function load() {
        try {
            schema = await api.getSchema();
            const config = await api.getConfig();
            values = {...config};
            saved = {...config};
            await refreshStatus();
        } catch (err) {
            error = err.message;
        }
    }

    async function refreshStatus() {
        try {
            status = await api.getStatus();
        } catch (err) {
            error = err.message;
        }
    }

    /** The configuration file as it should look after saving. */
    function envFile() {
        const lines = ['# written by the hm2mqtt addon UI - see Systemsteuerung -> hm2mqtt'];
        for (const [key, value] of Object.entries(values)) {
            if (value === '' || value === undefined || value === null) continue;
            lines.push(`${key}=${value}`);
        }
        return lines.join('\n') + '\n';
    }

    async function save({restart = false} = {}) {
        busy = restart ? 'save-restart' : 'save';
        error = '';
        notice = '';
        try {
            await api.setConfig(envFile());
            saved = {...values};
            notice = t('Konfiguration gespeichert', 'Configuration saved');
            if (restart) {
                await api.service('restart');
                notice = t('Gespeichert, Dienst neu gestartet', 'Saved, service restarted');
            }
            await refreshStatus();
        } catch (err) {
            error = err.message;
        } finally {
            busy = '';
        }
    }

    /** @param {'start'|'stop'|'restart'} cmd */
    async function control(cmd) {
        busy = cmd;
        error = '';
        notice = '';
        try {
            await api.service(cmd);
            await refreshStatus();
            notice = t('Dienst: ', 'Service: ') + cmd;
        } catch (err) {
            error = err.message;
        } finally {
            busy = '';
        }
    }

    async function loadLog() {
        try {
            logText = await api.getLog(300);
        } catch (err) {
            error = err.message;
        }
    }

    const actions = {
        discover: () => api.call('discover'),
        probe: () => api.call('probe', {host: values.HM2MQTT_CCU_ADDRESS || '127.0.0.1'}),
        mqttTest: (url) =>
            api.call('mqtt-test', {
                url,
                username: values.HM2MQTT_MQTT_USERNAME,
                // a password still behind the placeholder cannot be tested from the browser
                password: values.HM2MQTT_MQTT_PASSWORD === '********' ? '' : values.HM2MQTT_MQTT_PASSWORD,
            }),
        preview: (template) => api.call('preview', {template, host: values.HM2MQTT_CCU_ADDRESS || '127.0.0.1', limit: 5}),
    };

    function switchLang() {
        lang = lang === 'de' ? 'en' : 'de';
        localStorage.setItem('hm2mqtt-lang', lang);
    }

    onMount(() => {
        load();
        const timer = setInterval(refreshStatus, 10000);
        return () => clearInterval(timer);
    });
</script>

<header>
    <div class="title">
        <strong>hm2mqtt</strong>
        <span class="version">{status.VERSION_ADDON || ''}</span>
        {#if status.NODE_VERSION}<span class="muted">node {status.NODE_VERSION}</span>{/if}
    </div>
    <div class="state">
        <span class="dot" class:on={status.running}></span>
        {#if status.running}
            {t('läuft', 'running')} · pid {status.pid} · {Math.round(Number(status.rss || 0) / 1024)} MB · {status.uptime}
        {:else}
            {t('gestoppt', 'stopped')}
        {/if}
    </div>
    <div class="spacer"></div>
    <button onclick={() => control('restart')} disabled={busy !== ''}>{t('Neu starten', 'Restart')}</button>
    <button onclick={() => control(status.running ? 'stop' : 'start')} disabled={busy !== ''}>
        {status.running ? t('Stoppen', 'Stop') : t('Starten', 'Start')}
    </button>
    <button
        onclick={() => {
            showLog = !showLog;
            if (showLog) loadLog();
        }}>{t('Log', 'Log')}</button
    >
    <button onclick={switchLang} title="Sprache / language">{lang === 'de' ? 'EN' : 'DE'}</button>
</header>

{#if error}<div class="banner bad">{error}</div>{/if}
{#if notice}<div class="banner good">{notice}</div>{/if}

{#if showLog}
    <section class="log">
        <div class="logbar">
            <strong>{t('Protokoll', 'Log')}</strong>
            <button onclick={loadLog}>{t('Aktualisieren', 'Refresh')}</button>
        </div>
        <pre>{logText}</pre>
    </section>
{/if}

{#if !schema}
    <p class="loading">{t('lädt …', 'loading …')}</p>
{:else}
    <main>
        {#each GROUPS as group}
            {@const fields = fieldsOf(group.id)}
            {#if fields.length}
                <section class="group">
                    <button class="grouphead" onclick={() => (open[group.id] = !open[group.id])}>
                        <span class="caret">{open[group.id] ? '▾' : '▸'}</span>
                        {lang === 'de' ? group.de : group.en}
                        <span class="count">{fields.length}</span>
                    </button>
                    {#if open[group.id]}
                        <div class="fields">
                            {#each fields as field}
                                <Field
                                    name={field.key}
                                    schema={field.schema}
                                    label={lang === 'de' ? field.ui.de : field.ui.en}
                                    widget={widgetFor(field.key, field.schema)}
                                    bind:value={values[envOf(field.key)]}
                                    {lang}
                                    {actions}
                                />
                            {/each}
                        </div>
                    {/if}
                </section>
            {/if}
        {/each}
    </main>

    <footer>
        <button class="primary" onclick={() => save({restart: true})} disabled={busy !== ''}>
            {busy === 'save-restart' ? t('speichere …', 'saving …') : t('Speichern & Neustart', 'Save & restart')}
        </button>
        <button onclick={() => save()} disabled={busy !== ''}>{t('Nur speichern', 'Save only')}</button>
        {#if dirty}<span class="muted">{t('ungespeicherte Änderungen', 'unsaved changes')}</span>{/if}
    </footer>
{/if}

<style>
    :global(body) {
        margin: 0;
        font-family:
            system-ui,
            -apple-system,
            'Segoe UI',
            sans-serif;
        font-size: 14px;
        color: #222;
        background: #fafafa;
    }
    header {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.6rem 1rem;
        background: #fff;
        border-bottom: 1px solid #ddd;
        position: sticky;
        top: 0;
        flex-wrap: wrap;
    }
    .title strong {
        font-size: 1.05rem;
    }
    .version {
        margin-left: 0.4rem;
        color: #555;
    }
    .muted {
        color: #888;
        margin-left: 0.4rem;
    }
    .spacer {
        flex: 1;
    }
    .state {
        color: #555;
    }
    .dot {
        display: inline-block;
        width: 0.6rem;
        height: 0.6rem;
        border-radius: 50%;
        background: #c55;
        margin-right: 0.35rem;
    }
    .dot.on {
        background: #4a8;
    }
    main,
    footer,
    .banner,
    .log,
    .loading {
        max-width: 52rem;
        margin: 0 auto;
        padding: 0 1rem;
    }
    .banner {
        margin-top: 0.8rem;
        padding: 0.5rem 1rem;
        border-radius: 3px;
    }
    .banner.bad {
        background: #fdeeee;
        border-left: 3px solid #c55;
    }
    .banner.good {
        background: #eef6ee;
        border-left: 3px solid #4a8;
    }
    .group {
        margin: 1rem 0;
        background: #fff;
        border: 1px solid #e2e2e2;
        border-radius: 4px;
    }
    .grouphead {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.6rem 0.8rem;
        background: none;
        border: 0;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        text-align: left;
    }
    .count {
        color: #999;
        font-weight: 400;
    }
    .fields {
        padding: 0.2rem 0.8rem 0.8rem;
    }
    footer {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding-bottom: 2rem;
    }
    button {
        padding: 0.35rem 0.7rem;
        border: 1px solid #bbb;
        border-radius: 3px;
        background: #f6f6f6;
        font: inherit;
        cursor: pointer;
    }
    button.primary {
        background: #2d6cb5;
        border-color: #2d6cb5;
        color: #fff;
    }
    button:disabled {
        opacity: 0.6;
        cursor: default;
    }
    .log pre {
        background: #fff;
        border: 1px solid #e2e2e2;
        padding: 0.6rem;
        max-height: 22rem;
        overflow: auto;
        font-size: 0.78rem;
    }
    .logbar {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin-top: 1rem;
    }
    .loading {
        color: #666;
        padding-top: 2rem;
    }
</style>
