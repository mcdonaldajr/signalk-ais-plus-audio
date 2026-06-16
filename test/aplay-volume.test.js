const assert = require("node:assert/strict");
const os = require("node:os");
const createPlugin = require("../plugin");

function createHarness(initialOptions = {}, harnessOptions = {}) {
  const savedOptions = [];
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
      subscribe() {},
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

  return { plugin, savedOptions, posts, gets };
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
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
