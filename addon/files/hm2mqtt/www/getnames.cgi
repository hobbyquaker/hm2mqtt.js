#!/bin/tclsh
#
# The name file as it is on disk. Missing file is not an error - it simply has no names yet.

source [file join [file dirname [file normalize [info script]]] lib common.tcl]

require_session
puts "Content-Type: application/json; charset=utf-8\r\n"

set file $ADDON_DIR/etc/names.json
if {[file exists $file]} {
    set fd [open $file r]
    fconfigure $fd -encoding utf-8
    puts -nonewline [read $fd]
    close $fd
} else {
    puts -nonewline "\{\}"
}
