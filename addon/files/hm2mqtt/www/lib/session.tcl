#!/bin/tclsh
#
# Session validation and query string handling.
#
# Everything here is written for **Tcl 8.2**, which is what the CCU3 firmware ships (`info
# patchlevel` says 8.2.3, from 1999). That rules out `dict` (8.5), `eq`/`ne` in expressions (8.4),
# `string is` (8.3), `{*}` (8.5) and `file normalize` (8.4) - all of which are fine on OpenCCU and
# fail on a CCU3. Query parameters are therefore passed around as a plain name/value list that the
# caller turns into an array.

load tclrega.so

# Is this a session the CCU WebUI handed out?
proc check_session {sid} {
    if {[regexp {@([0-9a-zA-Z]{10})@} $sid all sidnr]} {
        if {![string equal [lindex [rega_script "Write(system.GetSessionVarStr('$sidnr'));"] 1] ""]} {
            return 1
        }
    }
    return 0
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

# Task 20: the session header of openccu-lite, from the addon handbook's lib/session.tcl (and
# RedMatic's). lighttpd's gate hands every request it lets through under /addons/ the bare id of the
# session it accepted, from the cookie or from ?sid=, as X-Occulite-Session - HTTP_X_OCCULITE_SESSION
# for a CGI - and removes any copy a client sent. With the header the settings page no longer needs
# ?sid=@...@ in its address, and the manifest declares ui.session_header.
#
# The header is no proof by itself: a CCU passes a client's header straight through, and so does an
# openccu-lite image from before it. So it is read on openccu-lite only, and the system is asked about
# it: GET /api/auth/v1/state with the id as Bearer has to answer that very session. An API token (the
# state names no sid for it) is refused. Where the header is there it decides; ?sid=@...@ and the
# ReGa check above stay for a CCU, OpenCCU and openccu-lite images without the header.

# The id in this request's session header, "" when there is none to use.
proc session_header {} {
    global env
    if {![info exists env(HTTP_X_OCCULITE_SESSION)] || ![is_openccu_lite]} {
        return ""
    }
    return $env(HTTP_X_OCCULITE_SESSION)
}

# The system's answer about one session id, "" when it cannot be asked. openccu-lite only (Tcl 8.6).
proc occulite_state {id} {
    if {[catch {package require http}]} {
        return ""
    }
    if {[catch {http::geturl "[occulite_base_url]/api/auth/v1/state" -headers [list Authorization "Bearer $id"] -timeout 5000} token]} {
        return ""
    }
    set body ""
    if {[string equal [http::status $token] "ok"] && [http::ncode $token] == 200} {
        set body [http::data $token]
    }
    http::cleanup $token
    return $body
}

# 1 when the system confirms `id` as one of its live sessions. A value that is not a bare session id
# (a list of several, a line break, @-wrapped) is refused without asking.
proc check_occulite_session {id} {
    if {![regexp {^[A-Za-z0-9]{1,64}$} $id]} {
        return 0
    }
    set state [occulite_state $id]
    # JSON escapes every quote inside a string, so a user name cannot fake a key
    if {![regexp {"authenticated"[ ]*:[ ]*true} $state]} {
        return 0
    }
    if {![regexp {"sid"[ ]*:[ ]*"([A-Za-z0-9]+)"} $state all stateSid] || ![string equal $stateSid $id]} {
        return 0
    }
    return 1
}

# 1 when this request comes with a live session: the session header where openccu-lite sends one,
# otherwise ?sid=@...@ through ReGa (on openccu-lite its tclrega.so shim) as always.
proc request_session_ok {sid} {
    set id [session_header]
    if {![string equal $id ""]} {
        return [check_occulite_session $id]
    }
    return [check_session $sid]
}

# Percent-decoding, written out rather than the usual `regsub`+`subst` one-liner: that idiom runs
# command substitution over its input, so a query string containing [...] would be executed.
proc url_decode {value} {
    set out ""
    set length [string length $value]
    for {set i 0} {$i < $length} {incr i} {
        set char [string index $value $i]
        if {[string equal $char "+"]} {
            append out " "
        } elseif {[string equal $char "%"] && $i + 2 < $length} {
            set hex [string range $value [expr {$i + 1}] [expr {$i + 2}]]
            if {[regexp {^[0-9a-fA-F][0-9a-fA-F]$} $hex]} {
                # scan needs a variable here: returning the value directly is Tcl 8.4 and up
                scan $hex %x code
                append out [format %c $code]
                incr i 2
            } else {
                append out $char
            }
        } else {
            append out $char
        }
    }
    # the bytes just decoded are utf-8; without this an umlaut arrives as two characters
    return [encoding convertfrom utf-8 $out]
}

# Query parameters as a name/value list, decoded: `array set params [query_params]`. The UI builds
# its requests with URLSearchParams, which percent-encodes the `@` of a session id
# (`@1234567890@` -> `%401234567890%40`), so a CGI that skips decoding sees no valid session at all.
proc query_params {} {
    set params [list]
    if {[catch {set query $::env(QUERY_STRING)}]} {
        return $params
    }
    foreach pair [split $query &] {
        if {[regexp {^([^=]*)=(.*)$} $pair dummy name value]} {
            lappend params [url_decode $name] [url_decode $value]
        }
    }
    return $params
}
