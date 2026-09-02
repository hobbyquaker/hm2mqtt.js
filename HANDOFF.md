# Handoff — 2026-09-02

Where things stand, so work can continue on another machine.

## Released

**v3.5.2 is out** (2026-09-01): npm, ghcr, GitHub release with all three addon packages
(armv7l/aarch64/x86_64, still `-beta` per H-41 — no install on real CCU hardware yet).
`master` == tag `v3.5.2`, working tree clean. It fixes what a full review of v3.3.0..HEAD found:

- **HA discovery was broken in 3.5.0/3.5.1** — the topic rework doubled `stat_t`/`cmd_t`
  (`hm/status/hm/status/…`); anyone on those versions with Home Assistant should upgrade.
- Addon: env values are shell-quoted now (passwords with spaces/`$( )` broke rc.d sourcing),
  `setnames.cgi` sets `ICU_DATA` (names could not be saved on a CCU3), unset booleans display as
  their default (Aktiviert/Deaktiviert wording).
- Template edges: plain tree follows `--topic-status`, `--item-template` warns and no longer
  overrides explicit `--topic-*`, positional `<name>/set/…` forms always work, overlap between set
  subscription and status tree is warned/ignored, `--ccu-tls` blocks auto local mode.

Details in CHANGELOG.md (§3.5.2); the five commits after `06e65c8` tell the story.

## Test deployment: hm2mqtt@hm3

- Runs on `ssh root@mqtt-ifaces` as `hm2mqtt@hm3`, bridging `homematic-ccu3` to
  `mqtt://mqtt.lan.raff.rocks` under prefix `hm3`. Ran cleanly for ~2 days (886 channels, hourly
  rega sync, no errors).
- **Currently stopped and disabled** (2026-09-02); config and state dir are intact.
  Bring it back: `systemctl enable --now hm2mqtt@hm3`. It was still on 3.5.x pre-release code —
  worth `npm i -g hm2mqtt@3.5.2` there before the next run.
- All retained `hm3/#` topics were wiped from the broker.

## hm3 vs. old Node-RED `hm/` tree — comparison result (2026-09-02)

Drop-in confirmed: 1565 common status topics, 1556 byte-identical values, identical payload shape
(hm3 adds `datapointUnit`). All 915 topics that exist only under `hm/` are stale retained history —
none changed during hm3's runtime. Differences to remember for the real cutover:

- Counters/`DUTY_CYCLE`: old flow publishes plain numbers, hm2mqtt the JSON `{val,ts,lc}` format.
- The old tree has a plain mirror `hm/state/…` — enable `--plain-tree state` if consumers need it.
- Stale retained `hm/set/Standby Audio Hobbyraum:3/STATE = false` still sits on the broker
  (deliberately untouched) — clear before anything replays `hm/set/#`.

## Open items

- Install the 3.5.2 addon package on real CCU hardware, then drop the `-beta` marking (H-41).
- Pre-existing since 3.3.0: `--uninstall -a auto` needs a successful network scan;
  `--discover-json` / `HM2MQTT_DISCOVER=1` don't work without a literal `--discover` in argv
  (core relaxes demandOption on the token only); `maintenance/stats` publishes despite
  `--no-maintenance`. The latter two belong in mqtt-interfaces-core.
- Release workflow gates `github-release` on all three addon builds — a transient addon-build
  failure leaves npm/ghcr published with no GitHub release (this is how 3.4.6 happened).
- Addon UI sends the MQTT password as a GET query parameter to `api.cgi` — could move to a POST
  body.
- Cutover plan for retiring the Node-RED `hm/` flow: run hm2mqtt as `hm` with
  `--plain-tree state`, clear the stale `hm/` retained topics beforehand.
