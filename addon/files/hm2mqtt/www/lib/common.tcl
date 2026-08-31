#!/bin/tclsh
#
# Shared bits for the addon's CGIs: session check, query parsing, minimal JSON output and the
# paths of the addon. Sourced with an absolute path, so it does not matter what the web server
# picks as working directory.

source [file join [file dirname [file normalize [info script]]] session.tcl]

# www/lib/common.tcl -> www -> the addon directory
set ADDON_DIR [file dirname [file dirname [file dirname [file normalize [info script]]]]]
set ENV_FILE $ADDON_DIR/etc/hm2mqtt.env
set LOG_FILE $ADDON_DIR/var/hm2mqtt.log
set PID_FILE /var/run/hm2mqtt.pid
set RC_SCRIPT /usr/local/etc/config/rc.d/hm2mqtt

# the test harness runs the CGIs from a copy of the tree and points these elsewhere
if {[info exists env(HM2MQTT_PID_FILE)]} {set PID_FILE $env(HM2MQTT_PID_FILE)}
if {[info exists env(HM2MQTT_RC_SCRIPT)]} {set RC_SCRIPT $env(HM2MQTT_RC_SCRIPT)}

# Answers with a JSON error and exits unless the request carries a valid WebUI session.
proc require_session {} {
    set params [query_params]
    set sid ""
    if {[dict exists $params sid]} {
        set sid [dict get $params sid]
    }
    if {![check_session $sid]} {
        puts "Content-Type: application/json; charset=utf-8\r\n"
        puts "{\"error\":\"invalid session\"}"
        exit 1
    }
    return $params
}

proc json_header {} {
    puts "Content-Type: application/json; charset=utf-8\r\n"
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

# Percent-decoding for values that arrive in a query string.
proc url_decode {value} {
    set value [string map {+ " "} $value]
    regsub -all {%([0-9a-fA-F]{2})} $value {[format %c 0x\1]} value
    return [subst -novariables -nobackslashes $value]
}
