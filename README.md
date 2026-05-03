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

Version `0.2.3` renders Piper WAV announcements, prepends the stereo directional ping, creates a browser-friendly MP3, serves generated files from the plugin router, and can play the combined WAV locally on the Signal K server.

Volume settings are shown as percentages in the Signal K configuration page. Existing pre-`0.2.2` gain settings are migrated automatically, so an old value of `1` becomes `100%`. Paths beginning with `~` are expanded for Piper, FFmpeg, audio player, voice, and generated-audio paths.

The next implementation step is updating AIS Plus Companion to subscribe to the rendered announcement output and play these MP3 files on iPhone, iPad, Android, and desktop browsers.

## Install

```sh
cd ~/.signalk
npm install git+ssh://git@ssh.github.com:443/mcdonaldajr/signalk-ais-plus-audio.git#v0.2.3 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Open **AIS Plus Audio** from the Signal K webapps page.

## Responsibilities

- AIS Plus decides whether an announcement is required.
- AIS Plus Audio renders and serves the audio.
- AIS Plus Companion plays the rendered audio on iPhone, iPad, Android, or desktop browsers.

## Notes

- Requires Piper and FFmpeg on the Signal K server.
- Generated audio must be treated as time-limited; stale collision warnings should not auto-play.
- The Pi remains the only place that needs Piper installed.
