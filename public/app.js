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

document.getElementById("buttonSoundCheck").addEventListener("click", () => postJson("sound-check"));
document.getElementById("buttonRepeatLast").addEventListener("click", () => postJson("repeat-last"));
document.getElementById("buttonClearQueue").addEventListener("click", () => postJson("clear-queue"));
document.getElementById("buttonRestartStreams").addEventListener("click", () => postJson("restart-streams"));
document.getElementById("buttonStreamTimeCheck").addEventListener("click", () => postJson("stream-time-check"));
checkPingEnabled.addEventListener("change", () =>
  postJson(`ping-enabled?enabled=${checkPingEnabled.checked ? "true" : "false"}`).catch(
    (error) => {
      renderEvents([{ event: "error", message: error.message, ts: new Date().toISOString() }]);
      refresh();
    },
  ),
);
aplayVolumeRange.addEventListener("input", () => {
  renderAplayVolumeValue(aplayVolumeRange.value);
});
aplayVolumeRange.addEventListener("change", () =>
  postJson(`aplay-volume?volume=${encodeURIComponent(aplayVolumeRange.value)}`).catch(
    (error) => {
      renderEvents([{ event: "error", message: error.message, ts: new Date().toISOString() }]);
      refresh();
    },
  ),
);

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
  const response = await fetch(`/plugins/signalk-ais-plus-audio/${path}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
  return response.json();
}

async function postJson(path, body = null) {
  const response = await fetch(`/plugins/signalk-ais-plus-audio/${path}`, {
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
  queueLength.textContent = status.queueLength ?? 0;
  renderedCount.textContent = status.stats?.rendered ?? 0;
  filteredCount.textContent = status.stats?.filtered ?? 0;
  streamCount.textContent = status.liveStreamClients ?? 0;
  droppedStreamCount.textContent = status.droppedLaggingClients ?? 0;
  serverTime.textContent = formatTime(status.serverTime);
  streamConnectedTotal.textContent = status.streamStats?.connectedTotal ?? 0;
  streamDisconnectedTotal.textContent = status.streamStats?.disconnectedTotal ?? 0;
  checkPingEnabled.checked = status.pingEnabled !== false;
  renderAplayVolumeControl(status);
  audioDirectory.textContent = status.audioDirectory || "";
  streamUrl.textContent =
    status.publicStreamUrl ||
    `${window.location.origin}${status.streamUrl || "/plugins/signalk-ais-plus-audio/live.mp3"}`;
  streamDiagnostics.textContent = formatStreamDiagnostics(status);

  if (status.lastAnnouncement?.message) {
    lastAnnouncement.classList.remove("muted");
    lastAnnouncement.textContent = status.lastAnnouncement.message;
    if (status.lastAnnouncement.audioUrl) {
      lastAudio.hidden = false;
      if (lastAudio.getAttribute("src") !== status.lastAnnouncement.audioUrl) {
        lastAudio.setAttribute("src", status.lastAnnouncement.audioUrl);
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
  const minimum = Number(status.aplayVolumeMinimumPercent) || 25;
  const value = Math.max(minimum, Math.min(100, Number(status.aplayVolumePercent) || 75));
  aplayVolumeRange.min = String(minimum);
  if (document.activeElement !== aplayVolumeRange) {
    aplayVolumeRange.value = String(Math.round(value));
  }
  renderAplayVolumeValue(aplayVolumeRange.value);
  if (status.lastAplayVolumeError) {
    aplayVolumeStatus.textContent = `Last apply failed: ${status.lastAplayVolumeError}`;
    aplayVolumeStatus.classList.add("warning");
  } else {
    const control = status.lastAplayVolumeControl || status.aplayVolumeControl || "PCM";
    aplayVolumeStatus.textContent = status.lastAplayVolumeSetAt
      ? `Applied ${formatTime(status.lastAplayVolumeSetAt)} to ${control}.`
      : `Will apply to ${control} on startup.`;
    aplayVolumeStatus.classList.remove("warning");
  }
}

function renderAplayVolumeValue(value) {
  const numeric = Math.max(Number(aplayVolumeRange.min) || 25, Math.min(100, Number(value) || 75));
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
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
