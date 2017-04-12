# hm2mqtt.js

[![License][mit-badge]][mit-url]
[![NPM version](https://badge.fury.io/js/hm2mqtt.svg)](http://badge.fury.io/js/hm2mqtt)
[![Dependency Status](https://img.shields.io/gemnasium/hobbyquaker/hm2mqtt.js.svg?maxAge=2592000)](https://gemnasium.com/github.com/hobbyquaker/hm2mqtt.js)
[![Build Status](https://travis-ci.org/hobbyquaker/hm2mqtt.js.svg?branch=master)](https://travis-ci.org/hobbyquaker/hm2mqtt.js)

> Node.js based Interface between Homematic and MQTT

Because [hm2mqtt](https://github.com/owagner/hm2mqtt) isn't developed anymore and I don't really like Java I decided to 
re-implement this with Node.js

It's kind of the same like the original hm2mqtt, but it supports XMLRPC (hm2mqtt only supports BINRPC), so it can 
be used with Homematic IP also.

### Installation

Prerequisites: [Node.js](https://nodejs.org)

`npm install -g hm2mqtt`

I suggest to use [pm2](http://pm2.keymetrics.io/) to manage the hm2mqtt process (start on system boot, manage log files, 
...)

### Command Line Options

```
Usage: hm2mqtt [options]

Options:
  --version                 Show version number                        [boolean]
  -h, --help                Show help                                  [boolean]
  -m, --mqtt-url            mqtt broker url.       [default: "mqtt://127.0.0.1"]
  -n, --name                instance name. used as mqtt client id and as prefix
                            for connected topic                  [default: "hm"]
  -p, --mqtt-password       mqtt broker password
  -u, --mqtt-username       mqtt broker username
  -v, --verbosity           possible values: "error", "warn", "info", "debug"
                                                               [default: "info"]
  -a, --ccu-address                                                   [required]
  -d, --disable-rega                                            [default: false]
  -r, --listen-address                                    [default: "127.0.0.1"]
  -l, --listen-port                                              [default: 2126]
  -b, --binrpc-listen-port                                       [default: 2127]
```

## License

MIT (c) 2017 [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
