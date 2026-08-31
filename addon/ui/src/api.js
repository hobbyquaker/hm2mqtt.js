/**
 * Calls to the addon's CGIs. Every request carries the WebUI session id from the page URL -
 * settings.cgi only serves this page with a valid one, and each CGI checks it again.
 */

const sid = new URLSearchParams(location.search).get('sid') || '';

/**
 * @param {object} [params]
 * @returns {string}
 */
function query(params = {}) {
    const search = new URLSearchParams({sid});
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            search.set(key, String(value));
        }
    }
    return search.toString();
}

async function json(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(text.slice(0, 200) || 'no answer');
    }
    if (data && data.error) throw new Error(data.error);
    return data;
}

/** The option schema written by the build (`hm2mqtt --config-schema`). */
export const getSchema = () => json('config-schema.json');

/** Current configuration; passwords come back as the placeholder, never in clear. */
export const getConfig = () => json(`getconfig.cgi?${query()}`);

/**
 * Writes the configuration file. `text` is the file as it should be, one HM2MQTT_KEY=value per
 * line; a password left at the placeholder keeps its stored value.
 * @param {string} text
 */
export const setConfig = (text) =>
    json(`setconfig.cgi?${query()}`, {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: text});

export const getStatus = () => json(`service.cgi?${query({cmd: 'status'})}`);

/** @param {'start'|'stop'|'restart'} cmd */
export const service = (cmd) => json(`service.cgi?${query({cmd})}`);

/** @param {number} [lines] */
export async function getLog(lines = 200) {
    const response = await fetch(`log.cgi?${query({lines})}`);
    return response.text();
}

/**
 * The helpers that need node: discover, probe, mqtt-test, channels, preview.
 * @param {string} cmd
 * @param {object} [params]
 */
export const call = (cmd, params = {}) => json(`api.cgi?${query({cmd, ...params})}`);
