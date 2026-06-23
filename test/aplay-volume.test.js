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
    speakerReleaseGapMs: 10,
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
  const audioSequence = harness.brokerSequence;
  const audioRequest = value?.data?.audioRequest || {
    requestId: `test-broker:${audioSequence}`,
  };
  const audioEvent = {
    schemaVersion: 1,
    provider: "ais-plus",
    subjectKey: pathName,
    eventId: alertEvent.id || `${pathName}-${audioSequence}`,
    lifecycle,
    timestamp: new Date().toISOString(),
    audioSequence,
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
  };
  harness.subscriptionCallbacks[0]({
    updates: [
      {
        values: [
          {
            path: "plugins.notificationsPlus",
            value: {
              active: activeSubjects.map((subjectKey) => ({ subjectKey })),
            },
          },
          {
            path: "plugins.notificationsPlus.audio",
            value: {
              contract: "notifications-plus-audio-delivery",
              contractVersion: 1,
              sessionId: "test-broker-session",
              sequence: audioSequence,
              audioSequence,
              audioRequest,
              event: audioEvent,
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

function sendEngineAudioPolicy(harness, {
  muted,
  sequence,
  sessionId = "engine-session",
  correlationId = "engine-policy",
} = {}) {
  harness.subscriptionCallbacks[0]({
    updates: [
      {
        values: [
          {
            path: "plugins.aisPlusEngine.audioPolicy",
            value: {
              contract: "ais-plus-engine-audio-policy",
              contractVersion: 1,
              sessionId,
              sequence,
              correlationId,
              mode: "engine",
              authoritative: true,
              muted,
            },
          },
        ],
      },
    ],
  });
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

async function postOutputs(harness, body) {
  let responseBody;
  await harness.posts.get("/outputs")(
    { body },
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        responseBody = { statusCode: this.statusCode, ...value };
      },
    },
  );
  return responseBody;
}

async function postRepeatLast(harness) {
  let responseBody;
  await harness.posts.get("/repeat-last")(
    {},
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        responseBody = { statusCode: this.statusCode, ...value };
      },
    },
  );
  return responseBody;
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const browserApp = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const browserCss = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(html, /Output routing/);
  assert.match(html, /browserOutputOff/);
  assert.match(html, /browserOutputSpeech/);
  assert.match(html, /browserOutputPiper/);
  assert.match(html, /checkPiOutput/);
  assert.match(html, /checkStreamOutput/);
  assert.match(html, /checkMuteAll/);
  assert.match(browserApp, /BROWSER_OUTPUT_MODE_STORAGE_KEY/);
  assert.match(browserApp, /BROWSER_OUTPUT_MODES/);
  assert.match(browserApp, /CONSOLE_AUDIO_HOSTED/);
  assert.match(browserApp, /consoleAudioHost/);
  assert.match(browserApp, /LEGACY_BROWSER_SPEECH_STORAGE_KEYS/);
  assert.match(browserApp, /checkBrowserSpeech/);
  assert.match(browserApp, /disableCompetingBrowserSpeech/);
  assert.match(browserApp, /speakLastAnnouncementInBrowser/);
  assert.doesNotMatch(browserApp, /muted by notification provider/);
  assert.doesNotMatch(browserApp, /muted by AIS Plus/);
  assert.match(browserApp, /bindCommandButton/);
  assert.match(browserApp, /signalCommandButton/);
  assert.match(browserApp, /postJson\("outputs"/);
  assert.match(browserCss, /button\.command-sent/);
  assert.match(browserCss, /transform:\s*translateY\(4px\)/);
  assert.match(browserCss, /box-shadow/);

  const defaults = createHarness();
  assert.deepEqual(
    {
      level: statusOf(defaults).aplayVolumeLevelPercent,
      mixer: statusOf(defaults).aplayMixerVolumePercent,
    },
    { level: 53, mixer: 75 },
  );
  defaults.plugin.stop();

  const stateOnly = createHarness();
  stateOnly.subscriptionCallbacks[0]({
    updates: [
      {
        values: [
          {
            path: "plugins.notificationsPlus",
            value: {
              sessionId: "state-only-session",
              audioSequence: 1,
              audioRequest: { requestId: "sticky-legacy-request" },
              lastAudioEvent: {
                eventId: "sticky-legacy-event",
                timestamp: new Date().toISOString(),
                delivery: { audio: true },
                priority: { level: "information", score: 100 },
                presentation: { message: "Sticky state projection should not speak." },
              },
              active: [],
            },
          },
        ],
      },
    ],
  });
  assert.equal(
    statusOf(stateOnly).stats.queued,
    0,
    "sticky broker state projections do not queue audio",
  );
  stateOnly.plugin.stop();

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

  const outputRouting = createHarness({
    muted: false,
    localPlayback: true,
    liveStream: true,
  });
  const outputBody = await postOutputs(outputRouting, {
    muted: true,
    localPlayback: false,
    liveStream: false,
  });
  assert.equal(outputBody.statusCode, 200);
  assert.deepEqual(outputBody.outputs, {
    muted: true,
    localPlayback: false,
    liveStream: false,
  });
  assert.equal(statusOf(outputRouting).pluginMuted, true);
  assert.equal(statusOf(outputRouting).localPlayback, false);
  assert.equal(statusOf(outputRouting).liveStream, false);
  assert.equal(outputRouting.savedOptions.at(-1).muted, true);
  assert.equal(outputRouting.savedOptions.at(-1).localPlayback, false);
  assert.equal(outputRouting.savedOptions.at(-1).liveStream, false);
  outputRouting.plugin.stop();

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
  const waitingPipelineStatus = await waitFor(() => {
    const status = statusOf(pipeline);
    return status.active && status.queueLength >= 1 ? status : null;
  });
  assert.equal(
    waitingPipelineStatus.active.message,
    "First pipeline announcement.",
    "higher-priority announcement does not interrupt current speaker playback",
  );
  assert.equal(
    waitingPipelineStatus.recentEvents.some((event) => event.event === "preempting"),
    false,
  );
  const completedPipelineStatus = await waitFor(
    () => {
      const status = statusOf(pipeline);
      return status.stats.rendered >= 2 ? status : null;
    },
    8000,
  );
  const pipelineStarts = completedPipelineStatus.recentEvents
    .slice()
    .reverse()
    .filter((event) => event.event === "speaker-started")
    .map((event) => event.message);
  assert.match(pipelineStarts[0], /First pipeline announcement/);
  assert.match(pipelineStarts[1], /Second pipeline announcement/);
  assert.equal(
    completedPipelineStatus.stats.failed,
    0,
    "queued priority handoff is not counted as a rendering failure",
  );
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
    return status.active && status.queueLength >= 1 ? status : null;
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
    return status.active && status.queueLength >= 1 ? status : null;
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
  const synthesisRaceStatus = await waitFor(
    () => (statusOf(preparationRace).stats.rendered >= 2 ? statusOf(preparationRace) : null),
    5000,
  );
  const synthesisStarts = synthesisRaceStatus.recentEvents
    .slice()
    .reverse()
    .filter((event) => event.event === "speaker-started")
    .map((event) => event.message);
  assert.match(
    synthesisStarts[0],
    /Warning preparing first/,
    "an announcement already in synthesis keeps the speaker lane",
  );
  assert.match(synthesisStarts[1], /Alarm arrived during synthesis/);
  assert.equal(
    synthesisRaceStatus.recentEvents.some((event) => event.event === "reprioritized"),
    false,
  );
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
  assert.ok(statusOf(queuedMute).queueLength >= 2);
  assert.equal(statusOf(queuedMute).aisPlusMuted, false);
  assert.equal(statusOf(queuedMute).muted, false);
  assert.equal(
    statusOf(queuedMute).recentEvents.filter((event) => event.event === "queue-cleared").length,
    0,
    "provider mute does not clear the queue",
  );
  sendNotification(
    queuedMute,
    "notifications.collision.soundState",
    soundStateNotification(true),
  );
  assert.equal(
    statusOf(queuedMute).recentEvents.filter((event) => event.event === "queue-cleared").length,
    0,
    "repeated provider mute is ignored by Audio",
  );
  sendNotification(
    queuedMute,
    "notifications.collision.235900004",
    vesselNotification("235900004", "Traffic advisory. Fourth vessel."),
  );
  assert.ok(statusOf(queuedMute).queueLength >= 3);
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

  const duplicateRequest = createHarness();
  const duplicatedNotification = vesselNotification(
    "duplicate-audio",
    "This duplicate should only queue once.",
  );
  duplicatedNotification.data.audioRequest = {
    requestId: "same-notifications-plus-request",
  };
  sendNotification(
    duplicateRequest,
    "notifications.collision.duplicate",
    duplicatedNotification,
  );
  assert.equal(statusOf(duplicateRequest).stats.queued, 1);
  sendNotification(
    duplicateRequest,
    "notifications.collision.duplicate",
    duplicatedNotification,
  );
  assert.equal(
    statusOf(duplicateRequest).stats.queued,
    1,
    "same Notifications Plus requestId is not queued twice",
  );
  assert.equal(statusOf(duplicateRequest).stats.filtered, 1);
  duplicateRequest.plugin.stop();

  const duplicateEvent = createHarness();
  const duplicatedEventNotification = vesselNotification(
    "duplicate-event",
    "This event should only queue once.",
  );
  duplicatedEventNotification.data.alertEvent.id = "stable-provider-event";
  sendNotification(
    duplicateEvent,
    "notifications.collision.duplicate-event",
    duplicatedEventNotification,
  );
  assert.equal(statusOf(duplicateEvent).stats.queued, 1);
  duplicatedEventNotification.data.audioRequest = {
    requestId: "new-broker-request-after-republish",
  };
  sendNotification(
    duplicateEvent,
    "notifications.collision.duplicate-event",
    duplicatedEventNotification,
  );
  assert.equal(
    statusOf(duplicateEvent).stats.queued,
    1,
    "same provider eventId is not queued twice after a broker request id changes",
  );
  assert.equal(statusOf(duplicateEvent).stats.filtered, 1);
  duplicateEvent.plugin.stop();

  const mutedSkip = createHarness({ muted: true });
  sendNotification(
    mutedSkip,
    "notifications.system.gps-received",
    vesselNotification("gps-received", "GPS received."),
  );
  assert.equal(statusOf(mutedSkip).lastAnnouncement, null);
  const mutedSkipRepeat = await postRepeatLast(mutedSkip);
  assert.equal(mutedSkipRepeat.statusCode, 404);
  mutedSkip.plugin.stop();

  const mutedRepeat = createHarness({ localPlayback: false, liveStream: false });
  sendNotification(
    mutedRepeat,
    "notifications.system.first-repeatable",
    vesselNotification("first-repeatable", "First repeatable announcement."),
  );
  assert.equal(statusOf(mutedRepeat).stats.queued, 1);
  assert.equal(statusOf(mutedRepeat).lastAnnouncement.message, "First repeatable announcement.");
  await postOutputs(mutedRepeat, { muted: true });
  const beforeRepeat = statusOf(mutedRepeat).stats.queued;
  const mutedRepeatBody = await postRepeatLast(mutedRepeat);
  assert.equal(mutedRepeatBody.statusCode, 409);
  assert.match(mutedRepeatBody.error, /muted/i);
  assert.equal(statusOf(mutedRepeat).stats.queued, beforeRepeat);
  mutedRepeat.plugin.stop();

  const muteStopsPlayback = createPipelineHarness();
  sendNotification(
    muteStopsPlayback,
    "notifications.system.long-playback",
    vesselNotification("long-playback", "This playback should stop when muted."),
  );
  await waitFor(() => statusOf(muteStopsPlayback).active);
  const muteStopsBody = await postOutputs(muteStopsPlayback, { muted: true });
  assert.equal(muteStopsBody.statusCode, 200);
  await waitFor(() =>
    statusOf(muteStopsPlayback).recentEvents.some(
      (event) => event.event === "speaker-stopped",
    ),
  );
  await waitFor(() => !statusOf(muteStopsPlayback).active);
  assert.equal(statusOf(muteStopsPlayback).stats.failed, 0);
  muteStopsPlayback.plugin.stop();
  fs.rmSync(muteStopsPlayback.tempDir, { recursive: true, force: true });

  const engineMute = createHarness();
  sendEngineAudioPolicy(engineMute, { muted: true, sequence: 1 });
  assert.equal(statusOf(engineMute).engineMuted, true);
  assert.equal(statusOf(engineMute).muted, true);
  sendNotification(
    engineMute,
    "notifications.collision.engine-muted",
    vesselNotification("engine-muted", "This must remain silent."),
  );
  assert.equal(statusOf(engineMute).queueLength, 0);
  sendEngineAudioPolicy(engineMute, { muted: false, sequence: 2 });
  assert.equal(statusOf(engineMute).engineMuted, false);
  assert.equal(statusOf(engineMute).muted, false);
  sendEngineAudioPolicy(engineMute, { muted: true, sequence: 1 });
  assert.equal(
    statusOf(engineMute).engineMuted,
    false,
    "non-monotonic Engine Audio Policy sequence is ignored",
  );
  engineMute.plugin.stop();

  const emptyProviderMute = createHarness();
  sendNotification(
    emptyProviderMute,
    "notifications.collision.soundState",
    soundStateNotification(true),
  );
  assert.equal(statusOf(emptyProviderMute).muted, false);
  assert.equal(statusOf(emptyProviderMute).aisPlusMuted, false);
  assert.equal(emptyProviderMute.savedOptions.length, 0);
  assert.equal(
    statusOf(emptyProviderMute).recentEvents.some(
      (event) =>
        event.event === "queue-cleared" &&
        event.message.includes("Provider muted audio"),
    ),
    false,
    "provider mute does not log a no-op queue clear when nothing was pending",
  );
  emptyProviderMute.plugin.stop();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
