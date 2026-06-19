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

function sendNotification(
  harness,
  pathName,
  value,
  priorityScore = 500,
  lifecycle = "event",
  activeSubjects = [],
  preempt = true,
) {
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
              active: activeSubjects.map((subjectKey) => ({ subjectKey })),
              lastAudioEvent: {
                schemaVersion: 1,
                provider: "ais-plus",
                subjectKey: pathName,
                eventId: alertEvent.id || `${pathName}-${harness.brokerSequence}`,
                lifecycle,
                timestamp: new Date().toISOString(),
                priority: { level: "warning", score: priorityScore },
                delivery: {
                  audio: true,
                  localPlayback: true,
                  streamOutput: true,
                  muteState,
                  preempt,
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

function createPipelineHarness({ piperDelaySeconds = 0 } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ais-plus-audio-pipeline-"));
  const voicesDir = path.join(tempDir, "voices");
  fs.mkdirSync(voicesDir, { recursive: true });
  fs.writeFileSync(path.join(voicesDir, "en_GB-alan-medium.onnx"), "");
  const piperBinary = path.join(tempDir, "piper.sh");
  const ffmpegBinary = path.join(tempDir, "ffmpeg.sh");
  const audioPlayer = path.join(tempDir, "aplay.sh");
  fs.writeFileSync(
    piperBinary,
    `#!/bin/sh\nout=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output_file" ]; then out="$2"; shift 2; else shift; fi\ndone\nsleep ${piperDelaySeconds}\nprintf wav > "$out"\n`,
  );
  fs.writeFileSync(
    ffmpegBinary,
    '#!/bin/sh\nfor arg in "$@"; do out="$arg"; done\nprintf wav > "$out"\n',
  );
  fs.writeFileSync(audioPlayer, "#!/bin/sh\nsleep 0.5\n");
  for (const file of [piperBinary, ffmpegBinary, audioPlayer]) {
    fs.chmodSync(file, 0o755);
  }
  const harness = createHarness({
    audioDirectory: path.join(tempDir, "audio"),
    audioPlayer,
    ffmpegBinary,
    liveStream: false,
    localPlayback: true,
    piperBinary,
    publicHttpStream: false,
    voicesDir,
  });
  return { ...harness, tempDir };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for audio pipeline state");
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

  const pipeline = createPipelineHarness();
  sendNotification(
    pipeline,
    "notifications.system.first",
    vesselNotification("pipeline-first", "First pipeline announcement."),
    100,
    "active",
    ["notifications.system.first"],
  );
  await waitFor(() => statusOf(pipeline).active);
  sendNotification(
    pipeline,
    "notifications.system.second",
    vesselNotification("pipeline-second", "Second pipeline announcement."),
    900,
    "event",
    ["notifications.system.first"],
  );
  await waitFor(() => {
    const status = statusOf(pipeline);
    return status.recentEvents.some((event) => event.event === "preempting")
      ? status
      : null;
  });
  const completedPipelineStatus = await waitFor(
    () => {
      const status = statusOf(pipeline);
      const preempted = status.recentEvents.some(
        (event) => event.event === "preempted",
      );
      const secondStarted = status.recentEvents.some(
        (event) =>
          event.event === "speaker-started" &&
          event.message.includes("Second pipeline announcement."),
      );
      const firstRestarted =
        status.recentEvents.filter(
          (event) =>
            event.event === "speaker-started" &&
            event.message.includes("First pipeline announcement."),
        ).length >= 2;
      const requeued = status.recentEvents.some(
        (event) => event.event === "preempted-requeued",
      );
      return preempted && secondStarted && firstRestarted && requeued ? status : null;
    },
    3500,
  );
  assert.equal(
    completedPipelineStatus.stats.failed,
    0,
    "priority interruption is not counted as a rendering failure",
  );
  await waitFor(() => statusOf(pipeline).stats.rendered >= 2, 3500);
  pipeline.plugin.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(pipeline.tempDir, { recursive: true, force: true });

  const nonPreempting = createPipelineHarness();
  sendNotification(
    nonPreempting,
    "notifications.system.playing",
    vesselNotification("non-preempting-first", "Message already playing."),
    100,
  );
  await waitFor(() => statusOf(nonPreempting).active);
  sendNotification(
    nonPreempting,
    "notifications.system.information",
    vesselNotification("non-preempting-second", "Routine information."),
    900,
    "event",
    [],
    false,
  );
  const waitingInformation = await waitFor(() => {
    const status = statusOf(nonPreempting);
    return status.active && status.prepared ? status : null;
  });
  assert.equal(
    waitingInformation.active.message,
    "Message already playing.",
    "non-preempting provider instruction leaves current audio uninterrupted",
  );
  assert.equal(
    waitingInformation.recentEvents.some((event) => event.event === "preempting"),
    false,
  );
  await waitFor(() => statusOf(nonPreempting).stats.rendered >= 2, 2500);
  nonPreempting.plugin.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(nonPreempting.tempDir, { recursive: true, force: true });

  const lowerPriority = createPipelineHarness();
  sendNotification(
    lowerPriority,
    "notifications.collision.high",
    vesselNotification("higher-priority", "Higher priority announcement."),
    900,
  );
  await waitFor(() => statusOf(lowerPriority).active);
  sendNotification(
    lowerPriority,
    "notifications.system.low",
    vesselNotification("lower-priority", "Lower priority announcement."),
    100,
    "event",
    [],
    true,
  );
  const lowerWaiting = await waitFor(() => {
    const status = statusOf(lowerPriority);
    return status.active && status.prepared ? status : null;
  });
  assert.equal(
    lowerWaiting.active.message,
    "Higher priority announcement.",
    "lower-priority prepared audio cannot replace the active speaker owner",
  );
  assert.equal(
    lowerWaiting.recentEvents.some((event) => event.event === "preempting"),
    false,
    "lower-priority preempt permission does not override score ordering",
  );
  await waitFor(() => statusOf(lowerPriority).stats.rendered >= 2, 2500);
  lowerPriority.plugin.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(lowerPriority.tempDir, { recursive: true, force: true });

  const preparationRace = createPipelineHarness({ piperDelaySeconds: 0.2 });
  sendNotification(
    preparationRace,
    "notifications.collision.warning",
    vesselNotification("preparing-warning", "Warning preparing first."),
    500,
  );
  await waitFor(() => statusOf(preparationRace).preparing);
  sendNotification(
    preparationRace,
    "notifications.collision.alarm",
    vesselNotification("queued-alarm", "Alarm arrived during synthesis."),
    800,
  );
  const alarmWonRace = await waitFor(
    () => {
      const status = statusOf(preparationRace);
      const starts = status.recentEvents
        .filter((event) => event.event === "speaker-started")
        .map((event) => event.message);
      return starts.length > 0 ? { status, starts } : null;
    },
    3000,
  );
  assert.match(
    alarmWonRace.starts[0],
    /Alarm arrived during synthesis/,
    "higher-priority event queued during lower-priority synthesis gets the speaker first",
  );
  assert.equal(
    alarmWonRace.status.recentEvents.some(
      (event) =>
        event.event === "reprioritized" &&
        event.message.includes("arrived during synthesis"),
    ),
    true,
  );
  await waitFor(() => statusOf(preparationRace).stats.rendered >= 2, 4000);
  preparationRace.plugin.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(preparationRace.tempDir, { recursive: true, force: true });

  const queuedMute = createSlowRenderHarness();
  sendNotification(
    queuedMute,
    "notifications.collision.235900001",
    vesselNotification("235900001", "Traffic advisory. First vessel."),
  );
  const activeTimingStatus = statusOf(queuedMute);
  const firstPending =
    activeTimingStatus.active ||
    activeTimingStatus.preparing ||
    activeTimingStatus.prepared;
  assert.ok(firstPending, "first announcement is being prepared or played");
  assert.ok(firstPending.receivedAt, "receipt timestamp is recorded");
  assert.ok(firstPending.queuedAt, "queue timestamp is recorded");
  assert.ok(
    firstPending.processingStartedAt,
    "processing timestamp is recorded",
  );
  assert.ok(
    Number.isFinite(firstPending.queueWaitMs),
    "queue wait is measured",
  );
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
