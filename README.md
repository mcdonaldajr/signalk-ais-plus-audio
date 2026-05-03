# AIS Plus Audio

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

AIS Plus Audio is the planned standalone audio renderer for AIS Plus announcements.

It will replace the older `announce-ais-messages` and standalone Lubuntu speaker paths by rendering each AIS Plus announcement once on the Signal K server:

```text
AIS Plus announcement event
  -> Piper speech
  -> stereo directional ping
  -> stereo browser-friendly audio file
  -> local Pi playback and/or Companion playback
```

## Current State

Version `0.1.0` is the architecture scaffold. It subscribes to AIS Plus `notifications.collision.*` sound notifications, queues announcement events, exposes a status page, and writes placeholder render metadata to the configured audio directory.

The next implementation step is replacing the placeholder renderer with Piper WAV generation, stereo ping mixing, MP3 output, and announcement URLs for AIS Plus Companion.

## Install

```sh
cd ~/.signalk
npm install git+ssh://git@ssh.github.com:443/mcdonaldajr/signalk-ais-plus-audio.git#v0.1.0 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Open **AIS Plus Audio** from the Signal K webapps page.

## Responsibilities

- AIS Plus decides whether an announcement is required.
- AIS Plus Audio renders and serves the audio.
- AIS Plus Companion plays the rendered audio on iPhone, iPad, Android, or desktop browsers.

## Notes

- Keep this plugin disabled until the renderer is complete.
- Generated audio must be treated as time-limited; stale collision warnings should not auto-play.
- The Pi remains the only place that needs Piper installed.
