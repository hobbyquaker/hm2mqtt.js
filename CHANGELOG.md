# Changelog

## 3.0.0 (unreleased)

Rewrite on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core) as a
drop-in replacement for the node-red-contrib-ccu `ccu-mqtt` flow. See README "Migration" for the
topic tables (Node-RED flow → 3.0, 2.x → 3.0) and ROADMAP.md for the decisions.

### Breaking

- ES module, Node.js ≥ 20.19; new options (`--ccu-address` stays, everything else per `--help`).
- Topics follow the Node-RED flow, not 2.x: `set/<variable>` instead of `rega/…`,
  `paramset/<ch>/<paramset>/<param>` instead of `param/…`, CCU interface names.
- Payloads are `{val, ts, lc, hm}` with node-red-contrib-ccu's message as `hm` block.

### Added

- `<name>/connected` 0/1/2 reflecting every interface and the ReGa; per-interface
  `status/interface/<iface>/connected`; `<name>/info`; maintenance topics (core).
- `--plain-tree`, `--publish-cache`, `--rpc-topics`, `--name-file`, `--ccu-tls`/`--ccu-username`,
  `--interfaces auto`, `--ccu-timezone`, `--state-dir`.
- Paramset descriptions seeded from node-red-contrib-ccu's collection; unknown ones fetched.
