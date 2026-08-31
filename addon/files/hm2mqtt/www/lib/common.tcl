#!/bin/tclsh
#
# Shared bits for the addon's CGIs: paths, the session gate and minimal JSON output. Tcl 8.2, see
# lib/session.tcl.

source [file join [file dirname [info script]] session.tcl]

# www/lib/common.tcl -> www -> the addon directory
set ADDON_DIR [file dirname [file dirname [file dirname [info script]]]]
set ENV_FILE $ADDON_DIR/etc/hm2mqtt.env
set NAMES_FILE $ADDON_DIR/etc/names.json
set LOG_FILE $ADDON_DIR/var/hm2mqtt.log
set PID_FILE /var/run/hm2mqtt.pid
set RC_SCRIPT /usr/local/etc/config/rc.d/hm2mqtt

# the test harness runs the CGIs from a copy of the tree and points these elsewhere
if {[info exists env(HM2MQTT_PID_FILE)]} {
    set PID_FILE $env(HM2MQTT_PID_FILE)
}
if {[info exists env(HM2MQTT_RC_SCRIPT)]} {
    set RC_SCRIPT $env(HM2MQTT_RC_SCRIPT)
}

proc json_header {} {
    puts "Content-Type: application/json; charset=utf-8\r\n"
}

# Answers with a JSON error and exits unless the request carries a valid WebUI session. Returns the
# query parameters as a name/value list.
proc require_session {} {
    set params [query_params]
    array set query $params
    set sid ""
    if {[info exists query(sid)]} {
        set sid $query(sid)
    }
    if {![check_session $sid]} {
        json_header
        puts "{\"error\":\"invalid session\"}"
        exit 1
    }
    return $params
}

proc json_string {value} {
    set out ""
    foreach char [split $value ""] {
        scan $char %c code
        switch -- $char {
            "\"" {append out {\"}}
            "\\" {append out {\\}}
            "\n" {append out {\n}}
            "\r" {append out {\r}}
            "\t" {append out {\t}}
            default {
                if {$code < 32} {
                    append out [format {\u%04x} $code]
                } else {
                    append out $char
                }
            }
        }
    }
    return "\"$out\""
}
