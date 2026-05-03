const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const packageInfo = require("../package.json");

const PLUGIN_ID = "signalk-ais-plus-audio";
const DEFAULT_AUDIO_DIR = "~/.signalk/ais-plus-audio";

module.exports = function aisPlusAudio(app) {
  const plugin = {};
  let options = {};
  let unsubscribes = [];
  let queue = [];
  let active = null;
  let lastAnnouncement = null;
  let recentEvents = [];
  let liveSilenceTimer = null;
  let liveSilenceFile = null;
  let liveStreamPauseUntil = 0;
  let publicStreamServer = null;
  let publicStreamIsHttps = false;
  let streamHealthTimer = null;
  let lastRealAnnouncementAt = 0;
  let lastStreamHealthAt = 0;
  const liveStreamClients = new Set();
  let droppedLaggingClients = 0;
  let stats = {
    received: 0,
    queued: 0,
    filtered: 0,
    rendered: 0,
    failed: 0,
  };

  plugin.id = PLUGIN_ID;
  plugin.name = "AIS Plus Audio";
  plugin.description =
    "Renders AIS Plus announcement events into Piper audio for local speaker and browser clients.";

  plugin.start = (pluginOptions = {}) => {
    options = normalizeOptions(pluginOptions);
    ensureAudioDirectory();
    startPublicStreamServer();
    startStreamHealthTimer();
    subscribeToAisPlusAnnouncements();
    app.setPluginStatus(`Started v${packageInfo.version}`);
  };

  plugin.stop = () => {
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch (error) {
        app.debug(`[${PLUGIN_ID}] unsubscribe failed: ${error.message}`);
      }
    }
    unsubscribes = [];
    queue = [];
    active = null;
    stopLiveStreamSilence();
    for (const client of Array.from(liveStreamClients)) {
      closeLiveStreamClient(client);
    }
    stopPublicStreamServer();
    stopStreamHealthTimer();
  };

  plugin.schema = {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enable AIS Plus audio rendering",
        default: true,
      },
      muted: {
        type: "boolean",
        title: "Mute all audio output",
        default: false,
      },
      localPlayback: {
        type: "boolean",
        title: "Play rendered audio on this Signal K server",
        description:
          "When enabled, the Pi will play the same rendered announcement audio that browser clients can fetch.",
        default: true,
      },
      liveStream: {
        type: "boolean",
        title: "Enable radio-style MP3 stream",
        description:
          "Serves a continuous stream for radio player apps that can keep playing while a phone is locked.",
        default: true,
      },
      publicHttpStream: {
        type: "boolean",
        title: "Enable local stream port",
        description:
          "Serves only the live audio stream on a separate local port, so native radio apps do not need a Signal K login.",
        default: true,
      },
      publicHttpStreamPort: {
        type: "integer",
        title: "Local stream port",
        default: 3445,
        minimum: 1024,
        maximum: 65535,
      },
      publicStreamUseHttps: {
        type: "boolean",
        title: "Use HTTPS for local stream port",
        description:
          "Uses Signal K ssl-cert.pem and ssl-key.pem from the server config directory. Recommended for iPhone/iPad.",
        default: true,
      },
      piperBinary: {
        type: "string",
        title: "Piper executable",
        default: "piper",
      },
      ffmpegBinary: {
        type: "string",
        title: "FFmpeg executable",
        description: "Used to combine the stereo ping and Piper speech into browser-friendly MP3.",
        default: "ffmpeg",
      },
      audioPlayer: {
        type: "string",
        title: "Local audio player",
        description: "Usually aplay on Raspberry Pi OS.",
        default: "aplay",
      },
      voicesDir: {
        type: "string",
        title: "Piper voices directory",
        default: "~/piper-voices",
      },
      voice: {
        type: "string",
        title: "Piper voice model",
        description: "The .onnx filename or voice id to use.",
        default: "en_GB-alan-medium",
      },
      audioDirectory: {
        type: "string",
        title: "Generated audio directory",
        default: DEFAULT_AUDIO_DIR,
      },
      maxAudioFiles: {
        type: "integer",
        title: "Maximum generated audio files to keep",
        default: 30,
        minimum: 1,
        maximum: 200,
      },
      maxQueueLength: {
        type: "integer",
        title: "Maximum announcement queue length",
        default: 10,
        minimum: 1,
        maximum: 100,
      },
      mp3BitrateKbps: {
        type: "integer",
        title: "MP3 stream bitrate (kbit/s)",
        description:
          "Lower values reduce Wi-Fi traffic. 64 kbit/s is usually enough for spoken alerts and the directional ping.",
        default: 64,
        minimum: 32,
        maximum: 192,
      },
      maxStreamLagSeconds: {
        type: "integer",
        title: "Maximum stream lag before reconnect (seconds)",
        description:
          "If a radio player falls this far behind, AIS Plus Audio closes that stream instead of queuing stale announcements behind old silence.",
        default: 30,
        minimum: 5,
        maximum: 300,
      },
      streamHealthTimeCheck: {
        type: "boolean",
        title: "Announce time on live stream",
        description:
          "Periodically speaks the server time to the live stream so you can detect player buffering drift.",
        default: false,
      },
      streamHealthIntervalMinutes: {
        type: "integer",
        title: "Live stream time-check interval (minutes)",
        default: 15,
        minimum: 1,
        maximum: 120,
      },
      masterVolumePercent: {
        type: "number",
        title: "Master volume (%)",
        default: 100,
        minimum: 0,
        maximum: 200,
      },
      speechVolumePercent: {
        type: "number",
        title: "Speech volume (%)",
        default: 65,
        minimum: 0,
        maximum: 200,
      },
      pingEnabled: {
        type: "boolean",
        title: "Enable directional ping",
        default: true,
      },
      pingVolumePercent: {
        type: "number",
        title: "Directional ping volume (%)",
        default: 100,
        minimum: 0,
        maximum: 400,
      },
      pingSmallFrequencyHz: {
        type: "integer",
        title: "Small vessel ping frequency",
        default: 1100,
        minimum: 200,
        maximum: 2400,
      },
      pingMediumFrequencyHz: {
        type: "integer",
        title: "Medium vessel ping frequency",
        default: 760,
        minimum: 200,
        maximum: 2400,
      },
      pingLargeFrequencyHz: {
        type: "integer",
        title: "Large vessel ping frequency",
        default: 440,
        minimum: 200,
        maximum: 2400,
      },
      generatedAudioExpiresSeconds: {
        type: "integer",
        title: "Generated audio freshness window",
        description: "Browser clients should not auto-play announcement audio older than this.",
        default: 90,
        minimum: 10,
        maximum: 600,
      },
      debugLogging: {
        type: "boolean",
        title: "Enable debug log",
        default: false,
      },
    },
  };

  plugin.registerWithRouter = (router) => {
    router.get("/status", (_req, res) => {
      res.json(buildStatus());
    });

    router.get("/live.mp3", async (_req, res) => {
      if (!options.liveStream) {
        res.status(404).json({ error: "Live stream is disabled." });
        return;
      }
      try {
        await addLiveStreamClient(res);
      } catch (error) {
        addRecent("error", `Live stream failed: ${error.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        } else {
          res.end();
        }
      }
    });

    router.get("/live.m3u", (req, res) => {
      const streamUrl = absolutePluginUrl(req, "/live.mp3");
      res.setHeader("Content-Type", "audio/x-mpegurl; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(`#EXTM3U\n#EXTINF:-1,AIS Plus Audio\n${streamUrl}\n`);
    });

    router.get("/audio/:file", (req, res) => {
      const file = path.basename(req.params.file || "");
      if (!file.endsWith(".mp3")) {
        res.status(404).json({ error: "Audio file not found." });
        return;
      }
      const filePath = path.join(expandHome(options.audioDirectory), file);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: "Audio file not found." });
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(filePath).pipe(res);
    });

    router.post("/sound-check", (_req, res) => {
      const entry = normalizeAnnouncement({
        id: `sound-check-${Date.now()}`,
        ts: new Date().toISOString(),
        severity: "alert",
        category: "test",
        vesselName: "AIS Plus Audio",
        clock: 12,
        sizeCategory: "medium",
        message: "Sound Check. Testing 1, 2, 3.",
        force: true,
      });
      enqueue(entry);
      res.json({ ok: true, announcement: entry });
    });

    router.post("/clear-queue", (_req, res) => {
      queue = [];
      addRecent("queue-cleared", "Announcement queue cleared");
      res.json({ ok: true });
    });

    router.post("/restart-streams", (_req, res) => {
      const count = restartLiveStreamClients("manual stream restart");
      res.json({ ok: true, restarted: count });
    });

    router.post("/stream-time-check", (_req, res) => {
      const entry = createStreamTimeCheckAnnouncement(true);
      enqueue(entry);
      res.json({ ok: true, announcement: entry });
    });

    router.post("/repeat-last", (_req, res) => {
      if (!lastAnnouncement) {
        res.status(404).json({ error: "No announcement has been received yet." });
        return;
      }
      enqueue({
        ...lastAnnouncement,
        id: `repeat-${Date.now()}`,
        force: true,
      });
      res.json({ ok: true });
    });
  };

  return plugin;

  function normalizeOptions(value) {
    return {
      enabled: value.enabled !== false,
      muted: value.muted === true,
      localPlayback: value.localPlayback !== false,
      liveStream: value.liveStream !== false,
      publicHttpStream: value.publicHttpStream !== false,
      publicHttpStreamPort: clampInteger(value.publicHttpStreamPort, 1024, 65535, 3445),
      publicStreamUseHttps: value.publicStreamUseHttps !== false,
      piperBinary: expandHome(String(value.piperBinary || "piper")),
      ffmpegBinary: expandHome(String(value.ffmpegBinary || "ffmpeg")),
      audioPlayer: expandHome(String(value.audioPlayer || "aplay")),
      voicesDir: String(value.voicesDir || "~/piper-voices"),
      voice: String(value.voice || "en_GB-alan-medium"),
      audioDirectory: String(value.audioDirectory || DEFAULT_AUDIO_DIR),
      maxAudioFiles: clampInteger(value.maxAudioFiles, 1, 200, 30),
      maxQueueLength: clampInteger(value.maxQueueLength, 1, 100, 10),
      mp3BitrateKbps: clampInteger(value.mp3BitrateKbps, 32, 192, 64),
      maxStreamLagSeconds: clampInteger(value.maxStreamLagSeconds, 5, 300, 30),
      streamHealthTimeCheck: value.streamHealthTimeCheck === true,
      streamHealthIntervalMinutes: clampInteger(value.streamHealthIntervalMinutes, 1, 120, 15),
      masterVolumePercent: normalizePercentValue(value.masterVolumePercent, value.masterVolume, 100, 200),
      speechVolumePercent: normalizePercentValue(value.speechVolumePercent, value.speechVolume, 65, 200),
      pingEnabled: value.pingEnabled !== false,
      pingVolumePercent: normalizePercentValue(value.pingVolumePercent, value.pingVolume, 100, 400),
      pingSmallFrequencyHz: clampInteger(value.pingSmallFrequencyHz, 200, 2400, 1100),
      pingMediumFrequencyHz: clampInteger(value.pingMediumFrequencyHz, 200, 2400, 760),
      pingLargeFrequencyHz: clampInteger(value.pingLargeFrequencyHz, 200, 2400, 440),
      generatedAudioExpiresSeconds: clampInteger(
        value.generatedAudioExpiresSeconds,
        10,
        600,
        90,
      ),
      debugLogging: value.debugLogging === true,
    };
  }

  function subscribeToAisPlusAnnouncements() {
    if (!app.subscriptionmanager?.subscribe) {
      addRecent("warning", "Signal K subscription manager is not available");
      return;
    }

    const subscription = {
      context: "vessels.self",
      subscribe: [
        {
          path: "notifications.collision",
          policy: "instant",
          format: "delta",
        },
        {
          path: "notifications.collision.*",
          policy: "instant",
          format: "delta",
        },
      ],
    };

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (error) => {
        addRecent("error", `Subscription error: ${error}`);
        app.error(`[${PLUGIN_ID}] subscription error: ${error}`);
      },
      (delta) => handleDelta(delta),
    );
  }

  function handleDelta(delta) {
    for (const update of delta.updates || []) {
      for (const value of update.values || []) {
        handleNotificationValue(value);
      }
    }
  }

  function handleNotificationValue(value) {
    if (!value?.path?.startsWith("notifications.collision")) return;
    stats.received += 1;

    if (value.path === "notifications.collision" && value.value && typeof value.value === "object") {
      for (const [id, notification] of Object.entries(value.value)) {
        handleNotification(`notifications.collision.${id}`, notification);
      }
      return;
    }

    handleNotification(value.path, value.value);
  }

  function handleNotification(pathName, value) {
    const alertEvent = value?.data?.alertEvent || {};
    const announcement = value?.data?.announcement || {};
    const methods = normalizeMethods(alertEvent.methods || value?.method);
    const message = String(alertEvent.message || value?.message || "").trim();

    if (!message || !methods.includes("sound") || alertEvent.shouldAnnounce === false || announcement.shouldAnnounce === false) {
      stats.filtered += 1;
      debug(`Filtered ${pathName}`);
      return;
    }

    enqueue(
      normalizeAnnouncement({
        id: alertEvent.id || announcement.id || `${pathName}-${Date.now()}`,
        ts: alertEvent.ts || announcement.ts || new Date().toISOString(),
        expiresAt: alertEvent.expiresAt || announcement.expiresAt || null,
        vesselId: alertEvent.vesselId || value?.source?.label || "",
        vesselName: alertEvent.vesselName || value?.data?.vesselName || "",
        severity: alertEvent.state || value?.state || value?.data?.alarmState || "alert",
        category: alertEvent.category || value?.data?.category || "cpa",
        clock: alertEvent.clock || announcement.clock || value?.data?.relativeClock,
        sizeCategory:
          alertEvent.sizeCategory || announcement.sizeCategory || value?.data?.sizeCategory,
        message,
        sourcePath: pathName,
      }),
    );
  }

  function enqueue(entry) {
    if (!entry?.message) return;
    lastAnnouncement = entry;

    if (!options.enabled && !entry.force) {
      addRecent("skipped", `Audio disabled: ${entry.message}`);
      return;
    }
    if (options.muted && !entry.force) {
      addRecent("skipped", `Muted: ${entry.message}`);
      return;
    }

    queue.push(entry);
    if (queue.length > options.maxQueueLength) {
      queue = queue.slice(queue.length - options.maxQueueLength);
      addRecent("warning", "Dropped stale queued announcements");
    }
    stats.queued += 1;
    addRecent("queued", entry.message);
    processQueue();
  }

  async function processQueue() {
    if (active || queue.length === 0) return;
    active = queue.shift();
    try {
      const rendered = await renderAnnouncement(active);
      lastAnnouncement = rendered;
      if (rendered.category !== "stream-health") {
        lastRealAnnouncementAt = Date.now();
      }
      stats.rendered += 1;
      addRecent("rendered", rendered.message);
    } catch (error) {
      stats.failed += 1;
      addRecent("error", `Render failed: ${error.message}`);
      app.error(`[${PLUGIN_ID}] render failed: ${error.stack || error.message}`);
    } finally {
      active = null;
      processQueue();
    }
  }

  async function renderAnnouncement(entry) {
    const audioDir = expandHome(options.audioDirectory);
    await fs.promises.mkdir(audioDir, { recursive: true });

    const baseName = safeFileSegment(entry.id || `announcement-${Date.now()}`);
    const tempBase = path.join(os.tmpdir(), `${PLUGIN_ID}-${baseName}-${Date.now()}`);
    const speechWav = `${tempBase}-speech.wav`;
    const pingWav = `${tempBase}-ping.wav`;
    const combinedWav = `${tempBase}-combined.wav`;
    const mp3FileName = `${baseName}.mp3`;
    const mp3File = path.join(audioDir, mp3FileName);
    const metadataFile = path.join(audioDir, `${baseName}.json`);

    try {
      await synthesizePiperWav(formatMessageForSpeech(entry.message), speechWav);
      const clock = extractClockPosition(entry);
      const shouldPing = options.pingEnabled && clock != null;
      if (shouldPing) {
        await fs.promises.writeFile(
          pingWav,
          createPingWav(clock, extractVesselSize(entry), pingCountForClock(clock)),
        );
      }

      await createCombinedWav({
        speechWav,
        pingWav: shouldPing ? pingWav : null,
        combinedWav,
      });
      await createMp3(combinedWav, mp3File);

      const rendered = {
        ...entry,
        audioUrl: `/plugins/${PLUGIN_ID}/audio/${mp3FileName}`,
        streamUrl: `/plugins/${PLUGIN_ID}/live.mp3`,
        playlistUrl: `/plugins/${PLUGIN_ID}/live.m3u`,
        audioFile: mp3FileName,
        renderedAt: new Date().toISOString(),
      };
      await fs.promises.writeFile(metadataFile, `${JSON.stringify(rendered, null, 2)}\n`);
      await cleanupGeneratedAudio();
      await broadcastMp3ToLiveStream(mp3File);

      if (!entry.streamOnly && options.localPlayback && !options.muted) {
        await playLocalWav(combinedWav);
      }

      return rendered;
    } finally {
      for (const file of [speechWav, pingWav, combinedWav]) {
        fs.rm(file, { force: true }, () => {});
      }
    }
  }

  function normalizeAnnouncement(value) {
    const ts = String(value.ts || new Date().toISOString());
    const expiresAt =
      value.expiresAt ||
      new Date(Date.parse(ts) + options.generatedAudioExpiresSeconds * 1000).toISOString();
    return {
      id: String(value.id || `announcement-${Date.now()}`),
      timestamp: ts,
      expiresAt,
      vesselId: String(value.vesselId || ""),
      vesselName: String(value.vesselName || ""),
      severity: String(value.severity || "alert"),
      category: String(value.category || "cpa"),
      clock: normalizeClock(value.clock),
      sizeCategory: normalizeSizeCategory(value.sizeCategory),
      message: String(value.message || "").trim(),
      sourcePath: String(value.sourcePath || ""),
      force: value.force === true,
      streamOnly: value.streamOnly === true,
    };
  }

  function normalizeMethods(method) {
    const values = Array.isArray(method) ? method : [method];
    return values
      .flatMap((item) => String(item || "").split(","))
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  function buildStatus() {
    return {
      plugin: PLUGIN_ID,
      version: packageInfo.version,
      serverTime: new Date().toISOString(),
      enabled: options.enabled,
      muted: options.muted,
      localPlayback: options.localPlayback,
      liveStream: options.liveStream,
      liveStreamClients: liveStreamClients.size,
      streamUrl: `/plugins/${PLUGIN_ID}/live.mp3`,
      playlistUrl: `/plugins/${PLUGIN_ID}/live.m3u`,
      publicHttpStream: options.publicHttpStream,
      publicHttpStreamPort: options.publicHttpStreamPort,
      publicStreamUseHttps: options.publicStreamUseHttps,
      publicStreamProtocol: publicStreamProtocol(),
      publicStreamUrl: `${publicStreamProtocol()}://${process.env.EXTERNALHOST || "nemo3.local"}:${options.publicHttpStreamPort}/live.mp3`,
      publicPlaylistUrl: `${publicStreamProtocol()}://${process.env.EXTERNALHOST || "nemo3.local"}:${options.publicHttpStreamPort}/live.m3u`,
      mp3BitrateKbps: options.mp3BitrateKbps,
      maxStreamLagSeconds: options.maxStreamLagSeconds,
      maxStreamBufferBytes: maxStreamBufferBytes(),
      streamHealthTimeCheck: options.streamHealthTimeCheck,
      streamHealthIntervalMinutes: options.streamHealthIntervalMinutes,
      masterVolumePercent: options.masterVolumePercent,
      speechVolumePercent: options.speechVolumePercent,
      pingVolumePercent: options.pingVolumePercent,
      queueLength: queue.length,
      active,
      lastAnnouncement,
      recentEvents: recentEvents.slice().reverse(),
      stats,
      droppedLaggingClients,
      audioDirectory: expandHome(options.audioDirectory),
      voices: listVoices(),
    };
  }

  function listVoices() {
    const dir = expandHome(options.voicesDir);
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".onnx"))
        .map((name) => ({
          id: name.replace(/\.onnx$/, ""),
          file: path.join(dir, name),
          selected: options.voice === name || options.voice === name.replace(/\.onnx$/, ""),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      return [];
    }
  }

  function selectedVoice() {
    const voices = listVoices();
    if (!voices.length) return null;
    return (
      voices.find((voice) => voice.selected) ||
      voices.find((voice) => `${voice.id}.onnx` === options.voice) ||
      voices[0]
    );
  }

  function synthesizePiperWav(message, outputFile) {
    const voice = selectedVoice();
    if (!voice) {
      throw new Error(`No Piper voices found in ${expandHome(options.voicesDir)}`);
    }
    return runProcess(
      options.piperBinary,
      ["--model", voice.file, "--output_file", outputFile],
      `${message}\n`,
    );
  }

  function createCombinedWav({ speechWav, pingWav, combinedWav }) {
    const masterVolume = percentToGain(options.masterVolumePercent);
    const speechVolume = percentToGain(options.speechVolumePercent);
    const filter = pingWav
      ? `[0:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[p];[1:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo,volume=${speechVolume}[s];[p][s]concat=n=2:v=0:a=1,volume=${masterVolume}[out]`
      : `[0:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo,volume=${speechVolume * masterVolume}[out]`;
    const inputs = pingWav ? ["-i", pingWav, "-i", speechWav] : ["-i", speechWav];
    return runProcess(options.ffmpegBinary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16le",
      combinedWav,
    ]);
  }

  function createMp3(inputWav, outputMp3) {
    return runProcess(options.ffmpegBinary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputWav,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      `${options.mp3BitrateKbps}k`,
      "-write_id3v1",
      "0",
      "-id3v2_version",
      "0",
      outputMp3,
    ]);
  }

  async function addLiveStreamClient(res) {
    await ensureLiveSilenceFile();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const client = { res, connectedAt: Date.now() };
    liveStreamClients.add(client);
    addRecent("stream-connected", `${liveStreamClients.size} live stream client(s)`);
    res.on("close", () => closeLiveStreamClient(client));

    await writeFileToLiveClient(client, liveSilenceFile);
    startLiveStreamSilence();
  }

  function startPublicStreamServer() {
    if (!options.publicHttpStream || publicStreamServer) return;
    const tlsOptions = publicStreamTlsOptions();
    publicStreamIsHttps = Boolean(tlsOptions);
    const requestHandler = (req, res) => {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      if (req.method !== "GET") {
        sendPlainResponse(res, 405, "Method not allowed\n", "text/plain; charset=utf-8");
        return;
      }
      if (requestUrl.pathname === "/live.mp3") {
        if (!options.liveStream) {
          sendJsonResponse(res, 404, { error: "Live stream is disabled." });
          return;
        }
        addLiveStreamClient(res).catch((error) => {
          addRecent("error", `Public live stream failed: ${error.message}`);
          if (!res.headersSent) {
            sendJsonResponse(res, 500, { error: error.message });
          } else {
            res.end();
          }
        });
        return;
      }
      if (requestUrl.pathname === "/live.m3u") {
        const host = req.headers.host || `localhost:${options.publicHttpStreamPort}`;
        sendPlainResponse(
          res,
          200,
          `#EXTM3U\n#EXTINF:-1,AIS Plus Audio\n${publicStreamProtocol()}://${host}/live.mp3\n`,
          "audio/x-mpegurl; charset=utf-8",
        );
        return;
      }
      if (requestUrl.pathname === "/status") {
        sendJsonResponse(res, 200, {
          ok: true,
          plugin: PLUGIN_ID,
          version: packageInfo.version,
          clients: liveStreamClients.size,
        });
        return;
      }
      sendPlainResponse(res, 404, "Not found\n", "text/plain; charset=utf-8");
    };
    publicStreamServer = tlsOptions
      ? https.createServer(tlsOptions, requestHandler)
      : http.createServer(requestHandler);
    publicStreamServer.on("error", (error) => {
      addRecent("error", `Public stream server failed: ${error.message}`);
      app.error(`[${PLUGIN_ID}] public stream server failed: ${error.stack || error.message}`);
    });
    publicStreamServer.listen(options.publicHttpStreamPort, "0.0.0.0", () => {
      addRecent(
        "stream-server",
        `Listening on ${publicStreamProtocol()}://0.0.0.0:${options.publicHttpStreamPort}`,
      );
    });
  }

  function stopPublicStreamServer() {
    if (!publicStreamServer) return;
    publicStreamServer.close();
    publicStreamServer = null;
    publicStreamIsHttps = false;
  }

  function sendJsonResponse(res, statusCode, body) {
    sendPlainResponse(res, statusCode, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
  }

  function sendPlainResponse(res, statusCode, body, contentType) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  }

  function publicStreamTlsOptions() {
    if (!options.publicStreamUseHttps) return null;
    const configPath = app.config?.configPath || path.join(os.homedir(), ".signalk");
    const keyPath = path.join(configPath, "ssl-key.pem");
    const certPath = path.join(configPath, "ssl-cert.pem");
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      addRecent("warning", `HTTPS stream disabled: ${keyPath} or ${certPath} not found`);
      return null;
    }
    try {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    } catch (error) {
      addRecent("warning", `HTTPS stream disabled: ${error.message}`);
      return null;
    }
  }

  function publicStreamProtocol() {
    return publicStreamIsHttps ? "https" : "http";
  }

  function closeLiveStreamClient(client) {
    if (!liveStreamClients.has(client)) return;
    liveStreamClients.delete(client);
    try {
      client.res.end();
    } catch {
      // Client has already gone away.
    }
    addRecent("stream-disconnected", `${liveStreamClients.size} live stream client(s)`);
    if (liveStreamClients.size === 0) {
      stopLiveStreamSilence();
    }
  }

  function startLiveStreamSilence() {
    if (liveSilenceTimer) return;
    liveSilenceTimer = setInterval(() => {
      if (!liveStreamClients.size || Date.now() < liveStreamPauseUntil || !liveSilenceFile) return;
      for (const client of Array.from(liveStreamClients)) {
        if (isStreamClientLagging(client)) {
          closeLaggingLiveStreamClient(client, "silence");
          continue;
        }
        writeFileToLiveClient(client, liveSilenceFile).catch(() => closeLiveStreamClient(client));
      }
    }, 1000);
  }

  function stopLiveStreamSilence() {
    if (liveSilenceTimer) {
      clearInterval(liveSilenceTimer);
      liveSilenceTimer = null;
    }
  }

  async function ensureLiveSilenceFile() {
    const audioDir = expandHome(options.audioDirectory);
    await fs.promises.mkdir(audioDir, { recursive: true });
    const silenceFile = path.join(audioDir, `live-silence-1s-${options.mp3BitrateKbps}k.mp3`);
    if (fs.existsSync(silenceFile)) {
      liveSilenceFile = silenceFile;
      return silenceFile;
    }
    await runProcess(options.ffmpegBinary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      `${options.mp3BitrateKbps}k`,
      "-write_id3v1",
      "0",
      "-id3v2_version",
      "0",
      silenceFile,
    ]);
    liveSilenceFile = silenceFile;
    return silenceFile;
  }

  async function broadcastMp3ToLiveStream(mp3File) {
    if (!options.liveStream || liveStreamClients.size === 0 || !fs.existsSync(mp3File)) return;
    const stat = await fs.promises.stat(mp3File);
    liveStreamPauseUntil = Date.now() + estimateMp3DurationMs(stat.size) + 600;
    for (const client of Array.from(liveStreamClients)) {
      if (isStreamClientLagging(client)) {
        closeLaggingLiveStreamClient(client, "announcement");
        continue;
      }
      writeFileToLiveClient(client, mp3File).catch(() => closeLiveStreamClient(client));
    }
    addRecent("streamed", `Streamed announcement to ${liveStreamClients.size} client(s)`);
  }

  async function writeFileToLiveClient(client, file) {
    if (!client?.res || client.res.destroyed || client.res.writableEnded) {
      closeLiveStreamClient(client);
      return;
    }
    const buffer = await fs.promises.readFile(file);
    await new Promise((resolve, reject) => {
      client.res.write(buffer, (error) => (error ? reject(error) : resolve()));
    });
  }

  function estimateMp3DurationMs(bytes) {
    const bytesPerSecond = Math.max(1, (options.mp3BitrateKbps * 1000) / 8);
    return Math.max(1200, Math.min(30000, Math.round((bytes / bytesPerSecond) * 1000)));
  }

  function maxStreamBufferBytes() {
    return Math.round(((options.mp3BitrateKbps * 1000) / 8) * options.maxStreamLagSeconds);
  }

  function isStreamClientLagging(client) {
    return Number(client?.res?.writableLength || 0) > maxStreamBufferBytes();
  }

  function closeLaggingLiveStreamClient(client, phase) {
    droppedLaggingClients += 1;
    addRecent(
      "stream-lag-reset",
      `Restarted lagging stream during ${phase}; buffered ${client?.res?.writableLength || 0} bytes`,
    );
    closeLiveStreamClient(client);
  }

  function restartLiveStreamClients(reason) {
    const clients = Array.from(liveStreamClients);
    for (const client of clients) {
      closeLiveStreamClient(client);
    }
    addRecent("stream-restart", `${clients.length} live stream client(s) restarted: ${reason}`);
    return clients.length;
  }

  function startStreamHealthTimer() {
    stopStreamHealthTimer();
    streamHealthTimer = setInterval(() => {
      if (!options.streamHealthTimeCheck || !liveStreamClients.size) return;
      const intervalMs = options.streamHealthIntervalMinutes * 60 * 1000;
      const lastAudioAt = Math.max(lastRealAnnouncementAt, lastStreamHealthAt);
      if (lastAudioAt && Date.now() - lastAudioAt < intervalMs) return;
      enqueue(createStreamTimeCheckAnnouncement(false));
    }, 30 * 1000);
  }

  function stopStreamHealthTimer() {
    if (streamHealthTimer) {
      clearInterval(streamHealthTimer);
      streamHealthTimer = null;
    }
  }

  function createStreamTimeCheckAnnouncement(force) {
    const now = new Date();
    lastStreamHealthAt = now.getTime();
    const time = now.toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return normalizeAnnouncement({
      id: `stream-time-check-${Date.now()}`,
      ts: now.toISOString(),
      severity: "alert",
      category: "stream-health",
      vesselName: "AIS Plus Audio",
      message: `AIS Plus Audio time check. Server time is ${time}.`,
      force,
      streamOnly: true,
    });
  }

  function absolutePluginUrl(req, pluginPath) {
    const host = req.get?.("host") || "localhost";
    const forwardedProto = req.get?.("x-forwarded-proto");
    const protocol = forwardedProto || req.protocol || "https";
    return `${protocol}://${host}/plugins/${PLUGIN_ID}${pluginPath}`;
  }

  function playLocalWav(file) {
    return runProcess(options.audioPlayer, [file]);
  }

  function runProcess(command, args, stdin = null) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
        }
      });
      child.stdin.end(stdin || "");
    });
  }

  function createPingWav(clock, size = "", pingCount = 1) {
    const sampleRate = 44100;
    const channels = 2;
    const bytesPerSample = 2;
    const toneSamples = Math.max(1, Math.round((sampleRate * 180) / 1000));
    const gapSamples = pingCount > 1 ? Math.max(0, Math.round((sampleRate * 90) / 1000)) : 0;
    const durationSamples = toneSamples * pingCount + gapSamples * (pingCount - 1);
    const dataSize = durationSamples * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);
    const pan = clockToPan(clock);
    const leftGain = Math.cos(((pan + 1) * Math.PI) / 4);
    const rightGain = Math.sin(((pan + 1) * Math.PI) / 4);
    const amplitude = Math.round(32767 * percentToGain(options.pingVolumePercent));
    const frequency = pingFrequencyForSize(size);

    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(bytesPerSample * 8, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < durationSamples; i += 1) {
      const cycleSamples = toneSamples + gapSamples;
      const cycleOffset = cycleSamples > 0 ? i % cycleSamples : i;
      const inTone = cycleOffset < toneSamples;
      const progress = inTone ? cycleOffset / toneSamples : 0;
      const t = cycleOffset / sampleRate;
      const attack = inTone ? Math.min(1, cycleOffset / (sampleRate * 0.012)) : 0;
      const decay = inTone ? Math.exp(-5.2 * progress) : 0;
      const fadeOut = inTone ? Math.min(1, (toneSamples - cycleOffset) / (sampleRate * 0.025)) : 0;
      const envelope = attack * decay * fadeOut;
      const sweptFrequency = frequency * (1 - (1 - 0.72) * progress);
      const phase = 2 * Math.PI * sweptFrequency * t;
      const tone = inTone ? Math.sin(phase) + 0.18 * Math.sin(phase * 2.01) : 0;
      const sample = amplitude * tone * Math.max(0, envelope);
      const offset = 44 + i * channels * bytesPerSample;
      buffer.writeInt16LE(clampPcm16(sample * leftGain), offset);
      buffer.writeInt16LE(clampPcm16(sample * rightGain), offset + 2);
    }

    return buffer;
  }

  function pingFrequencyForSize(size) {
    if (size === "large") return options.pingLargeFrequencyHz;
    if (size === "medium") return options.pingMediumFrequencyHz;
    return options.pingSmallFrequencyHz;
  }

  function pingCountForClock(clock) {
    return clock >= 10 || clock <= 2 ? 1 : 2;
  }

  function clockToPan(clock) {
    const angle = ((clock % 12) / 12) * Math.PI * 2;
    return Math.max(-1, Math.min(1, Math.sin(angle)));
  }

  function extractClockPosition(entry) {
    const direct = normalizeClock(entry?.clock ?? entry?.relativeClock);
    if (direct != null) return direct;
    const match = String(entry?.message || "").match(/\bat\s+([1-9]|1[0-2])\s+o'?clock\b/i);
    return match ? Number(match[1]) : null;
  }

  function extractVesselSize(entry) {
    const direct = normalizeSizeCategory(entry?.sizeCategory);
    if (direct) return direct;
    const message = String(entry?.message || "").toLowerCase();
    if (message.includes("large vessel")) return "large";
    if (message.includes("medium vessel")) return "medium";
    return "small";
  }

  function normalizeClock(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1 || number > 12) return null;
    return Math.round(number);
  }

  function normalizeSizeCategory(value) {
    const clean = String(value || "").toLowerCase();
    return ["small", "medium", "large"].includes(clean) ? clean : "";
  }

  function formatMessageForSpeech(message) {
    return String(message || "").replace(
      /\b((?:fast\s+)?(?:large vessel|medium vessel|small craft|small vessel|vessel)\s+)(.+?)(\s+at\s+(?:[1-9]|1[0-2])\s+o'?clock\b)/gi,
      (_match, prefix, vesselName, suffix) =>
        `${prefix}${formatVesselNameForSpeech(vesselName)}${suffix}`,
    );
  }

  function formatVesselNameForSpeech(name) {
    const clean = String(name || "").trim();
    const letters = clean.match(/[A-Za-z]/g) || [];
    const uppercaseLetters = clean.match(/[A-Z]/g) || [];
    if (letters.length < 2 || uppercaseLetters.length / letters.length < 0.8) {
      return clean;
    }
    return clean.toLowerCase().replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }

  function cleanupGeneratedAudio() {
    const audioDir = expandHome(options.audioDirectory);
    return fs.promises
      .readdir(audioDir)
      .then((files) =>
        Promise.all(
          files
            .filter((file) => file.endsWith(".mp3") && !file.startsWith("live-silence-1s-"))
            .map(async (file) => {
              const fullPath = path.join(audioDir, file);
              const stat = await fs.promises.stat(fullPath);
              return { fullPath, mtimeMs: stat.mtimeMs };
            }),
        ),
      )
      .then((files) =>
        Promise.all(
          files
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(options.maxAudioFiles)
            .flatMap((item) => [
              fs.promises.rm(item.fullPath, { force: true }),
              fs.promises.rm(item.fullPath.replace(/\.mp3$/, ".json"), { force: true }),
            ]),
        ),
      );
  }

  function ensureAudioDirectory() {
    fs.mkdirSync(expandHome(options.audioDirectory), { recursive: true });
  }

  function addRecent(event, message) {
    recentEvents.push({
      ts: new Date().toISOString(),
      event,
      message,
    });
    if (recentEvents.length > 80) {
      recentEvents = recentEvents.slice(recentEvents.length - 80);
    }
  }

  function debug(message) {
    if (options.debugLogging) {
      app.debug(`[${PLUGIN_ID}] ${message}`);
    }
  }

  function expandHome(filePath) {
    const clean = String(filePath || "").trim();
    if (clean === "~") return os.homedir();
    if (clean.startsWith("~/")) return path.join(os.homedir(), clean.slice(2));
    return clean;
  }

  function safeFileSegment(value) {
    return String(value || "announcement")
      .replace(/[^a-z0-9_.-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
  }

  function safeFfmpegNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 1;
  }

  function percentToGain(value) {
    return safeFfmpegNumber(value) / 100;
  }

  function normalizePercentValue(percentValue, legacyGainValue, fallbackPercent, maxPercent) {
    const explicitPercent = Number(percentValue);
    if (Number.isFinite(explicitPercent)) {
      return Math.min(maxPercent, Math.max(0, explicitPercent));
    }
    const legacyGain = Number(legacyGainValue);
    if (Number.isFinite(legacyGain)) {
      return Math.min(maxPercent, Math.max(0, legacyGain * 100));
    }
    return fallbackPercent;
  }

  function clampPcm16(value) {
    return Math.max(-32768, Math.min(32767, Math.round(value)));
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }
};
