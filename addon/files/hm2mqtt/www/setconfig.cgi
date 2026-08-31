#!/bin/tclsh
#
# Writes the configuration. The body is the env file as the UI assembled it, one KEY=value per
# line; every line is validated before anything is written, and a password sent back unchanged as
# the placeholder keeps its stored value. Nothing outside etc/hm2mqtt.env is touched.

source [file join [file dirname [file normalize [info script]]] lib common.tcl]

require_session
json_header

set body [read stdin]

# what is stored today, to restore masked secrets
set current [dict create]
if {[file exists $ENV_FILE]} {
    set fd [open $ENV_FILE r]
    foreach line [split [read $fd] "\n"] {
        if {[regexp {^([A-Za-z_][A-Za-z0-9_]*)=(.*)$} [string trim $line] dummy key value]} {
            dict set current $key $value
        }
    }
    close $fd
}

set out {}
set count 0
foreach line [split $body "\n"] {
    set line [string trimright $line "\r"]
    set trimmed [string trim $line]
    if {$trimmed eq "" || [string index $trimmed 0] eq "#"} {
        lappend out $line
        continue
    }
    if {![regexp {^(HM2MQTT_[A-Z0-9_]+)=(.*)$} $trimmed dummy key value]} {
        puts "{\"error\":[json_string "refusing to write invalid line: $trimmed"]}"
        exit 1
    }
    if {$value eq "********" && [dict exists $current $key]} {
        set value [dict get $current $key]
    }
    lappend out "$key=$value"
    incr count
}

file mkdir [file dirname $ENV_FILE]
set fd [open $ENV_FILE w]
puts $fd [join $out "\n"]
close $fd
exec /bin/sync

puts "{\"ok\":true,\"written\":$count}"
