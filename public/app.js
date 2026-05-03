const statusPill = document.getElementById("statusPill");
const queueLength = document.getElementById("queueLength");
const renderedCount = document.getElementById("renderedCount");
const filteredCount = document.getElementById("filteredCount");
const streamCount = document.getElementById("streamCount");
const droppedStreamCount = document.getElementById("droppedStreamCount");
const lastAnnouncement = document.getElementById("lastAnnouncement");
const lastAudio = document.getElementById("lastAudio");
const audioDirectory = document.getElementById("audioDirectory");
const streamUrl = document.getElementById("streamUrl");
const events = document.getElementById("events");

document.getElementById("buttonSoundCheck").addEventListener("click", () => postJson("sound-check"));
document.getElementById("buttonRepeatLast").addEventListener("click", () => postJson("repeat-last"));
document.getElementById("buttonClearQueue").addEventListener("click", () => postJson("clear-queue"));
document.getElementById("buttonRestartStreams").addEventListener("click", () => postJson("restart-streams"));

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

async function postJson(path) {
  const response = await fetch(`/plugins/signalk-ais-plus-audio/${path}`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  audioDirectory.textContent = status.audioDirectory || "";
  streamUrl.textContent =
    status.publicStreamUrl ||
    `${window.location.origin}${status.streamUrl || "/plugins/signalk-ais-plus-audio/live.mp3"}`;

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
