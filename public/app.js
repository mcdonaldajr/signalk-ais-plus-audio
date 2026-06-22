window.__aisPlusAudioAppStarted = true;

const API = "/signalk/v1/api/aisPlusAudio";
const LOGIN_URL = "/admin/#/login";
const LOGIN_STATUS_URLS = ["/skServer/loginStatus", "/loginStatus"];
const ACCESS_REQUEST_URL = "/signalk/v1/access/requests";
const ACCESS_TOKEN_STORAGE_KEY = "aisPlusAudio.accessToken";
const ACCESS_REQUEST_STORAGE_KEY = "aisPlusAudio.accessRequestHref";
const CLIENT_ID_STORAGE_KEY = "aisPlusAudio.clientId";
const BROWSER_OUTPUT_STORAGE_KEY = "aisPlusAudio.browserOutput";
const BROWSER_OUTPUT_MODE_STORAGE_KEY = "aisPlusAudio.browserOutputMode";
const LEGACY_BROWSER_SPEECH_STORAGE_KEYS = ["checkBrowserSpeech"];
const BROWSER_OUTPUT_MODES = ["off", "speech", "piper"];
const CONSOLE_AUDIO_HOSTED =
  new URLSearchParams(window.location.search).get("consoleAudioHost") === "1";
const REQUEST_TIMEOUT_MS = 8000;
const statusPill = document.getElementById("statusPill");
const queueLength = document.getElementById("queueLength");
const renderedCount = document.getElementById("renderedCount");
const filteredCount = document.getElementById("filteredCount");
const streamCount = document.getElementById("streamCount");
const droppedStreamCount = document.getElementById("droppedStreamCount");
const serverTime = document.getElementById("serverTime");
const streamConnectedTotal = document.getElementById("streamConnectedTotal");
const streamDisconnectedTotal = document.getElementById("streamDisconnectedTotal");
const lastAnnouncement = document.getElementById("lastAnnouncement");
const lastAudio = document.getElementById("lastAudio");
const audioDirectory = document.getElementById("audioDirectory");
const streamUrl = document.getElementById("streamUrl");
const streamDiagnostics = document.getElementById("streamDiagnostics");
const events = document.getElementById("events");
const checkPingEnabled = document.getElementById("checkPingEnabled");
const browserOutputModeInputs = Array.from(
  document.querySelectorAll('input[name="browserOutputMode"]'),
);
const checkPiOutput = document.getElementById("checkPiOutput");
const checkStreamOutput = document.getElementById("checkStreamOutput");
const checkMuteAll = document.getElementById("checkMuteAll");
const outputStatus = document.getElementById("outputStatus");
const aplayVolumeRange = document.getElementById("aplayVolumeRange");
const aplayVolumeValue = document.getElementById("aplayVolumeValue");
const aplayVolumeStatus = document.getElementById("aplayVolumeStatus");
let accessToken = readStoredValue(ACCESS_TOKEN_STORAGE_KEY);
let accessRequestTimer = null;
let localNotice = null;
let browserOutputMode = initialBrowserOutputMode();
let lastBrowserAudioUrl = "";
let lastBrowserSpeechKey = "";
let firstStatusRender = true;

window.addEventListener("error", (event) => {
  renderStartupError(event.message || "Watchkeeper Audio browser script failed");
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason || {};
  renderStartupError(reason.message || String(reason) || "Watchkeeper Audio request failed");
});

document.getElementById("buttonSoundCheck").addEventListener("click", () => {
  postJson("sound-check").catch(renderCommandError);
});
document.getElementById("buttonRepeatLast").addEventListener("click", () => {
  postJson("repeat-last").catch(renderCommandError);
});
document.getElementById("buttonClearQueue").addEventListener("click", () => {
  postJson("clear-queue").catch(renderCommandError);
});
document.getElementById("buttonRestartStreams").addEventListener("click", () => {
  postJson("restart-streams").catch(renderCommandError);
});
document.getElementById("buttonStreamTimeCheck").addEventListener("click", () => {
  postJson("stream-time-check").catch(renderCommandError);
});
checkPingEnabled.addEventListener("change", () => {
  postJson(`ping-enabled?enabled=${checkPingEnabled.checked ? "true" : "false"}`).catch(
    renderCommandError,
  );
});
for (const input of browserOutputModeInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    browserOutputMode = normalizeBrowserOutputMode(input.value);
    saveBrowserOutputMode(browserOutputMode);
    disableCompetingBrowserSpeech();
    outputStatus.textContent = browserOutputModeStatusText(browserOutputMode);
    if (CONSOLE_AUDIO_HOSTED && browserOutputMode !== "off") {
      outputStatus.textContent += " Console will play browser audio while embedded.";
      return;
    }
    if (browserOutputMode === "piper" && lastAudio.getAttribute("src")) {
      playLastAudioInBrowser(true);
    } else if (browserOutputMode === "speech") {
      speakLastAnnouncementInBrowser(true);
    } else {
      stopBrowserOutputs();
    }
  });
}
checkPiOutput.addEventListener("change", saveOutputRouting);
checkStreamOutput.addEventListener("change", saveOutputRouting);
checkMuteAll.addEventListener("change", saveOutputRouting);
aplayVolumeRange.addEventListener("input", () => {
  renderAplayVolumeValue(aplayVolumeRange.value);
});
aplayVolumeRange.addEventListener("change", () => {
  postJson(`aplay-volume?volume=${encodeURIComponent(aplayVolumeRange.value)}`).catch(
    renderCommandError,
  );
});

refresh();
resumeAccessRequestPolling();
setInterval(refresh, 2000);

async function refresh() {
  try {
    const status = await getJson("status");
    renderStatus(status);
  } catch (error) {
    statusPill.textContent = "Offline";
    statusPill.className = "status-pill bad";
    renderEvents([{ event: "error", message: error.message, ts: new Date().toISOString() }]);
  }
}

async function getJson(path) {
  const response = await fetchWithTimeout(`${API}/${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
  return response.json();
}

async function postJson(path, body = null) {
  const response = await fetchWithTimeout(`${API}/${path}`, {
    credentials: "include",
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  await readResponse(response, path);
  await refresh();
}

async function readResponse(response, path) {
  const text = await response.text();
  const body = text ? parseJson(text) : {};
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw await audioAccessError(response.status, body, text);
    }
    throw new Error(body.error || `${path} failed: ${friendlyHttpError(response.status, text)}`);
  }
  return body;
}

function renderStatus(status) {
  statusPill.textContent = status.muted ? "Muted" : status.enabled ? "Ready" : "Disabled";
  statusPill.className = `status-pill ${status.muted || !status.enabled ? "warn" : "good"}`;
  const stats = status.stats || {};
  const streamStats = status.streamStats || {};
  queueLength.textContent = status.queueLength != null ? status.queueLength : 0;
  renderedCount.textContent = stats.rendered != null ? stats.rendered : 0;
  filteredCount.textContent = stats.filtered != null ? stats.filtered : 0;
  streamCount.textContent = status.liveStreamClients != null ? status.liveStreamClients : 0;
  droppedStreamCount.textContent = status.droppedLaggingClients != null ? status.droppedLaggingClients : 0;
  serverTime.textContent = formatTime(status.serverTime);
  streamConnectedTotal.textContent = streamStats.connectedTotal != null ? streamStats.connectedTotal : 0;
  streamDisconnectedTotal.textContent = streamStats.disconnectedTotal != null ? streamStats.disconnectedTotal : 0;
  checkPingEnabled.checked = status.pingEnabled !== false;
  renderOutputRouting(status);
  renderAplayVolumeControl(status);
  audioDirectory.textContent = status.audioDirectory || "";
  streamUrl.textContent =
    status.publicStreamUrl ||
    `${window.location.origin}${status.streamUrl || "/plugins/signalk-ais-plus-audio/live.mp3"}`;
  streamDiagnostics.textContent = formatStreamDiagnostics(status);

  if (status.lastAnnouncement && status.lastAnnouncement.message) {
    lastAnnouncement.classList.remove("muted");
    lastAnnouncement.textContent = status.lastAnnouncement.message;
    const announcementAudioUrl =
      status.lastAnnouncement.publicAudioUrl || status.lastAnnouncement.audioUrl;
    if (announcementAudioUrl) {
      lastAudio.hidden = false;
      if (lastAudio.getAttribute("src") !== announcementAudioUrl) {
        lastAudio.setAttribute("src", announcementAudioUrl);
        playBrowserAnnouncement(false, status.lastAnnouncement);
      }
    } else {
      lastAudio.hidden = true;
      lastAudio.removeAttribute("src");
    }
  } else {
    lastAnnouncement.classList.add("muted");
    lastAnnouncement.textContent = "No announcement received yet.";
    lastAudio.hidden = true;
    lastAudio.removeAttribute("src");
  }

  renderEvents(status.recentEvents || []);
  firstStatusRender = false;
}

async function saveOutputRouting() {
  try {
    outputStatus.textContent = "Saving output routing…";
    await postJson("outputs", {
      muted: checkMuteAll.checked,
      localPlayback: checkPiOutput.checked,
      liveStream: checkStreamOutput.checked,
    });
  } catch (error) {
    renderCommandError(error);
  }
}

function renderOutputRouting(status) {
  disableCompetingBrowserSpeech();
  renderBrowserOutputMode();
  if (document.activeElement !== checkPiOutput) {
    checkPiOutput.checked = status.localPlayback !== false;
  }
  if (document.activeElement !== checkStreamOutput) {
    checkStreamOutput.checked = status.liveStream !== false;
  }
  if (document.activeElement !== checkMuteAll) {
    checkMuteAll.checked = status.pluginMuted === true;
  }
  const mutedReasons = [];
  if (status.pluginMuted) mutedReasons.push("Audio muted here");
  if (status.engineMuted) mutedReasons.push("muted by Traffic Core");
  outputStatus.textContent = [
    `Browser ${browserOutputModeLabel(browserOutputMode)}`,
    `Pi speaker ${status.localPlayback !== false ? "on" : "off"}`,
    `radio stream ${status.liveStream !== false ? "on" : "off"}`,
    mutedReasons.length ? mutedReasons.join(", ") : "not muted",
  ].join(" · ");
}

function initialBrowserOutputMode() {
  const storedMode = normalizeBrowserOutputMode(readStoredValue(BROWSER_OUTPUT_MODE_STORAGE_KEY));
  if (storedMode) return storedMode;
  return readStoredValue(BROWSER_OUTPUT_STORAGE_KEY) === "true" ? "piper" : "off";
}

function normalizeBrowserOutputMode(mode) {
  return BROWSER_OUTPUT_MODES.includes(mode) ? mode : "";
}

function saveBrowserOutputMode(mode) {
  writeStoredValue(BROWSER_OUTPUT_MODE_STORAGE_KEY, mode);
  writeStoredValue(BROWSER_OUTPUT_STORAGE_KEY, mode === "piper" ? "true" : "false");
}

function renderBrowserOutputMode() {
  for (const input of browserOutputModeInputs) {
    input.checked = input.value === browserOutputMode;
  }
}

function disableCompetingBrowserSpeech() {
  for (const key of LEGACY_BROWSER_SPEECH_STORAGE_KEYS) {
    writeStoredValue(key, "false");
  }
}

function browserOutputModeLabel(mode) {
  if (mode === "speech") return "speech synthesis";
  if (mode === "piper") return "Piper playback";
  return "off";
}

function browserOutputModeStatusText(mode) {
  if (mode === "speech") return "Browser speech synthesis selected for this device.";
  if (mode === "piper") return "Watchkeeper Piper browser playback selected for this device.";
  return "Browser output disabled for this device.";
}

function playBrowserAnnouncement(userInitiated, announcement) {
  if (CONSOLE_AUDIO_HOSTED) return;
  if (firstStatusRender && !userInitiated) return;
  if (browserOutputMode === "piper") {
    playLastAudioInBrowser(userInitiated);
  } else if (browserOutputMode === "speech") {
    speakLastAnnouncementInBrowser(userInitiated, announcement);
  }
}

function playLastAudioInBrowser(userInitiated) {
  const audioUrl = lastAudio.getAttribute("src") || "";
  if (!audioUrl || (!userInitiated && audioUrl === lastBrowserAudioUrl)) return;
  lastBrowserAudioUrl = audioUrl;
  lastAudio
    .play()
    .then(() => {
      outputStatus.textContent = userInitiated
        ? "Browser playback enabled and last announcement played."
        : "Browser announcement playback started.";
    })
    .catch((error) => {
      lastBrowserAudioUrl = "";
      outputStatus.textContent =
        `Browser playback needs a tap here first: ${error.message || error}`;
    });
}

function speakLastAnnouncementInBrowser(userInitiated, announcement = null) {
  const message = String(
    announcement?.message || lastAnnouncement.textContent || "",
  ).trim();
  if (!message || message === "No announcement received yet.") return;
  const speech = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!speech || !Utterance) {
    outputStatus.textContent = "Browser speech synthesis is not available on this device.";
    return;
  }
  const speechKey = `${message}:${announcement?.audioUrl || announcement?.publicAudioUrl || ""}`;
  if (!userInitiated && speechKey === lastBrowserSpeechKey) return;
  lastBrowserSpeechKey = speechKey;
  speech.cancel();
  speech.speak(new Utterance(message));
  outputStatus.textContent = userInitiated
    ? "Browser speech synthesis selected and last announcement spoken."
    : "Browser speech synthesis started.";
}

function stopBrowserOutputs() {
  lastAudio.pause();
  lastBrowserAudioUrl = "";
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function renderAplayVolumeControl(status) {
  const minimum = Number(status.aplayVolumeMinimumPercent) || 0;
  const maximum = Number(status.aplayVolumeMaximumPercent) || 100;
  const value = Math.max(
    minimum,
    Math.min(
      maximum,
      Number(
        status.aplayVolumeLevelPercent != null
          ? status.aplayVolumeLevelPercent
          : status.aplayVolumePercent,
      ) || 0,
    ),
  );
  aplayVolumeRange.min = String(minimum);
  aplayVolumeRange.max = String(maximum);
  if (document.activeElement !== aplayVolumeRange) {
    aplayVolumeRange.value = String(Math.round(value));
  }
  renderAplayVolumeValue(aplayVolumeRange.value);
  if (status.lastAplayVolumeError) {
    aplayVolumeStatus.textContent = `Last apply failed: ${status.lastAplayVolumeError}`;
    aplayVolumeStatus.classList.add("warning");
  } else if (!status.aplayVolumeEnabled) {
    aplayVolumeStatus.textContent = "Hardware mixer control is disabled.";
    aplayVolumeStatus.classList.remove("warning");
  } else {
    const control = status.lastAplayVolumeControl || status.aplayVolumeControl || "PCM";
    const mixerPercent = Math.round(
      Number(
        status.aplayMixerVolumePercent != null
          ? status.aplayMixerVolumePercent
          : status.aplayVolumePercent,
      ) || 66,
    );
    aplayVolumeStatus.textContent = status.lastAplayVolumeSetAt
      ? `Applied ${formatTime(status.lastAplayVolumeSetAt)}: ${mixerPercent}% mixer on ${control}.`
      : `Will apply ${mixerPercent}% mixer on ${control} at startup.`;
    aplayVolumeStatus.classList.remove("warning");
  }
}

function renderAplayVolumeValue(value) {
  const minimum = Number(aplayVolumeRange.min) || 0;
  const maximum = Number(aplayVolumeRange.max) || 100;
  const numeric = Math.max(minimum, Math.min(maximum, Number(value) || 0));
  aplayVolumeValue.textContent = `${Math.round(numeric)}%`;
}

function formatStreamDiagnostics(status) {
  const connections = status.liveStreamConnections || [];
  if (connections.length) {
    return connections
      .map(
        (client) =>
          `Client ${client.id} from ${client.remote}, connected ${formatDuration(client.uptimeSeconds)}, buffer ${client.writableLength} bytes`,
      )
      .join(" | ");
  }
  const last = status.streamStats || {};
  if (!last.lastDisconnectedAt) return "No stream clients have connected yet.";
  return `Last disconnect ${formatTime(last.lastDisconnectedAt)} from ${last.lastDisconnectedRemote || "unknown"} after ${formatDuration(last.lastClientUptimeSeconds)}: ${last.lastDisconnectReason || "closed"}`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(value / 60);
  const secs = Math.round(value % 60);
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}

function renderEvents(items) {
  const allItems = localNotice ? [localNotice].concat(items) : items;
  events.classList.toggle("empty", allItems.length === 0);
  events.innerHTML = allItems.length
    ? allItems
        .map(
          (item) => `
            <article>
              <time>${escapeHtml(formatTime(item.ts))}</time>
              <strong>${escapeHtml(item.event)}</strong>
              <span>${escapeHtml(item.message)}</span>
            </article>
          `,
        )
        .join("")
    : "No events yet.";
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCommandError(error) {
  if (error.canRequestAccess) {
    requestSignalKAccess(error.commandLabel || "Watchkeeper Audio control");
    return;
  }
  localNotice = { event: "error", message: error.message, ts: new Date().toISOString() };
  renderEvents([]);
}

function renderStartupError(message) {
  statusPill.textContent = "Error";
  statusPill.className = "status-pill bad";
  renderEvents([
    {
      event: "error",
      message: `Watchkeeper Audio cannot update the page: ${message}`,
      ts: new Date().toISOString(),
    },
  ]);
}

function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (typeof AbortController === "function") {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const fetchOptions = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, fetchOptions)
      .then((response) => {
        window.clearTimeout(timer);
        return response;
      })
      .catch((error) => {
        window.clearTimeout(timer);
        if (error && error.name === "AbortError") {
          throw new Error(`Timed out waiting for ${url}`);
        }
        throw error;
      });
  }

  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(`Timed out waiting for ${url}`)), timeoutMs);
    }),
  ]);
}

function authHeaders(headers = {}) {
  return accessToken
    ? Object.assign({}, headers, { Authorization: `Bearer ${accessToken}` })
    : headers;
}

async function audioAccessError(status, body, text) {
  const loginStatus = await readLoginStatus();
  const error = new Error(audioAccessMessage(status, body, text, loginStatus));
  error.status = status;
  error.canRequestAccess = loginStatus && loginStatus.allowDeviceAccessRequests === true;
  error.loginUrl = LOGIN_URL;
  if (status === 401 && accessToken) {
    accessToken = "";
    removeStoredValue(ACCESS_TOKEN_STORAGE_KEY);
  }
  return error;
}

async function readLoginStatus() {
  for (const url of LOGIN_STATUS_URLS) {
    try {
      const response = await fetchWithTimeout(url, {
        cache: "no-store",
        credentials: "include",
      }, 4000);
      if (response.ok) return await response.json();
    } catch (_error) {
      // Try the next Signal K login-status route.
    }
  }
  return null;
}

function audioAccessMessage(status, body, text, loginStatus) {
  if (body && body.error) return body.error;
  if (loginStatus && loginStatus.authenticationRequired === false) {
    return `Signal K refused Watchkeeper Audio access: ${friendlyHttpError(status, text)}`;
  }
  if (status === 403) {
    return "Watchkeeper Audio controls require Signal K read/write or admin access.";
  }
  if (!loginStatus || loginStatus.status !== "loggedIn") {
    return "Watchkeeper Audio needs a Signal K login or approved device token.";
  }
  const userLevel = (loginStatus && loginStatus.userLevel) || "non-admin";
  return `Watchkeeper Audio controls require Signal K read/write or admin access. Current user level: ${userLevel}.`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return {};
  }
}

function friendlyHttpError(status, text) {
  if (status === 401 || status === 403) {
    return "Signal K login required or this user is not allowed to control Watchkeeper Audio.";
  }
  const cleaned = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || `HTTP ${status}`;
}

async function requestSignalKAccess(label) {
  const pendingHref = readStoredValue(ACCESS_REQUEST_STORAGE_KEY);
  if (pendingHref) {
    pollAccessRequest(pendingHref);
    localNotice = {
      event: "access",
      message: `${label} needs write access. Approve the pending Watchkeeper Audio request in Signal K Access Requests.`,
      ts: new Date().toISOString(),
    };
    renderEvents([]);
    return true;
  }
  try {
    const response = await fetchWithTimeout(ACCESS_REQUEST_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: getClientId(),
        description: "Watchkeeper Audio browser",
        permissions: "readwrite",
      }),
    });
    const text = await response.text();
    const body = text ? parseJson(text) : {};
    if (!response.ok) {
      const duplicate = String(body.message || body.error || text || "").includes(
        "already requested",
      );
      if (!duplicate) {
        throw new Error(body.message || body.error || friendlyHttpError(response.status, text));
      }
    }
    if (body.href) {
      writeStoredValue(ACCESS_REQUEST_STORAGE_KEY, body.href);
      pollAccessRequest(body.href);
    }
    localNotice = {
      event: "access",
      message: `${label} needs write access. Approve Watchkeeper Audio in Signal K Access Requests, then try again.`,
      ts: new Date().toISOString(),
    };
    renderEvents([]);
    return true;
  } catch (requestError) {
    localNotice = {
      event: "error",
      message: `${label} failed: ${requestError.message}`,
      ts: new Date().toISOString(),
    };
    renderEvents([]);
    return true;
  }
}

function resumeAccessRequestPolling() {
  const pendingHref = readStoredValue(ACCESS_REQUEST_STORAGE_KEY);
  if (pendingHref) pollAccessRequest(pendingHref);
}

function pollAccessRequest(href) {
  window.clearTimeout(accessRequestTimer);
  accessRequestTimer = window.setTimeout(async () => {
    try {
      const response = await fetchWithTimeout(href, {
        cache: "no-store",
        credentials: "include",
      }, 4000);
      const body = await response.json();
      if (body.state === "PENDING") {
        pollAccessRequest(href);
        return;
      }
      removeStoredValue(ACCESS_REQUEST_STORAGE_KEY);
      const token = body.accessRequest && body.accessRequest.token;
      if (token) {
        accessToken = token;
        writeStoredValue(ACCESS_TOKEN_STORAGE_KEY, token);
        localNotice = {
          event: "access",
          message: "Watchkeeper Audio write access approved.",
          ts: new Date().toISOString(),
        };
        await refresh();
        return;
      }
      localNotice = {
        event: "access",
        message: "Watchkeeper Audio write access was not approved.",
        ts: new Date().toISOString(),
      };
      renderEvents([]);
    } catch (_error) {
      pollAccessRequest(href);
    }
  }, 2000);
}

function getClientId() {
  const existing = readStoredValue(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clientId = `ais-plus-audio-${generated}`;
  writeStoredValue(CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
}

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch (_error) {
    return "";
  }
}

function writeStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (_error) {
    // Private browsing or locked-down clients can still use an admin session.
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (_error) {
    // Ignore storage failures.
  }
}
