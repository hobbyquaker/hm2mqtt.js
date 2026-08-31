<script>
    /**
     * One option: label, help text from the schema, the widget its type calls for, and - for the
     * few options where a plain input is not enough - a button that asks the CCU instead of asking
     * the user to know the answer.
     */
    let {name, schema, label, widget, value = $bindable(), lang, actions} = $props();

    const t = (de, en) => (lang === 'de' ? de : en);
    let placeholder = $derived(schema.default === undefined || schema.default === null ? '' : String(schema.default));

    let running = $state('');
    let result = $state(null);

    const INTERFACES = ['BidCos-RF', 'BidCos-Wired', 'HmIP-RF', 'VirtualDevices', 'CUxD'];

    let selectedInterfaces = $derived(
        String(value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

    /** @param {string} iface */
    function toggleInterface(iface) {
        const set = new Set(selectedInterfaces);
        set.has(iface) ? set.delete(iface) : set.add(iface);
        value = INTERFACES.filter((i) => set.has(i)).join(',');
    }

    let globs = $derived(
        String(value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

    /**
     * @param {number} index
     * @param {string} text
     */
    function setGlob(index, text) {
        const next = [...globs];
        next[index] = text.trim();
        value = next.filter(Boolean).join(',');
    }

    async function run(action, fn) {
        running = action;
        result = null;
        try {
            result = {ok: true, data: await fn()};
        } catch (error) {
            result = {ok: false, data: error.message};
        } finally {
            running = '';
        }
    }
</script>

<div class="field">
    <label class="label" for={name}>
        {label}
        {#if schema['x-env']}<code class="env">{schema['x-env']}</code>{/if}
    </label>

    {#if widget === 'switch'}
        <label class="switch">
            <input
                id={name}
                type="checkbox"
                checked={value === 'true' || (value === '' && schema.default === true)}
                onchange={(e) => (value = e.currentTarget.checked ? 'true' : 'false')}
            />
            <span>{value === 'true' || (value === '' && schema.default === true) ? t('an', 'on') : t('aus', 'off')}</span>
        </label>
    {:else if widget === 'select'}
        <select id={name} bind:value>
            <option value="">{t('Standard', 'default')} ({placeholder})</option>
            {#each schema.enum as choice}
                <option value={choice}>{choice}</option>
            {/each}
        </select>
    {:else if widget === 'password'}
        <input id={name} type="password" bind:value {placeholder} autocomplete="new-password" />
    {:else if widget === 'number'}
        <input id={name} type="number" bind:value {placeholder} />
    {:else if widget === 'interfaces'}
        <div class="interfaces">
            {#each INTERFACES as iface}
                <label class="check">
                    <input
                        type="checkbox"
                        checked={selectedInterfaces.includes(iface)}
                        onchange={() => toggleInterface(iface)}
                    />
                    {iface}
                </label>
            {/each}
            <label class="check">
                <input type="checkbox" checked={value === 'auto'} onchange={() => (value = value === 'auto' ? '' : 'auto')} />
                {t('automatisch (Ports prüfen)', 'auto (probe the ports)')}
            </label>
        </div>
        <button
            type="button"
            disabled={running === 'probe'}
            onclick={() =>
                run('probe', async () => {
                    const found = await actions.probe();
                    value = found.interfaces.join(',');
                    return found.interfaces.length
                        ? found.interfaces.join(', ')
                        : t('keine Schnittstelle geantwortet', 'no interface answered');
                })}
        >
            {running === 'probe' ? t('prüfe …', 'probing …') : t('Schnittstellen ermitteln', 'Probe interfaces')}
        </button>
    {:else if widget === 'globs'}
        <div class="globs">
            {#each [...globs, ''] as glob, index}
                <input
                    type="text"
                    value={glob}
                    placeholder="*.*.RSSI_*"
                    onchange={(e) => setGlob(index, e.currentTarget.value)}
                />
            {/each}
        </div>
    {:else if widget === 'ccu-address'}
        <div class="row">
            <input id={name} type="text" bind:value placeholder="127.0.0.1" />
            <button
                type="button"
                disabled={running === 'discover'}
                onclick={() =>
                    run('discover', async () => {
                        const {ccus} = await actions.discover();
                        if (ccus.length === 1) value = ccus[0].address;
                        return ccus.length
                            ? ccus.map((c) => `${c.address} ${c.name}`).join(', ')
                            : t('keine CCU gefunden', 'no CCU found');
                    })}
            >
                {running === 'discover' ? t('suche …', 'searching …') : t('CCU suchen', 'Find CCU')}
            </button>
        </div>
    {:else if widget === 'mqtt-url'}
        <div class="row">
            <input id={name} type="text" bind:value {placeholder} />
            <button
                type="button"
                disabled={running === 'test'}
                onclick={() =>
                    run('test', async () => {
                        const res = await actions.mqttTest(value || placeholder);
                        return t(`verbunden in ${res.ms} ms`, `connected in ${res.ms} ms`);
                    })}
            >
                {running === 'test' ? t('teste …', 'testing …') : t('Verbindung testen', 'Test connection')}
            </button>
        </div>
    {:else if widget === 'template'}
        <div class="row">
            <input id={name} type="text" bind:value {placeholder} />
            <button
                type="button"
                disabled={running === 'preview'}
                onclick={() =>
                    run('preview', async () => {
                        const {examples} = await actions.preview(value || placeholder);
                        return examples.map((e) => e.item).join('\n');
                    })}
            >
                {running === 'preview' ? t('…', '…') : t('Vorschau', 'Preview')}
            </button>
        </div>
    {:else}
        <input id={name} type="text" bind:value {placeholder} />
    {/if}

    <p class="help">{schema.description || ''}</p>

    {#if result}
        <pre class="result" class:bad={!result.ok}>{result.data}</pre>
    {/if}
</div>

<style>
    .field {
        margin: 0 0 1.1rem;
    }
    .label {
        display: block;
        font-weight: 600;
        margin-bottom: 0.25rem;
    }
    .env {
        font-weight: 400;
        color: #888;
        font-size: 0.78rem;
        margin-left: 0.4rem;
    }
    input[type='text'],
    input[type='password'],
    input[type='number'],
    select {
        width: 100%;
        max-width: 34rem;
        padding: 0.35rem 0.45rem;
        border: 1px solid #bbb;
        border-radius: 3px;
        font: inherit;
        background: #fff;
    }
    .row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
    }
    .globs input {
        margin-bottom: 0.3rem;
    }
    .interfaces {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem 1rem;
        margin-bottom: 0.4rem;
    }
    .check,
    .switch {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-weight: 400;
    }
    button {
        padding: 0.35rem 0.7rem;
        border: 1px solid #bbb;
        border-radius: 3px;
        background: #f6f6f6;
        font: inherit;
        cursor: pointer;
    }
    button:disabled {
        opacity: 0.6;
        cursor: default;
    }
    .help {
        margin: 0.25rem 0 0;
        color: #666;
        font-size: 0.82rem;
    }
    .result {
        margin: 0.4rem 0 0;
        padding: 0.4rem 0.55rem;
        background: #eef6ee;
        border-left: 3px solid #4a8;
        white-space: pre-wrap;
        font-size: 0.82rem;
    }
    .result.bad {
        background: #fdeeee;
        border-left-color: #c55;
    }
</style>
