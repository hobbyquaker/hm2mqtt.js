#!/bin/tclsh
#
# Writes the configuration. The body is the env file as the UI assembled it, one KEY=value per line;
# every line is validated before anything is written, and a password sent back as the placeholder
# keeps its stored value. Nothing outside etc/hm2mqtt.env is touched.

source [file join [file dirname [info script]] lib common.tcl]

require_session
json_header

set body [read stdin]

# what is stored today, to restore masked secrets
array set current {}
if {[file exists $ENV_FILE]} {
    set fd [open $ENV_FILE r]
    set content [read $fd]
    close $fd
    foreach line [split $content "\n"] {
        if {[regexp {^([A-Za-z_][A-Za-z0-9_]*)=(.*)$} [string trim $line] dummy key value]} {
            set current($key) $value
        }
    }
}

set out [list]
set count 0
foreach line [split $body "\n"] {
    set line [string trimright $line "\r"]
    set trimmed [string trim $line]
    if {[string equal $trimmed ""] || [string equal [string index $trimmed 0] "#"]} {
        lappend out $line
        continue
    }
    if {![regexp {^(HM2MQTT_[A-Z0-9_]+)=(.*)$} $trimmed dummy key value]} {
        puts "{\"error\":[json_string "refusing to write invalid line: $trimmed"]}"
        exit 1
    }
    if {[string equal $value "********"] && [info exists current($key)]} {
        set value $current($key)
    }
    lappend out "$key=$value"
    incr count
}

set fd [open $ENV_FILE w]
puts $fd [join $out "\n"]
close $fd
catch {exec /bin/sync}

puts "{\"ok\":true,\"written\":$count}"
