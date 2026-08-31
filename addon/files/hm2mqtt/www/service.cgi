#!/bin/tclsh
#
# Service control and status for the UI: ?cmd=start|stop|restart|status.

source [file join [file dirname [file normalize [info script]]] lib common.tcl]

set params [require_session]
json_header

set cmd "status"
if {[dict exists $params cmd]} {
    set cmd [dict get $params cmd]
}

proc pid_of {} {
    if {![file exists $::PID_FILE]} {
        return ""
    }
    set fd [open $::PID_FILE r]
    set pid [string trim [read $fd]]
    close $fd
    if {$pid eq "" || [catch {exec kill -0 $pid}]} {
        return ""
    }
    return $pid
}

proc versions {} {
    set result [dict create]
    if {[file exists $::ADDON_DIR/versions]} {
        set fd [open $::ADDON_DIR/versions r]
        foreach line [split [read $fd] "\n"] {
            if {[regexp {^([A-Z_]+)=(.*)$} [string trim $line] dummy key value]} {
                dict set result $key $value
            }
        }
        close $fd
    }
    return $result
}

switch -- $cmd {
    start - stop - restart {
        catch {exec $RC_SCRIPT $cmd} output
        set pid [pid_of]
        puts "{\"ok\":true,\"cmd\":[json_string $cmd],\"output\":[json_string $output],\"running\":[expr {$pid ne "" ? "true" : "false"}]}"
    }
    status {
        set pid [pid_of]
        set rss 0
        set elapsed ""
        if {$pid ne ""} {
            catch {set rss [lindex [exec ps -o rss= -p $pid] 0]}
            catch {set elapsed [string trim [exec ps -o etime= -p $pid]]}
        }
        set v [versions]
        set parts {}
        lappend parts "\"running\":[expr {$pid ne "" ? "true" : "false"}]"
        lappend parts "\"pid\":[json_string $pid]"
        lappend parts "\"rss\":[json_string $rss]"
        lappend parts "\"uptime\":[json_string $elapsed]"
        dict for {key value} $v {
            lappend parts "[json_string $key]:[json_string $value]"
        }
        puts "\{[join $parts ,]\}"
    }
    default {
        puts "{\"error\":\"unknown command\"}"
        exit 1
    }
}
