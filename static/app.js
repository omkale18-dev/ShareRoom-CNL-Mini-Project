const $ = (id) => document.getElementById(id);
let room = "",
  key = "",
  ws = null,
  expiry = 0,
  heartbeat = null,
  ticker = null,
  busy = false,
  session = 0,
  displayName = "Guest",
  toastTimer;
const toast = (message) => {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
};
async function api(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw Error(
        "The server returned an unexpected response. Please try again.",
      );
    }
    if (!response.ok)
      throw Error(
        typeof data.detail === "string"
          ? data.detail
          : "Please check the entered values.",
      );
    return data;
  } catch (error) {
    if (error.name === "AbortError")
      throw Error("The request timed out. Please try again.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const endpoint = () => `/api/rooms/${encodeURIComponent(room)}`;
const auth = () => `key=${encodeURIComponent(key)}`;
function setTab(mode, focus = false) {
  for (const name of ["create", "join"]) {
    const active = name === mode;
    $(name + "-tab").setAttribute("aria-selected", String(active));
    $(name + "-tab").tabIndex = active ? 0 : -1;
    $(name + "-panel").hidden = !active;
  }
  $("entry-error").hidden = true;
  if (focus) $(mode + "-tab").focus();
}
for (const name of ["create", "join"]) {
  $(name + "-tab").onclick = () => setTab(name);
  $(name + "-tab").onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setTab(
        event.key === "Home"
          ? "create"
          : event.key === "End"
            ? "join"
            : name === "create"
              ? "join"
              : "create",
        true,
      );
    }
  };
}
function addMessage(message) {
  if (document.getElementById("message-" + message.id)) return;
  const div = document.createElement("div");
  div.id = "message-" + message.id;
  div.className = "msg";
  const author = document.createElement("strong");
  author.textContent = message.sender || "Guest";
  const body = document.createElement("span");
  body.textContent = message.text;
  const time = document.createElement("small");
  time.textContent = new Date(message.created * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  div.append(author, body, time);
  $("messages").append(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}
function addFile(file) {
  if (document.getElementById("file-" + file.id)) return;
  const div = document.createElement("div");
  div.className = "fileitem";
  div.id = "file-" + file.id;
  const link = document.createElement("a");
  link.textContent = file.name + " ↓";
  link.href = `${endpoint()}/files/${encodeURIComponent(file.id)}?${auth()}`;
  link.download = file.name;
  link.title = "Download " + file.name;
  const meta = document.createElement("small");
  meta.textContent =
    file.size >= 1048576
      ? (file.size / 1048576).toFixed(1) + " MB"
      : (file.size / 1024).toFixed(1) + " KB";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Integrity hash";
  const hash = document.createElement("small");
  hash.textContent = file.sha256;
  details.append(summary, hash);
  div.append(link, meta, details);
  $("files").append(div);
}
function stop() {
  session++;
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onopen = null;
    ws.close();
    ws = null;
  }
  clearInterval(heartbeat);
  clearInterval(ticker);
  $("send").disabled = true;
}
function updateExpiry() {
  const seconds = Math.max(0, Math.ceil(expiry - Date.now() / 1000));
  $("expiry").textContent =
    seconds >= 60 ? Math.ceil(seconds / 60) + " min" : seconds + " sec";
  if (!seconds) {
    stop();
    $("status").textContent = "Room expired. Create a new room to continue.";
    $("reconnect").hidden = true;
    $("upload").disabled = true;
  }
}
async function enter(code, secret) {
  const candidate = code.trim().toUpperCase();
  secret = secret.trim();
  if (!/^[A-Z0-9]{6}$/.test(candidate) || !secret)
    throw Error("Enter a six-character room code and its access key.");
  const data = await api(
    `/api/rooms/${encodeURIComponent(candidate)}?key=${encodeURIComponent(secret)}`,
  );
  stop();
  room = candidate;
  key = secret;
  expiry = data.expires_at;
  $("landing").hidden = true;
  $("room").hidden = false;
  $("code").textContent = room;
  $("room-title").textContent = data.name || "Your room";
  $("status").textContent = "Connecting…";
  $("users").textContent = "0";
  $("latency").textContent = "—";
  $("uploadstatus").textContent = "";
  $("uploadform").reset();
  $("message").value = "";
  $("upload").disabled = false;
  $("invite-fallback").hidden = true;
  $("invite").value =
    `${location.origin}/#${encodeURIComponent(room)}.${encodeURIComponent(key)}`;
  $("messages").replaceChildren();
  $("files").replaceChildren();
  data.messages.forEach(addMessage);
  data.files.forEach(addFile);
  history.replaceState(null, "", `#${room}.${key}`);
  connectSocket();
  ticker = setInterval(updateExpiry, 1000);
  updateExpiry();
  $("message").focus();
}
function connectSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(
    `${protocol}://${location.host}/ws/${room}?${auth()}`,
  );
  ws = socket;
  const current = session;
  $("reconnect").hidden = true;
  socket.onopen = () => {
    if (current !== session) return;
    $("status").textContent = "Connected";
    $("send").disabled = false;
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "ping", sent: Date.now() }));
    }, 4000);
  };
  socket.onclose = () => {
    if (current !== session) return;
    clearInterval(heartbeat);
    $("status").textContent = "Connection lost. Reconnect to continue.";
    $("users").textContent = "—";
    $("latency").textContent = "—";
    $("send").disabled = true;
    $("reconnect").hidden = false;
  };
  socket.onmessage = (event) => {
    if (current !== session) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "message") addMessage(message);
    if (message.type === "file") addFile(message);
    if (message.type === "presence") $("users").textContent = message.count;
    if (message.type === "pong")
      $("latency").textContent =
        Math.max(0, Date.now() - Number(message.sent)) + " ms";
    if (message.type === "error") toast(message.message);
  };
}
async function withEntry(action) {
  if (busy) return;
  busy = true;
  $("create").disabled = $("join").disabled = true;
  $("entry-error").hidden = true;
  const button = $($("create-panel").hidden ? "join" : "create");
  const old = button.textContent;
  button.textContent = "Connecting…";
  try {
    await action();
  } catch (error) {
    $("entry-error").textContent = error.message;
    $("entry-error").hidden = false;
  } finally {
    busy = false;
    $("create").disabled = $("join").disabled = false;
    button.textContent = old;
  }
}
$("createform").onsubmit = (event) => {
  event.preventDefault();
  withEntry(async () => {
    displayName = $("create-name").value.trim();
    const name = $("room-name").value.trim();
    if (!displayName || !name) throw Error("Enter your name and a room name.");
    const data = await api("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    // Keep a successfully created invite available if the follow-up request fails.
    $("joincode").value = data.code;
    $("joinkey").value = data.key;
    $("join-name").value = displayName;
    history.replaceState(null, "", `#${data.code}.${data.key}`);
    try {
      await enter(data.code, data.key);
    } catch (error) {
      setTab("join");
      throw error;
    }
  });
};
$("joinform").onsubmit = (event) => {
  event.preventDefault();
  withEntry(async () => {
    displayName = $("join-name").value.trim();
    if (!displayName) throw Error("Enter your name.");
    await enter($("joincode").value, $("joinkey").value);
  });
};
$("reconnect").onclick = async () => {
  if (busy) return;
  busy = true;
  $("reconnect").disabled = true;
  try {
    await enter(room, key);
  } catch (error) {
    toast(error.message);
  } finally {
    busy = false;
    $("reconnect").disabled = false;
  }
};
$("leave").onclick = () => {
  stop();
  room = "";
  key = "";
  history.replaceState(null, "", location.pathname);
  $("room").hidden = true;
  $("landing").hidden = false;
  $("messages").replaceChildren();
  $("files").replaceChildren();
  $("create-tab").focus();
};
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("invite").value);
    toast("Invite copied");
  } catch {
    $("invite-fallback").hidden = false;
    $("invite").focus();
    $("invite").select();
    toast("Press Ctrl+C or copy the selected invite link.");
  }
};
$("sendform").onsubmit = (event) => {
  event.preventDefault();
  const value = $("message").value;
  if (!value.trim()) {
    toast("Write a message first.");
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast("Reconnect before sending.");
    return;
  }
  ws.send(
    JSON.stringify({ type: "message", text: value, sender: displayName }),
  );
  $("message").value = "";
  $("message").focus();
};
$("message").onkeydown = (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("sendform").requestSubmit();
  }
};
$("uploadform").onsubmit = async (event) => {
  event.preventDefault();
  if ($("upload").disabled) return;
  const file = $("file").files[0];
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    $("uploadstatus").textContent = "File exceeds the 25 MB limit.";
    return;
  }
  const current = session;
  const data = new FormData();
  data.append("key", key);
  data.append("file", file);
  $("upload").disabled = true;
  $("uploadstatus").textContent = "Uploading…";
  try {
    const result = await api(`${endpoint()}/files`, {
      method: "POST",
      body: data,
    });
    if (current !== session) return;
    addFile(result);
    $("uploadstatus").textContent = "File shared.";
    $("uploadform").reset();
  } catch (error) {
    if (current === session) $("uploadstatus").textContent = error.message;
  } finally {
    if (current === session) $("upload").disabled = false;
  }
};
function readInvite() {
  if (room || busy) return;
  const raw = location.hash.slice(1);
  const split = raw.indexOf(".");
  if (split < 1) return;
  setTab("join");
  try {
    $("joincode").value = decodeURIComponent(raw.slice(0, split));
    $("joinkey").value = decodeURIComponent(raw.slice(split + 1));
    $("join-name").focus();
  } catch {
    $("entry-error").textContent =
      "This invite link is invalid. Ask for a new invite.";
    $("entry-error").hidden = false;
  }
}
window.addEventListener("hashchange", readInvite);
readInvite();
