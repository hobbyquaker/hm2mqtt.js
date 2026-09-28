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
# the same fallback the rc.d script makes: a confined addon on openccu-lite writes its pid file
# into the run directory its unit created, because /var/run is root's
if {[file isdirectory /run/addon-hm2mqtt]} {
    set PID_FILE /run/addon-hm2mqtt/hm2mqtt.pid
} else {
    set PID_FILE /var/run/hm2mqtt.pid
}
set RC_SCRIPT /usr/local/etc/config/rc.d/hm2mqtt

# the test harness runs the CGIs from a copy of the tree and points these elsewhere
if {[info exists env(HM2MQTT_PID_FILE)]} {
    set PID_FILE $env(HM2MQTT_PID_FILE)
}
if {[info exists env(HM2MQTT_RC_SCRIPT)]} {
    set RC_SCRIPT $env(HM2MQTT_RC_SCRIPT)
}

# openccu-lite: a LITE= line in /VERSION, or occulited - the rule of rc.d/hm2mqtt, RedMatic and the
# addon handbook. Read at every call, never remembered: the same /usr/local may move between a CCU
# and openccu-lite. HM2MQTT_VERSION_FILE and HM2MQTT_OCCULITED let the tests point elsewhere; a
# CGI's environment on a box never carries them (a client's headers arrive as HTTP_*).
proc is_openccu_lite {} {
    global env
    set versionFile /VERSION
    set occulited /usr/bin/occulited
    if {[info exists env(HM2MQTT_VERSION_FILE)]} {
        set versionFile $env(HM2MQTT_VERSION_FILE)
    }
    if {[info exists env(HM2MQTT_OCCULITED)]} {
        set occulited $env(HM2MQTT_OCCULITED)
    }
    if {![catch {open $versionFile r} fp]} {
        set version [read $fp]
        close $fp
        if {[regexp -line {^LITE=} $version]} {
            return 1
        }
    }
    return [file exists $occulited]
}

# Where the system answers: its own lighttpd on the loopback, which proxies /api/ to occulited.
# HM2MQTT_OCCULITE_URL replaces the base for the tests.
proc occulite_base_url {} {
    global env
    set base http://127.0.0.1
    if {[info exists env(HM2MQTT_OCCULITE_URL)]} {
        set base $env(HM2MQTT_OCCULITE_URL)
    }
    regsub {/$} $base "" base
    return $base
}

# Task 17: on openccu-lite hm2mqtt logs to the journal as the unit addon-hm2mqtt, and the settings
# page reads it through the system's log route with the addon's own token - the manifest asks for
# `logs:read` (runtime.api_scopes), and the system writes the token to
# /run/occulite/addon-tokens/hm2mqtt.api at every start. The system's Log page shows the same
# lines with every filter.
set JOURNAL_UNIT addon-hm2mqtt
set LOG_PAGE /system/log?unit=addon-hm2mqtt
set API_TOKEN_FILE /run/occulite/addon-tokens/hm2mqtt.api
if {[info exists env(HM2MQTT_API_TOKEN_FILE)]} {
    set API_TOKEN_FILE $env(HM2MQTT_API_TOKEN_FILE)
}

# The last `count` lines of the unit's journal as text, one entry per line ("<time> <tag>[<pid>]:
# <message>"), or an error: a list {ok text} or {error reason}. openccu-lite only (Tcl 8.6 with
# tcllib there); never called on a CCU, whose Tcl 8.2 has no json package.
proc journal_log {count} {
    global API_TOKEN_FILE JOURNAL_UNIT
    if {[catch {open $API_TOKEN_FILE r} fd]} {
        return [list error "no API token for the addon ($API_TOKEN_FILE)"]
    }
    set token [string trim [read $fd]]
    close $fd
    if {![regexp {^[A-Za-z0-9_.-]+$} $token]} {
        return [list error "no API token for the addon ($API_TOKEN_FILE)"]
    }
    if {[catch {package require http}] || [catch {package require json}]} {
        return [list error "the Tcl packages http and json are missing"]
    }
    set url "[occulite_base_url]/api/system/v1/log?unit=$JOURNAL_UNIT&limit=$count"
    if {[catch {http::geturl $url -headers [list Authorization "Bearer $token"] -timeout 10000} request]} {
        return [list error "the system did not answer ($request)"]
    }
    set status [http::status $request]
    set code [http::ncode $request]
    set body [http::data $request]
    http::cleanup $request
    if {![string equal $status "ok"] || $code != 200} {
        return [list error "the system answered $code"]
    }
    # json2dict's answer is an even list, so `array set` takes it apart without the dict command
    if {[catch {json::json2dict $body} answer] || [catch {array set reply $answer}] || ![info exists reply(lines)]} {
        return [list error "the system's answer could not be read"]
    }
    set out [list]
    foreach line $reply(lines) {
        catch {unset entry}
        if {[catch {array set entry $line}]} {
            continue
        }
        set text ""
        if {[info exists entry(time)]} {
            append text "$entry(time) "
        }
        if {[info exists entry(tag)]} {
            append text $entry(tag)
        }
        if {[info exists entry(pid)]} {
            append text "\[$entry(pid)\]"
        }
        if {[info exists entry(message)]} {
            append text ": $entry(message)"
        }
        lappend out $text
    }
    if {[info exists reply(error)]} {
        return [list error "the system could not read the journal ($reply(error))"]
    }
    return [list ok [join $out "\n"]]
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
