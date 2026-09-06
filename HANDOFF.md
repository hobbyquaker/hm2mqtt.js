# Handoff — 2026-09-06

Where things stand, so work can continue on another machine.

## Released

**v3.6.0** — hm2mqtt runs on [openccu-lite](https://github.com/hobbyquaker/openccu-lite), the CCU
firmware without ReGaHSS. Names, rooms and functions come from the box's metadata API there; on a
CCU3 / RaspberryMatic / OpenCCU nothing changed. ROADMAP §16 holds the decisions (H-46…H-52),
CHANGELOG §3.6.0 the user-facing summary.

- `lib/meta.js` (`MetaSync`) is a second names provider with the same public surface as
  `lib/rega.js`; `lib/names.js` is what the two share. `index.js` picks one at start with a single
  unauthenticated `GET /api/meta/v1/version` (H-47), and re-probes every 60 s when the box did not
  answer at all.
- Snapshot at start, then the box's SSE stream — a rename on the box is in the topics about a
  second later. Cached in `meta.json` in the state directory. No new dependency (`node:http`).
- `--meta-token` for the credential off the box; on the box `/usr/local/etc/occulite/local-token`
  is read automatically. A 401 logs once and degrades to addresses.
- System variables, programs and `--publish-cache` do not exist on such a box: the options stay
  accepted, one log line at start says so (H-49).
- The addon package is unchanged except for the pid file, which moves to `/run/addon-hm2mqtt/`
  when that directory exists (a confined addon on openccu-lite's systemd products, H-52).

**v3.5.2** (2026-09-01) is the release before it: npm, ghcr, GitHub release with all three addon
packages (armv7l/aarch64/x86_64, still `-beta` per H-41 — no install on real CCU hardware yet).

## Testing this port

- `npm test` — 104 tests, no box and no broker needed; `test/meta.test.js` runs the provider
  against openccu-lite's conformance corpus (`test/fixtures/meta/`, copied from the box's
  repository) and a fake `/api/meta/v1` server.
- The real thing, opt-in, needs the daemon from an openccu-lite checkout:

  ```
  cd ~/repos/openccu-lite && go build -o /tmp/occulited ./cmd/occulited
  cd ~/repos/hm2mqtt.js  && HM2MQTT_OCCULITE=/tmp/occulited npm run test:occulite
  ```

  It starts `occulited` on a temporary state directory, creates the admin through
  `POST /api/auth/v1/setup`, imports a document, and runs the whole adapter (hm-simulator + aedes)
  against it: 6 tests, ~5 s. It uses hm-simulator's fixed ports like `test/e2e.test.js` — do not
  run both at once.

## Test deployment: hm2mqtt@hm3

- Runs on `ssh root@mqtt-ifaces` as `hm2mqtt@hm3`, bridging `homematic-ccu3` to
  `mqtt://mqtt.lan.raff.rocks` under prefix `hm3`.
- **Currently stopped and disabled** (2026-09-02); config and state dir are intact.
  Bring it back: `systemctl enable --now hm2mqtt@hm3`, after `npm i -g hm2mqtt@3.6.0` there.
- All retained `hm3/#` topics were wiped from the broker. The old Node-RED `hm/` tree was compared
  against it on 2026-09-02: drop-in confirmed (1565 common topics, 1556 byte-identical). For the
  real cutover: counters/`DUTY_CYCLE` are JSON here and plain numbers there, the old tree has a
  plain mirror (`--plain-tree state`), and a stale retained
  `hm/set/Standby Audio Hobbyraum:3/STATE = false` still sits on the broker.

## Open items

- **Nothing has run on a real openccu-lite box** (OQ-64): the port was written and tested against
  `occulited` built from source on a laptop. Open there: the addon install, the confined-addon pid
  path, `/usr/local/etc/occulite/local-token`, and an off-box run through the box's XML-RPC proxy
  (OQ-65, the interfaces are loopback-only on that firmware).
- Install the addon package on real CCU hardware, then drop the `-beta` marking (H-41).
- Pre-existing since 3.3.0: `--uninstall -a auto` needs a successful network scan;
  `--discover-json` / `HM2MQTT_DISCOVER=1` don't work without a literal `--discover` in argv;
  `maintenance/stats` publishes despite `--no-maintenance`. The latter two belong in
  mqtt-interfaces-core.
- Release workflow gates `github-release` on all three addon builds — a transient addon-build
  failure leaves npm/ghcr published with no GitHub release (this is how 3.4.6 happened).
- Addon UI sends the MQTT password as a GET query parameter to `api.cgi` — could move to a POST
  body.
- `addon/test/cgi-test.sh` needs a `tclsh`; a machine without one (a plain WSL install) cannot run
  it locally, and CI is the first place a broken CGI shows up.
