# AIS Plus Audio

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

AIS Plus Audio is the planned standalone audio renderer for AIS Plus announcements.

It will replace the older `announce-ais-messages` and standalone Lubuntu speaker paths by rendering each AIS Plus announcement once on the Signal K server:

```text
AIS Plus announcement event
  -> Piper speech
  -> stereo directional ping
  -> stereo browser-friendly audio file
  -> local Pi playback, Companion playback, and/or native radio player stream
```

## Current State

Version `0.3.4` renders Piper WAV announcements, prepends the stereo directional ping, creates a browser-friendly MP3, serves generated files from the plugin router, can play the combined WAV locally on the Signal K server, and exposes a continuous radio-style MP3 stream for native player apps.

Volume settings are shown as percentages in the Signal K configuration page. Existing pre-`0.2.2` gain settings are migrated automatically, so an old value of `1` becomes `100%`. Paths beginning with `~` are expanded for Piper, FFmpeg, audio player, voice, and generated-audio paths.

The radio stream is intended for iPhone/iPad/Android apps that can keep a stream alive while the device is locked.

## Install

```sh
cd ~/.signalk
npm install git+ssh://git@ssh.github.com:443/mcdonaldajr/signalk-ais-plus-audio.git#v0.3.4 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Open **AIS Plus Audio** from the Signal K webapps page.

## Radio Stream

The radio stream is the best iPhone/iPad option when the screen may be locked. Browser and PWA audio normally stops when iOS suspends the page, but a native radio player can keep an already-open stream alive in the background.

Use this local stream URL in a radio player app:

```text
https://nemo3.local:3445/live.mp3
```

Station name:

```text
AIS Plus Audio
```

Some apps prefer an M3U playlist:

```text
https://nemo3.local:3445/live.m3u
```

The local stream port serves only the generated audio stream, so native radio player apps do not need a Signal K login cookie. It uses the same `ssl-cert.pem` and `ssl-key.pem` as Signal K when they are available. The stream sends silence between announcements and writes each rendered AIS Plus announcement into the stream as it is produced.

### iPhone/iPad Setup

1. Install a radio stream player app.
2. Add a custom station using `https://nemo3.local:3445/live.mp3`.
3. Name it `AIS Plus Audio`.
4. Start the station while connected to the boat Wi-Fi.
5. Trigger **Sound check** in the AIS Plus Audio webapp.
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

AIS Plus Audio treats the radio stream as live audio, not as a podcast queue. If a player falls too far behind, the server closes that stream instead of writing a fresh announcement behind old buffered silence. The player should then reconnect and resume from the current live stream.

The lag limit is configurable as **Maximum stream lag before reconnect (seconds)** and defaults to 30 seconds.

Use **Restart streams** in the AIS Plus Audio webapp to test whether a radio app reconnects automatically after the stream is deliberately closed. If it does not reconnect, start the station manually again in the radio app.

This traffic should stay on the local boat LAN when the stream URL uses the local hostname `nemo3.local`. It should not use the boat router's cellular data unless the phone is no longer on the boat Wi-Fi, the hostname is being resolved through a remote/VPN route, or the router is configured to hairpin local traffic through an internet service.

For normal use, keep the phone on the boat Wi-Fi and use the local `.local` address. Do not publish or port-forward the stream port to the internet.

## Responsibilities

- AIS Plus decides whether an announcement is required.
- AIS Plus Audio renders and serves the audio.
- AIS Plus Companion can play the rendered audio while open.
- A native radio player can play the live stream while the phone or tablet is locked.

## Notes

- Requires Piper and FFmpeg on the Signal K server.
- Generated audio must be treated as time-limited; stale collision warnings should not auto-play.
- The Pi remains the only place that needs Piper installed.
