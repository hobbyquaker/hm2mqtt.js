#!/bin/tclsh
#
# Current configuration as JSON, in file order. Secrets are never sent to the browser - the UI only
# learns that one is set and leaves the placeholder alone unless the user types a new value.

source [file join [file dirname [info script]] lib common.tcl]

require_session
json_header

set parts [list]
if {[file exists $ENV_FILE]} {
    set fd [open $ENV_FILE r]
    set content [read $fd]
    close $fd
    foreach line [split $content "\n"] {
        set line [string trim $line]
        if {[string equal $line ""] || [string equal [string index $line 0] "#"]} {
            continue
        }
        if {[regexp {^([A-Za-z_][A-Za-z0-9_]*)=(.*)$} $line dummy key value]} {
            if {[string match "*PASSWORD*" $key] && ![string equal $value ""]} {
                set value "********"
            }
            lappend parts "[json_string $key]:[json_string $value]"
        }
    }
}
puts "\{[join $parts ,]\}"
