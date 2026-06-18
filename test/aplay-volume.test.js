const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createPlugin = require("../plugin");

function createHarness(initialOptions = {}, harnessOptions = {}) {
  const savedOptions = [];
  const subscriptionCallbacks = [];
  const app = {
    config: { configPath: "/tmp" },
    debug() {},
    error() {},
    setPluginStatus() {},
    handleMessage() {},
    savePluginOptions(nextOptions, callback) {
      savedOptions.push(nextOptions);
      callback();
    },
    subscriptionmanager: {
      subscribe(_subscription, _unsubscribes, _onError, onDelta) {
        subscriptionCallbacks.push(onDelta);
      },
    },
  };
  const plugin = createPlugin(app);
  const baseOptions = {
    publicHttpStream: false,
    liveStream: false,
    localPlayback: true,
    ...initialOptions,
  };
  if (harnessOptions.disableMixer !== false && initialOptions.aplayVolumeCommand == null) {
    baseOptions.aplayVolumeCommand = "";
  }
  plugin.start(baseOptions);

  const posts = new Map();
  const gets = new Map();
  plugin.registerWithRouter({
    post(path, handler) {
      posts.set(path, handler);
    },
    get(path, handler) {
      gets.set(path, handler);
    },
  });

  return {
    plugin,
    savedOptions,
    posts,
    gets,
    subscriptionCallbacks,
    brokerSequence: 0,
  };
}

function withPlatform(platform, fn) {
  const original = os.platform;
  os.platform = () => platform;
  try {
    return fn();
  } finally {
    os.platform = original;
  }
}

function statusOf(harness) {
  let status;
  harness.gets.get("/status")({}, { json(body) { status = body; } });
  return status;
}

function sendNotification(harness, pathName, value) {
  assert.ok(harness.subscriptionCallbacks.length > 0, "subscription callback registered");
  harness.brokerSequence += 1;
  const alertEvent = value?.data?.alertEvent || {};
  const muteState =
    typeof value?.data?.muted === "boolean" ? value.data.muted : null;
  harness.subscriptionCallbacks[0]({
    updates: [
      {
        values: [
          {
            path: "plugins.notificationsPlus",
            value: {
              audioSequence: harness.brokerSequence,
              lastAudioEvent: {
                schemaVersion: 1,
                provider: "ais-plus",
                subjectKey: pathName,
                eventId: alertEvent.id || `${pathName}-${harness.brokerSequence}`,
                lifecycle: "event",
                timestamp: new Date().toISOString(),
                priority: { level: "warning", score: 500 },
                delivery: {
                  audio: true,
                  localPlayback: true,
                  streamOutput: true,
                  muteState,
                },
                presentation: {
                  title: alertEvent.vesselName || "AIS Plus",
                  message: alertEvent.message || value?.message || "",
                  category: value?.data?.category || "notification",
                },
                context: {
                  mmsi: alertEvent.mmsi || "",
                },
              },
            },
          },
        ],
      },
    ],
  });
}

function vesselNotification(mmsi, message) {
  return {
    state: "warning",
    method: ["sound"],
    message,
    data: {
      category: "cpa",
      alertEvent: {
        mmsi,
        vesselName: `Vessel ${mmsi}`,
        methods: ["sound"],
        message,
      },
      announcement: {},
    },
  };
}

function soundStateNotification(muted) {
  return {
    state: "normal",
    method: ["sound"],
    message: muted ? "Sounds disabled." : "Sounds enabled.",
    data: {
      category: "system",
      muted,
      announcement: {},
    },
  };
}

function createSlowRenderHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ais-plus-audio-test-"));
  const voicesDir = path.join(tempDir, "voices");
  fs.mkdirSync(voicesDir, { recursive: true });
  fs.writeFileSync(path.join(voicesDir, "en_GB-alan-medium.onnx"), "");
  const piperBinary = path.join(tempDir, "slow-piper.sh");
  fs.writeFileSync(piperBinary, "#!/bin/sh\nsleep 1\nexit 1\n");
  fs.chmodSync(piperBinary, 0o755);
  const harness = createHarness({
    audioDirectory: path.join(tempDir, "audio"),
    liveStream: false,
    localPlayback: false,
    piperBinary,
    publicHttpStream: false,
    voicesDir,
  });
  return { ...harness, tempDir };
}

async function postVolume(harness, volume) {
  let body;
  await harness.posts.get("/aplay-volume")(
    { query: { volume: String(volume) } },
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        body = { statusCode: this.statusCode, ...value };
      },
    },
  );
  return body;
}

(async () => {
  const defaults = createHarness();
  assert.deepEqual(
    {
      level: statusOf(defaults).aplayVolumeLevelPercent,
      mixer: statusOf(defaults).aplayMixerVolumePercent,
    },
    { level: 53, mixer: 75 },
  );
  defaults.plugin.stop();

  const legacyMinimum = createHarness({ aplayVolumePercent: 66 });
  assert.deepEqual(
    {
      level: statusOf(legacyMinimum).aplayVolumeLevelPercent,
      mixer: statusOf(legacyMinimum).aplayMixerVolumePercent,
    },
    { level: 0, mixer: 66 },
  );
  legacyMinimum.plugin.stop();

  const routeMinimum = createHarness();
  const minimumBody = await postVolume(routeMinimum, 0);
  assert.equal(minimumBody.statusCode, 200);
  assert.equal(minimumBody.applied, false);
  assert.equal(minimumBody.aplayVolumeLevelPercent, 0);
  assert.equal(minimumBody.aplayVolumePercent, 66);
  assert.equal(routeMinimum.savedOptions.at(-1).aplayVolumeLevelPercent, 0);
  assert.equal(routeMinimum.savedOptions.at(-1).aplayVolumePercent, 66);
  routeMinimum.plugin.stop();

  const routeMaximum = createHarness();
  const maximumBody = await postVolume(routeMaximum, 100);
  assert.equal(maximumBody.statusCode, 200);
  assert.equal(maximumBody.aplayVolumeLevelPercent, 100);
  assert.equal(maximumBody.aplayVolumePercent, 100);
  assert.equal(routeMaximum.savedOptions.at(-1).aplayVolumeLevelPercent, 100);
  assert.equal(routeMaximum.savedOptions.at(-1).aplayVolumePercent, 100);
  routeMaximum.plugin.stop();

  const darwinDefault = withPlatform("darwin", () =>
    createHarness({}, { disableMixer: false }),
  );
  assert.equal(statusOf(darwinDefault).aplayVolumeCommand, "");
  assert.equal(statusOf(darwinDefault).aplayVolumeEnabled, false);
  const darwinDefaultBody = await postVolume(darwinDefault, 40);
  assert.equal(darwinDefaultBody.statusCode, 200);
  assert.equal(darwinDefaultBody.applied, false);
  assert.equal(darwinDefaultBody.error, "");
  darwinDefault.plugin.stop();

  const darwinSavedAmixer = withPlatform("darwin", () =>
    createHarness({ aplayVolumeCommand: "amixer" }, { disableMixer: false }),
  );
  assert.equal(statusOf(darwinSavedAmixer).aplayVolumeCommand, "");
  assert.equal(statusOf(darwinSavedAmixer).aplayVolumeEnabled, false);
  darwinSavedAmixer.plugin.stop();
  const queuedMute = createSlowRenderHarness();
  sendNotification(
    queuedMute,
    "notifications.collision.235900001",
    vesselNotification("235900001", "Traffic advisory. First vessel."),
  );
  assert.ok(statusOf(queuedMute).active, "first announcement is active");
  sendNotification(
    queuedMute,
    "notifications.collision.235900002",
    vesselNotification("235900002", "Traffic advisory. Second vessel."),
  );
  sendNotification(
    queuedMute,
    "notifications.collision.235900003",
    vesselNotification("235900003", "Traffic advisory. Third vessel."),
  );
  assert.equal(statusOf(queuedMute).queueLength, 2);
  sendNotification(
    queuedMute,
    "notifications.collision.soundState",
    soundStateNotification(true),
  );
  assert.equal(statusOf(queuedMute).queueLength, 0);
  assert.equal(statusOf(queuedMute).aisPlusMuted, true);
  assert.equal(statusOf(queuedMute).muted, true);
  sendNotification(
    queuedMute,
    "notifications.collision.235900004",
    vesselNotification("235900004", "Traffic advisory. Fourth vessel."),
  );
  assert.equal(statusOf(queuedMute).queueLength, 0);
  sendNotification(
    queuedMute,
    "notifications.collision.soundState",
    soundStateNotification(false),
  );
  assert.equal(statusOf(queuedMute).aisPlusMuted, false);
  assert.equal(statusOf(queuedMute).muted, false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  queuedMute.plugin.stop();
  fs.rmSync(queuedMute.tempDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
