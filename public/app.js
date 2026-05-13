const $ = (id) => document.getElementById(id);

const store = {
  get(roomId) {
    try {
      return JSON.parse(localStorage.getItem(`gr:${roomId}`) || "null");
    } catch { return null; }
  },
  set(roomId, data) {
    localStorage.setItem(`gr:${roomId}`, JSON.stringify(data));
  },
};

let socket = null;
let me = { roomId: null, memberId: null, isHost: false, name: "" };
let latest = null;

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

async function createRoom() {
  const name = $("name").value.trim() || "Host";
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) { $("lobbyErr").textContent = "couldn't create room"; return; }
  const { roomId, hostId, hostToken } = await res.json();
  store.set(roomId, { memberId: hostId, hostToken, name });
  location.hash = roomId;
  enterRoom(roomId, name, { hostToken });
}

function joinRoom() {
  const code = $("joinCode").value.trim().toUpperCase();
  const name = $("name").value.trim();
  if (!code) { $("lobbyErr").textContent = "enter a room code"; return; }
  if (!name) { $("lobbyErr").textContent = "enter your name"; return; }
  location.hash = code;
  enterRoom(code, name, {});
}

function enterRoom(roomId, name, { hostToken } = {}) {
  $("lobbyErr").textContent = "";
  const saved = store.get(roomId) || {};
  const memberId = saved.memberId;
  hostToken = hostToken || saved.hostToken;
  me = { roomId, memberId: null, isHost: false, name: name || saved.name || "Anon" };

  socket = io();
  socket.emit("join", { roomId, name: me.name, memberId, hostToken }, (resp) => {
    if (resp?.error) {
      $("lobbyErr").textContent = resp.error;
      socket.disconnect();
      location.hash = "";
      return;
    }
    me.memberId = resp.memberId;
    me.isHost = !!resp.isHost;
    store.set(roomId, {
      memberId: resp.memberId,
      hostToken: hostToken || saved.hostToken,
      name: me.name,
    });

    hide($("lobby"));
    show($("room"));
    $("roomId").textContent = roomId;
    $("youAre").textContent = `you: ${me.name}${me.isHost ? " (host)" : ""}`;
    if (me.isHost) {
      show($("settingsBtn"));
      show($("hostRow"));
    }
  });

  let prevState = null;
  socket.on("state", (s) => {
    const prevFmt = latest?.settings?.format;
    latest = s;
    if (prevState === "revealed" && s.state === "collecting") {
      guessRaw = "";
      $("guess").value = "";
    }
    if (prevFmt && prevFmt !== s.settings.format) repaintGuess();
    prevState = s.state;
    render();
  });
}

function formatNum(n, format) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  switch (format) {
    case "dollars":
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: "USD", maximumFractionDigits: 2,
      }).format(n);
    case "euros":
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: "EUR", maximumFractionDigits: 2,
      }).format(n);
    case "pounds":
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: "GBP", maximumFractionDigits: 2,
      }).format(n);
    case "percent":
      return `${(Math.round(n * 100) / 100).toLocaleString()}%`;
    default: {
      const rounded = Math.round(n * 100) / 100;
      return rounded.toLocaleString();
    }
  }
}

function render() {
  if (!latest) return;
  const s = latest;
  const fmt = (n) => formatNum(n, s.settings.format);
  const revealed = s.state === "revealed";
  const stateEl = $("stateLabel");
  stateEl.textContent = revealed ? "revealed" : "collecting";
  stateEl.classList.toggle("revealed", revealed);
  const submittedCount = s.members.filter((m) => m.submitted).length;
  $("counts").textContent = `${submittedCount}/${s.members.length} ready`;

  // settings checkboxes
  $("setShowByPerson").checked = !!s.settings.showByPerson;
  $("setDropExtremes").checked = !!s.settings.dropExtremes;
  $("setFormat").value = s.settings.format || "number";

  // member tiles
  const ul = $("members");
  ul.innerHTML = "";
  for (const m of s.members) {
    const li = document.createElement("li");
    const tags = [];
    if (m.id === me.memberId) tags.push(`<span class="you-tag">you</span>`);
    if (m.isHost) tags.push(`<span class="host-tag">host</span>`);

    let bottom = "";
    if (revealed && s.guesses && s.guesses[m.id] !== undefined) {
      li.classList.add("revealed");
      if (s.settings.showByPerson) {
        const dropped =
          s.settings.dropExtremes && s.summary &&
          s.summary.dropped.includes(s.guesses[m.id]);
        bottom = `<div class="m-guess ${dropped ? "dropped" : ""}">${fmt(s.guesses[m.id])}</div>`;
      } else {
        bottom = `<div class="m-status">submitted</div>`;
      }
    } else if (revealed) {
      bottom = `<div class="m-status">no guess</div>`;
    } else {
      if (m.submitted) li.classList.add("submitted");
      bottom = `<div class="m-status">${m.submitted ? "ready ✓" : "thinking…"}</div>`;
    }

    li.innerHTML = `
      <div class="m-name">${escapeHtml(m.name)} ${tags.join(" ")}</div>
      ${bottom}
    `;
    ul.appendChild(li);
  }

  // result
  if (s.state === "revealed" && s.summary) {
    show($("result"));
    if (s.summary.average === null) {
      $("avg").textContent = "—";
      $("avgDetail").textContent = "no guesses";
    } else {
      $("avg").textContent = fmt(s.summary.average);
      const parts = [`${s.summary.count} guess${s.summary.count === 1 ? "" : "es"}`];
      if (s.settings.dropExtremes && s.summary.dropped.length) {
        parts.push(`dropped ${s.summary.dropped.map(fmt).join(" & ")}`);
      }
      $("avgDetail").textContent = parts.join(" · ");
    }
    hide($("guessArea"));
  } else {
    hide($("result"));
    show($("guessArea"));
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// wire up
$("create").addEventListener("click", createRoom);
$("join").addEventListener("click", joinRoom);

let guessRaw = "";

function sanitizeRaw(s) {
  let out = "";
  let sawDot = false;
  let sawMinus = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "-" && out.length === 0 && !sawMinus) { out += "-"; sawMinus = true; }
    else if (c >= "0" && c <= "9") out += c;
    else if (c === "." && !sawDot) { out += "."; sawDot = true; }
  }
  return out;
}

function formatGuessDisplay(raw, format) {
  if (raw === "" || raw === "-" || raw === "." || raw === "-.") return raw;
  const endsWithDot = raw.endsWith(".");
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;

  // figure out fraction digits actually typed so we preserve trailing zeros like 12.50
  const dotIdx = raw.indexOf(".");
  const typedFrac = dotIdx === -1 ? 0 : raw.length - dotIdx - 1;
  const frac = Math.min(typedFrac, format === "percent" || format === "number" ? 6 : 2);

  let body;
  switch (format) {
    case "dollars":
    case "euros":
    case "pounds": {
      const currency = format === "dollars" ? "USD" : format === "euros" ? "EUR" : "GBP";
      body = new Intl.NumberFormat(undefined, {
        style: "currency", currency, minimumFractionDigits: frac, maximumFractionDigits: frac,
      }).format(n);
      break;
    }
    case "percent": {
      body = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: frac, maximumFractionDigits: frac,
      }).format(n) + "%";
      break;
    }
    default: {
      body = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: frac, maximumFractionDigits: frac,
      }).format(n);
    }
  }

  if (endsWithDot && !body.includes(".") && !body.includes(",")) body += ".";
  return body;
}

function repaintGuess() {
  const input = $("guess");
  const fmt = latest?.settings?.format || "number";
  input.value = formatGuessDisplay(guessRaw, fmt);
}

$("guess").addEventListener("input", (e) => {
  guessRaw = sanitizeRaw(e.target.value);
  repaintGuess();
  // keep caret at end - simpler and predictable when length changes
  const len = e.target.value.length;
  e.target.setSelectionRange(len, len);
});

$("submitBtn").addEventListener("click", () => {
  if (guessRaw === "" || guessRaw === "-" || guessRaw === "." || guessRaw === "-.") return;
  const n = Number(guessRaw);
  if (!Number.isFinite(n)) return;
  socket.emit("submit", { value: n }, (r) => {
    if (r?.error) alert(r.error);
  });
});

$("unsubmitBtn").addEventListener("click", () => {
  socket.emit("unsubmit", {}, () => {});
  guessRaw = "";
  $("guess").value = "";
});

$("revealBtn").addEventListener("click", () => {
  socket.emit("reveal", {}, (r) => { if (r?.error) alert(r.error); });
});

$("nextBtn").addEventListener("click", () => {
  socket.emit("next", {}, () => { $("guess").value = ""; });
});

function openSettings() {
  $("settingsModal").classList.remove("hidden");
  $("settingsModal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeSettings() {
  $("settingsModal").classList.add("hidden");
  $("settingsModal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
$("settingsBtn").addEventListener("click", openSettings);
$("settingsModal").addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settingsModal").classList.contains("hidden")) closeSettings();
});

function emitSettings() {
  socket.emit("settings", {
    settings: {
      showByPerson: $("setShowByPerson").checked,
      dropExtremes: $("setDropExtremes").checked,
      format: $("setFormat").value,
    },
  });
}
for (const id of ["setShowByPerson", "setDropExtremes", "setFormat"]) {
  $(id).addEventListener("change", emitSettings);
}

$("copyLink").addEventListener("click", async () => {
  const url = `${location.origin}/#${me.roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    $("copyLink").textContent = "copied";
    setTimeout(() => ($("copyLink").textContent = "copy link"), 1500);
  } catch {}
});

// auto-join from hash
if (location.hash.length > 1) {
  const code = location.hash.slice(1).toUpperCase();
  $("joinCode").value = code;
}
