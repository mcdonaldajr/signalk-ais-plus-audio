const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
        description: "The .onnx filename or voice id to use. Leave blank to use the first detected voice.",
        default: "",
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
      masterVolume: {
        type: "number",
        title: "Master volume",
        default: 1,
        minimum: 0,
        maximum: 2,
      },
      speechVolume: {
        type: "number",
        title: "Speech volume",
        default: 0.65,
        minimum: 0,
        maximum: 2,
      },
      pingEnabled: {
        type: "boolean",
        title: "Enable directional ping",
        default: true,
      },
      pingVolume: {
        type: "number",
        title: "Directional ping volume",
        default: 1,
        minimum: 0,
        maximum: 4,
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

    router.post("/sound-check", (_req, res) => {
      const entry = normalizeAnnouncement({
        id: `sound-check-${Date.now()}`,
        ts: new Date().toISOString(),
        severity: "alert",
        category: "test",
        vesselName: "AIS Plus Audio",
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
      piperBinary: String(value.piperBinary || "piper"),
      ffmpegBinary: String(value.ffmpegBinary || "ffmpeg"),
      audioPlayer: String(value.audioPlayer || "aplay"),
      voicesDir: String(value.voicesDir || "~/piper-voices"),
      voice: String(value.voice || ""),
      audioDirectory: String(value.audioDirectory || DEFAULT_AUDIO_DIR),
      maxAudioFiles: clampInteger(value.maxAudioFiles, 1, 200, 30),
      maxQueueLength: clampInteger(value.maxQueueLength, 1, 100, 10),
      masterVolume: clampNumber(value.masterVolume, 0, 2, 1),
      speechVolume: clampNumber(value.speechVolume, 0, 2, 0.65),
      pingEnabled: value.pingEnabled !== false,
      pingVolume: clampNumber(value.pingVolume, 0, 4, 1),
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
      await renderPlaceholder(active);
      stats.rendered += 1;
      addRecent("rendered", active.message);
    } catch (error) {
      stats.failed += 1;
      addRecent("error", `Render failed: ${error.message}`);
      app.error(`[${PLUGIN_ID}] render failed: ${error.stack || error.message}`);
    } finally {
      active = null;
      processQueue();
    }
  }

  async function renderPlaceholder(entry) {
    // The next implementation step replaces this metadata file with:
    // Piper WAV -> stereo ping mix -> stereo MP3 -> published audio URL.
    const fileName = `${safeFileSegment(entry.id)}.json`;
    const filePath = path.join(expandHome(options.audioDirectory), fileName);
    await fs.promises.writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`);
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
      message: String(value.message || "").trim(),
      sourcePath: String(value.sourcePath || ""),
      force: value.force === true,
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
      enabled: options.enabled,
      muted: options.muted,
      localPlayback: options.localPlayback,
      queueLength: queue.length,
      active,
      lastAnnouncement,
      recentEvents: recentEvents.slice().reverse(),
      stats,
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
