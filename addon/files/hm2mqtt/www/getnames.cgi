#!/bin/tclsh
#
# The name file as it is on disk. A missing file is not an error - there are simply no names yet.

source [file join [file dirname [info script]] lib common.tcl]

require_session
puts "Content-Type: application/json; charset=utf-8\r\n"

if {[file exists $NAMES_FILE]} {
    set fd [open $NAMES_FILE r]
    catch {fconfigure $fd -encoding utf-8}
    puts -nonewline [read $fd]
    close $fd
} else {
    puts -nonewline "\{\}"
}
