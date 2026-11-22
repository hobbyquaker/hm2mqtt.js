/**
 * One connection that keeps failing in the log: the first failure at warn, the same failure again
 * at debug, a summary at most every ten minutes while it lasts, one line when it works again. An
 * unreachable broker or ReGa is logged a handful of times a day instead of thousands of times
 * (B-11, B-7).
 */

/** how often a failure that lasts is summarised */
export const SUMMARY_MS = 600000;

/** `HH:MM` of a time, local */
export function clockTime(ms) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export class Outage {
    /**
     * @param {object} o
     * @param {object} o.log the logger, or a function returning it (it may not exist yet)
     * @param {string} o.label what fails, the first word of every line (`mqtt`, `rega`)
     * @param {() => number} [o.now] ms clock, for tests
     * @param {number} [o.summaryMs]
     */
    constructor({log, label, now = Date.now, summaryMs = SUMMARY_MS}) {
        this.getLog = typeof log === 'function' ? log : () => log;
        this.label = label;
        this.now = now;
        this.summaryMs = summaryMs;
        this.reset();
    }

    reset() {
        /** when the failure began, null while working */
        this.since = null;
        this.attempts = 0;
        this.lastSummary = 0;
        this.seen = new Set();
    }

    get failing() {
        return this.since !== null;
    }

    /**
     * A failed attempt.
     * @param {string} message the error, as the log shows it
     * @param {string} [hint] appended to the first line of a failure (what happens next)
     */
    fail(message, hint) {
        const log = this.getLog();
        const t = this.now();
        if (!this.failing) {
            this.since = t;
            this.lastSummary = t;
        }
        this.attempts += 1;
        if (!this.seen.has(message)) {
            // a new kind of failure is worth a line; one seen before in this outage is not
            this.seen.add(message);
            if (this.attempts === 1) {
                log.warn(this.label, message, ...(hint ? ['-', hint] : []));
            } else {
                log.warn(this.label, message, '- failing since', clockTime(this.since));
            }
            return;
        }
        if (t - this.lastSummary >= this.summaryMs) {
            this.lastSummary = t;
            log.warn(
                this.label,
                'still failing:',
                message,
                '-',
                this.attempts,
                'attempts since',
                clockTime(this.since),
            );
            return;
        }
        log.debug(this.label, message, '(attempt', this.attempts + ')');
    }

    /**
     * It works (again): one info line when it had failed.
     * @param {string} what e.g. `connected again`
     * @returns {boolean} whether there was a failure to end
     */
    ok(what = 'working again') {
        if (!this.failing) {
            return false;
        }
        const n = this.attempts;
        this.getLog().info(
            this.label,
            what,
            'after',
            n,
            n === 1 ? 'failed attempt' : 'failed attempts',
            'since',
            clockTime(this.since),
        );
        this.reset();
        return true;
    }
}
