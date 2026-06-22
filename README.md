# Watchkeeper Audio

## Version 2 baseline

`v2.3.9` lets Watchkeeper Console host browser announcement playback from its
root window. When Audio is embedded by Console it still shows and saves browser
output settings, but suppresses its own iframe playback to avoid double speech.
Opened directly, Watchkeeper Audio remains fully standalone.

`v2.3.8` makes Audio mute authority explicit: only Watchkeeper Audio's manual
mute and Traffic Core's Audio Policy can mute playback. Provider
`delivery.muteState` flags are ignored by Audio.

`v2.3.7` removes old AIS Plus wording from visible Audio status and
configuration labels.

`v2.3.6` replaces the browser playback checkbox with an explicit browser output
mode: Off, browser speech synthesis, or Watchkeeper Piper playback. Pi speaker,
radio stream, and mute remain independent switches.

`v2.3.5` keeps Watchkeeper Audio as the browser-audio authority on each device
so the older simple browser speech setting cannot clash with Piper browser
playback.

`v2.3.4` deduplicates repeated Notifications Plus audio requests by request ID
and prevents the webapp from autoplaying an old last announcement when the
Watchkeeper Audio tab is reopened from Console.

`v2.3.3` completes the public webapp naming pass: visible labels now say
Watchkeeper Audio, and the main page no longer presents Piper as the app name.

`v2.0.0` promotes the current Notifications Plus renderer, Pi speaker pipeline,
and live-stream implementation as the working audio baseline. It does not yet
implement the proposed authoritative synchronized playback contract and does
not intentionally change runtime behavior from `v1.4.7`.

`v2.1.0` carries rendered authenticated/public asset URLs in the authoritative
timeline as soon as MP3 rendering completes. Pi speaker playback remains on
the fastest WAV-ready path and is never delayed for Companion.

`v2.2.0` observes the versioned Traffic Core Audio Policy projection.
Engine mute and stationary automute are enforced only when that projection is
explicitly authoritative in Engine mode. Shadow policy remains observable but
cannot mute Audio. Session changes reset sequence tracking and stale or
non-monotonic policy updates are ignored.

`v2.3.1` suppressed repeated no-op provider-mute queue-clear events; provider
mute flags are ignored entirely by Audio from `v2.3.8`.

`v2.3.0` restores output routing controls in the Watchkeeper Audio webapp. Browser
playback is a local per-device setting, while Pi speaker output, radio stream
output, and mute-all are saved on the Signal K server as Audio-owned settings.

`v2.0.1` added a session-scoped playback lifecycle timeline for observation and
measurement. Existing Pi, stream, and browser playback behavior is unchanged.

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

Watchkeeper Audio is the standalone renderer for notification audio-delivery events.

It replaces the older `announce-ais-messages` and standalone Lubuntu speaker paths by rendering each announcement once on the Signal K server:

```text
Standards-compatible Signal K notification
  -> Notifications Plus audio projection
  -> Piper speech
  -> stereo directional ping
  -> stereo browser-friendly audio file
  -> local Pi playback, Companion playback, and/or native radio player stream
```

## Current State

Version `1.4.7` consumes the Notifications Plus audio projection. This gives all providers common priority ordering, subject supersession, freshness, and output instructions without Audio interpreting message content. It creates Piper WAV speech, can prepend the stereo directional ping, creates a browser-friendly MP3, serves generated files from the plugin router, publishes read-only status at `vessels.self.plugins.aisPlusAudio`, can play the combined WAV locally on the Signal K server, and exposes generated files plus a continuous radio-style MP3 stream on the public stream port for read-only clients.

The status projection also carries an additive
`plugins.aisPlusAudio.timeline` contract with an Audio `sessionId`, monotonic
`sequence`, broker `requestId`, provider `correlationId`, playback identity, and
accepted/queued/synthesis/audio-ready/speaker lifecycle events. Existing
playback behavior is unchanged; Companion should observe and measure this
timeline before using it as its playback authority.

Local speaker playback starts as soon as Piper speech and the combined WAV are ready. MP3 encoding and live-stream publication proceed alongside speaker playback instead of delaying it. Recent events and the published status include provider, receipt, queue, processing, synthesis, WAV-ready, speaker-start, speaker-finish, and MP3 timestamps so a slow provider, queue backlog, Piper, ALSA, or stream stage can be identified directly.

Version `1.4.2` also pre-renders one queued announcement while the current announcement is playing. The prepared WAV starts as soon as the speaker becomes free, while superseded, muted, or expired prepared announcements are still discarded before playback.

Version `1.4.3` adds local-speaker priority pre-emption. Once a higher-priority prepared notification is ready, it interrupts a lower-priority announcement currently playing and takes the speaker. Equal-priority announcements remain sequential. The event log records both the interrupted and interrupting messages.

Version `1.4.4` restarts an interrupted lower-priority announcement from the beginning after the urgent announcement, but only when its stable broker subject remains active and it is still fresh, audible, and unsuperseded.

Version `1.4.5` follows the provider's explicit `delivery.preempt` instruction. Routine informational announcements may be queued and pre-rendered but cannot interrupt any message already using the speaker.

Version `1.4.6` closes a preparation race: when a higher-priority event arrives while Piper is synthesizing a lower-priority event, the completed lower-priority WAV must rejoin the queue instead of claiming the speaker ahead of the newer urgent event.

Version `1.4.7` keeps the local speaker reserved for 500 ms after `aplay` exits. This protects the final buffered words before the next queued announcement starts. The gap is configurable in the plugin settings.

Volume settings are shown as percentages in the Signal K configuration page. Existing pre-`0.2.2` gain settings are migrated automatically, so an old value of `1` becomes `100%`. The local speaker level setting uses a logarithmic curve and applies the matching ALSA mixer volume at Watchkeeper Audio startup and before local `aplay` playback. Level `0%` maps to `66%` on the mixer, level `100%` maps to `100%`, and old linear mixer-volume settings are migrated onto the new curve. It tries the configured mixer control first, then common Pi/ALSA controls such as `PCM`, `Master`, `Headphone`, and `Speaker`. Paths beginning with `~` are expanded for Piper, FFmpeg, audio player, voice, and generated-audio paths.

The radio stream is intended for iPhone/iPad/Android apps that can keep a stream alive while the device is locked.

## Install

```sh
cd ~/.signalk
npm install git+ssh://git@ssh.github.com:443/mcdonaldajr/signalk-ais-plus-audio.git#v2.3.9 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Open **Watchkeeper Audio** from the Signal K webapps page.

The **Enable directional ping** checkbox in the Watchkeeper Audio webapp can switch the ping on or off immediately while Signal K is running. The **Local speaker level** slider sets and saves the logarithmic default level for local `aplay` output, with its minimum mapped to `66%` mixer volume. The Signal K plugin configuration still provides the startup defaults and ping volume/frequency settings.

## Radio Stream

The radio stream is the best iPhone/iPad option when the screen may be locked. Browser and PWA audio normally stops when iOS suspends the page, but a native radio player can keep an already-open stream alive in the background.

Use this local stream URL in a radio player app:

```text
https://nemo3.local:3445/live.mp3
```

Station name:

```text
Watchkeeper Audio
```

Some apps prefer an M3U playlist:

```text
https://nemo3.local:3445/live.m3u
```

The local stream port serves only the generated audio stream, so native radio player apps do not need a Signal K login cookie. It uses the same `ssl-cert.pem` and `ssl-key.pem` as Signal K when they are available. The stream sends silence between announcements and writes each rendered Watchkeeper announcement into the stream as it is produced.

### iPhone/iPad Setup

1. Install a radio stream player app.
2. Add a custom station using `https://nemo3.local:3445/live.mp3`.
3. Name it `Watchkeeper Audio`.
4. Start the station while connected to the boat Wi-Fi.
5. Trigger **Sound check** in the Watchkeeper Audio webapp.
6. Lock the phone and trigger another **Sound check** to confirm background playback.

If the app asks for a playlist rather than a direct stream, use `https://nemo3.local:3445/live.m3u`.

### Network Use

The stream is unicast, not broadcast. Each connected radio app opens one direct TCP/TLS connection to the Pi. It is therefore limited to the network path between that device and the Pi when the device is connected to the boat Wi-Fi.

At the default 64 kbit/s MP3 stream rate, allow roughly:

```text
8 KB/s per connected player
29 MB/hour per connected player
700 MB/day per connected player if left running continuously
```

The bitrate is configurable in the Signal K plugin settings as **MP3 stream bitrate (kbit/s)**.

### Stream Lag Guard

Watchkeeper Audio treats the radio stream as live audio, not as a podcast queue. If a player falls too far behind, the server closes that stream instead of writing a fresh announcement behind old buffered silence. The player should then reconnect and resume from the current live stream.

The lag limit is configurable as **Maximum stream lag before reconnect (seconds)** and defaults to 30 seconds.

Use **Restart streams** in the Watchkeeper Audio webapp to test whether a radio app reconnects automatically after the stream is deliberately closed. If it does not reconnect, start the station manually again in the radio app.

### Stream Time Check

Enable **Announce time on live stream** to periodically speak the Signal K server time into the radio stream. This is a practical drift test: if the announcement says a time that is several minutes behind the actual time, the player has built up too much buffer delay.

The interval is configurable as **Live stream time-check interval (minutes)**. The manual **Stream time check** button sends one time announcement immediately. Time checks are stream-only and are not played on the Pi speaker. The webapp displays the current server time so the spoken time can be compared with the Pi clock.

### Stream Diagnostics

The Watchkeeper Audio webapp shows current stream clients, total connects/disconnects, client uptime, server-side write buffer size, and the last disconnect reason. The stream also sends basic ICY radio headers (`icy-name`, `icy-genre`, `icy-br`) so native radio players can recognise it as a radio-style stream.

This traffic should stay on the local boat LAN when the stream URL uses the local hostname `nemo3.local`. It should not use the boat router's cellular data unless the phone is no longer on the boat Wi-Fi, the hostname is being resolved through a remote/VPN route, or the router is configured to hairpin local traffic through an internet service.

For normal use, keep the phone on the boat Wi-Fi and use the local `.local` address. Do not publish or port-forward the stream port to the internet.

## Responsibilities

- Providers decide notification meaning and publish standard Signal K notifications.
- Notifications Plus applies priority, lifecycle, supersession, history, and delivery mechanics.
- Watchkeeper Audio renders the broker's audio projection without classifying content.
- Watchkeeper Companion can play the rendered audio while open.
- A native radio player can play the live stream while the phone or tablet is locked.

## Queue Behaviour

Watchkeeper Audio keeps the current speaker announcement uninterrupted. When a new vessel announcement is queued, any older queued announcements for the same vessel are dropped before the new one is added. This keeps busy-area speech focused on the latest known state, including de-escalations from collision alarm back to advisory.

When Watchkeeper Audio is manually muted or Traffic Core Audio Policy is muted,
Watchkeeper Audio suppresses further non-forced announcements until sounds are
enabled again. It does not interrupt an announcement already playing on the local
speaker.

## Notes

- Requires Piper and FFmpeg on the Signal K server.
- Generated audio must be treated as time-limited; stale collision warnings should not auto-play.
- The Pi remains the only place that needs Piper installed.
