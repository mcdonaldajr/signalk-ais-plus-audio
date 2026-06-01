window.__aisPlusAudioAppStarted = true;

const API = "/signalk/v1/api/aisPlusAudio";
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
const aplayVolumeRange = document.getElementById("aplayVolumeRange");
const aplayVolumeValue = document.getElementById("aplayVolumeValue");
const aplayVolumeStatus = document.getElementById("aplayVolumeStatus");

window.addEventListener("error", (event) => {
  renderStartupError(event.message || "AIS Plus Audio browser script failed");
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason || {};
  renderStartupError(reason.message || String(reason) || "AIS Plus Audio request failed");
});

document.getElementById("buttonSoundCheck").addEventListener("click", () => postJson("sound-check"));
document.getElementById("buttonRepeatLast").addEventListener("click", () => postJson("repeat-last"));
document.getElementById("buttonClearQueue").addEventListener("click", () => postJson("clear-queue"));
document.getElementById("buttonRestartStreams").addEventListener("click", () => postJson("restart-streams"));
document.getElementById("buttonStreamTimeCheck").addEventListener("click", () => postJson("stream-time-check"));
checkPingEnabled.addEventListener("change", () => {
  postJson(`ping-enabled?enabled=${checkPingEnabled.checked ? "true" : "false"}`).catch(
    renderCommandError,
  );
});
aplayVolumeRange.addEventListener("input", () => {
  renderAplayVolumeValue(aplayVolumeRange.value);
});
aplayVolumeRange.addEventListener("change", () => {
  postJson(`aplay-volume?volume=${encodeURIComponent(aplayVolumeRange.value)}`).catch(
    renderCommandError,
  );
});

refresh();
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
  });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
  return response.json();
}

async function postJson(path, body = null) {
  const response = await fetchWithTimeout(`${API}/${path}`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${path} failed: HTTP ${response.status}`);
  }
  await refresh();
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
  events.classList.toggle("empty", items.length === 0);
  events.innerHTML = items.length
    ? items
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
  renderEvents([{ event: "error", message: error.message, ts: new Date().toISOString() }]);
  refresh();
}

function renderStartupError(message) {
  statusPill.textContent = "Error";
  statusPill.className = "status-pill bad";
  renderEvents([
    {
      event: "error",
      message: `AIS Plus Audio cannot update the page: ${message}`,
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
