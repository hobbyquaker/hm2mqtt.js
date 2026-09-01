#!/bin/tclsh
#
# Shared bits for the addon's CGIs: paths, the session gate and minimal JSON output. Tcl 8.2, see
# lib/session.tcl.

source [file join [file dirname [info script]] session.tcl]

# Where the addon lives. Deliberately not derived from [info script]: the WebUI reaches these CGIs
# through /usr/local/etc/config/addons/www/hm2mqtt, a symlink to this directory, so the script path
# walks up into the symlink's parent and lands somewhere else entirely. `file normalize` used to
# hide that by resolving the link, and it needs Tcl 8.4 - the CCU3 has 8.2.3. A CCU addon's install
# path is fixed by the installer, so it is simply known. HM2MQTT_ADDON_DIR lets the tests run the
# CGIs from a temporary copy.
set ADDON_DIR /usr/local/addons/hm2mqtt
if {[info exists env(HM2MQTT_ADDON_DIR)]} {
    set ADDON_DIR $env(HM2MQTT_ADDON_DIR)
}

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

# The env file is sourced by the shell (rc.d), so values with shell characters are stored
# single-quoted. These two are the write and read side of exactly that quoting.
proc env_quote {value} {
    if {[regexp {^[A-Za-z0-9_./:@%+,=-]*$} $value]} {
        return $value
    }
    return "'[join [split $value {'}] {'\''}]'"
}

proc env_unquote {value} {
    if {![string equal [string index $value 0] "'"] || ![string equal [string index $value end] "'"]} {
        return $value
    }
    set inner [string range $value 1 end-1]
    set out ""
    set i 0
    set n [string length $inner]
    while {$i < $n} {
        if {[string equal [string range $inner $i [expr {$i + 3}]] {'\''}]} {
            append out "'"
            incr i 4
        } else {
            append out [string index $inner $i]
            incr i
        }
    }
    return $out
}

# The env file as a name/value list, quoting undone: `array set config [read_env_file $ENV_FILE]`.
proc read_env_file {path} {
    set result [list]
    if {![file exists $path]} {
        return $result
    }
    set fd [open $path r]
    set content [read $fd]
    close $fd
    foreach line [split $content "\n"] {
        set line [string trim $line]
        if {[string equal $line ""] || [string equal [string index $line 0] "#"]} {
            continue
        }
        if {[regexp {^([A-Za-z_][A-Za-z0-9_]*)=(.*)$} $line dummy key value]} {
            lappend result $key [env_unquote $value]
        }
    }
    return $result
}

# The versions file (VERSION_ADDON, NODE_VERSION, NODE_ICU_DATA, ...) as a name/value list -
# the one parser for the file that build.sh writes and the rc.d script sources.
proc read_versions {} {
    global ADDON_DIR
    set result [list]
    if {![file exists $ADDON_DIR/versions]} {
        return $result
    }
    set fd [open $ADDON_DIR/versions r]
    set content [read $fd]
    close $fd
    foreach line [split $content "\n"] {
        if {[regexp {^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$} [string trim $line] dummy key value]} {
            lappend result $key $value
        }
    }
    return $result
}

# ICU keeps its data outside the bundled node's libraries (musl build); without ICU_DATA in the
# environment the node in bin/ does not start. Call before any exec of it.
proc node_env {} {
    global env
    set env(ICU_DATA) ""
    foreach {key value} [read_versions] {
        if {[string equal $key "NODE_ICU_DATA"]} {
            set env(ICU_DATA) $value
        }
    }
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
