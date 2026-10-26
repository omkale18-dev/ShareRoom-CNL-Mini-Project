// DOM integration tests. Mock transport keeps failure and race cases deterministic;
// tests/test_app.py exercises the real HTTP / WebSocket / file backend.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const state = {
  name: "Design team",
  expires_at: Date.now() / 1000 + 1800,
  messages: [],
  files: [],
};
const response = (data) => ({ ok: true, json: async () => data });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(page = "index", hash = "") {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "static", page + ".html"), "utf8"),
    { url: "http://localhost/" + hash, runScripts: "outside-only" },
  );
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.AbortController = AbortController;
  w.AbortSignal = AbortSignal;
  const calls = [];
  w.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return response(
      options.method === "POST" ? { code: "ABC123", key: "secret" } : state,
    );
  };
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.sent = [];
      Socket.instances.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(value) {
      this.sent.push(JSON.parse(value));
    }
    close() {
      this.readyState = 3;
    }
    receive(data) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
  }
  Socket.instances = [];
  w.WebSocket = Socket;
  if (page === "network")
    w.fetch = async (url) =>
      url.includes("aws-metrics")
        ? response({ connected: false, error: "AWS not configured" })
        : response({ instance: "test-instance" });
  w.eval(
    fs.readFileSync(
      path.join(root, "static", page === "index" ? "app.js" : "network.js"),
      "utf8",
    ),
  );
  return { dom, w, calls, Socket, $: (id) => w.document.getElementById(id) };
}
async function create(env) {
  env.$("create-name").value = "Om";
  env.$("room-name").value = "Design team";
  env
    .$("createform")
    .dispatchEvent(new env.w.Event("submit", { cancelable: true }));
  await flush();
}

test("create submits once, displays room, sends safely, and leaves", async () => {
  const env = setup();
  const { $, w, calls, Socket } = env;
  try {
    $("create-name").value = "Om";
    $("room-name").value = "Design team";
    const submit = () =>
      $("createform").dispatchEvent(
        new w.Event("submit", { cancelable: true }),
      );
    submit();
    submit();
    await flush();
    assert.equal(calls.filter((c) => c.options.method === "POST").length, 1);
    assert.equal(JSON.parse(calls[0].options.body).name, "Design team");
    assert.equal($("landing").hidden, true);
    assert.equal($("room").hidden, false);
    assert.equal($("room-title").textContent, "Design team");
    assert.equal($("send").disabled, false);
    $("message").value = "   ";
    $("sendform").dispatchEvent(new w.Event("submit", { cancelable: true }));
    assert.equal(Socket.instances[0].sent.length, 0);
    $("message").value = "Hello";
    $("sendform").dispatchEvent(new w.Event("submit", { cancelable: true }));
    assert.equal(Socket.instances[0].sent[0].sender, "Om");
    assert.equal($("message").value, "");
    Socket.instances[0].receive({
      type: "message",
      id: 1,
      text: "<img src=x onerror=alert(1)>",
      sender: "Om",
      created: 1,
    });
    Socket.instances[0].receive({
      type: "message",
      id: 1,
      text: "duplicate",
      created: 1,
    });
    assert.equal($("messages").children.length, 1);
    assert.equal($("messages").querySelector("img"), null);
    $("leave").click();
    assert.equal($("room").hidden, true);
    assert.equal(w.location.hash, "");
    assert.equal(Socket.instances[0].readyState, 3);
  } finally {
    env.dom.window.close();
  }
});

test("create failures reset controls; successful creation survives failed room fetch", async () => {
  const env = setup();
  try {
    env.w.fetch = async () => {
      throw Error("Offline");
    };
    await create(env);
    assert.equal(env.$("entry-error").textContent, "Offline");
    assert.equal(env.$("create").disabled, false);
    env.w.fetch = async (url, options = {}) => {
      if (options.method === "POST")
        return response({ code: "ABC123", key: "secret" });
      throw Error("Try joining again");
    };
    await create(env);
    assert.equal(env.$("join-panel").hidden, false);
    assert.equal(env.$("joincode").value, "ABC123");
    assert.equal(env.w.location.hash, "#ABC123");
  } finally {
    env.dom.window.close();
  }
});

test("invite prefill, invalid invite, tab keyboard navigation and join errors", async () => {
  const env = setup("index", "#ABC123");
  try {
    assert.equal(env.$("join-panel").hidden, false);
    env
      .$("join-tab")
      .dispatchEvent(
        new env.w.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    assert.equal(env.$("create-panel").hidden, false);
    env.$("join-tab").click();
    env.$("join-name").value = "Mira";
    env.w.fetch = async () => ({
      ok: false,
      json: async () => ({ detail: "Invalid room key" }),
    });
    env
      .$("joinform")
      .dispatchEvent(new env.w.Event("submit", { cancelable: true }));
    await flush();
    assert.equal(env.$("entry-error").textContent, "Invalid room key");
    assert.equal(env.$("room").hidden, true);
    env.w.fetch = async (url) => response(url.endsWith("/join") ? {code: "ABC123", key: "secret"} : state);
    env
      .$("joinform")
      .dispatchEvent(new env.w.Event("submit", { cancelable: true }));
    await flush();
    assert.equal(env.$("room").hidden, false);
  } finally {
    env.dom.window.close();
  }
  const invalid = setup("index", "#ABC123.%ZZ");
  assert.match(invalid.$("entry-error").textContent, /invalid/);
  invalid.dom.window.close();
});

test("clipboard HTTP fallback, disconnect and reconnect", async () => {
  const env = setup();
  try {
    await create(env);
    env.$("copy").click();
    await flush();
    assert.equal(env.$("invite-fallback").hidden, false);
    assert.match(env.$("invite").value, /#ABC123/);
    env.Socket.instances[0].onclose();
    assert.equal(env.$("send").disabled, true);
    assert.equal(env.$("reconnect").hidden, false);
    env.$("reconnect").click();
    await flush();
    assert.equal(env.$("send").disabled, false);
    assert.equal(env.Socket.instances.length, 2);
  } finally {
    env.dom.window.close();
  }
});

test("upload limit and stale upload cannot write into a departed room", async () => {
  const env = setup();
  try {
    await create(env);
    Object.defineProperty(env.$("file"), "files", {
      configurable: true,
      value: [{ size: 25 * 1024 * 1024 + 1 }],
    });
    env
      .$("uploadform")
      .dispatchEvent(new env.w.Event("submit", { cancelable: true }));
    assert.match(env.$("uploadstatus").textContent, /25 MB/);
    Object.defineProperty(env.$("file"), "files", {
      configurable: true,
      value: [new env.w.File(["abc"], "demo.txt")],
    });
    let resolve;
    env.w.fetch = () => new Promise((r) => (resolve = r));
    env
      .$("uploadform")
      .dispatchEvent(new env.w.Event("submit", { cancelable: true }));
    assert.equal(env.$("upload").disabled, true);
    env.$("leave").click();
    resolve(
      response({ id: "file1", name: "demo.txt", size: 3, sha256: "abc" }),
    );
    await flush();
    assert.equal(env.$("files").children.length, 0);
  } finally {
    env.dom.window.close();
  }
});

test("network probes, reset, AWS unavailable and stale metrics", async () => {
  const env = setup("network");
  try {
    await flush();
    assert.match(env.$("aws-status").textContent, /not configured/);
    env.$("count").value = "2";
    env.$("run").click();
    await flush();
    assert.equal(env.$("total").textContent, "2");
    assert.equal(env.$("instances").textContent, "1");
    env.$("reset").click();
    assert.equal(env.$("total").textContent, "0");
    env.$("aws-requests").textContent = "123";
    env.w.fetch = async () => {
      throw Error("Offline");
    };
    env.$("aws-refresh").click();
    await flush();
    assert.equal(env.$("aws-requests").textContent, "—");
    assert.equal(env.$("aws-refresh").disabled, false);
  } finally {
    env.dom.window.close();
  }
});

test("manual join exposes code; copying works with and without clipboard", async () => {
  const env = setup();
  try {
    await create(env);
    assert.equal(env.$("share-code").value, "ABC123");
    assert.equal(env.$("share-key"), null);
    for (const [button, field] of [
      ["copy-code", "share-code"],
    ]) {
      env.$(button).click();
      await flush();
      assert.equal(env.w.document.activeElement, env.$(field));
      assert.equal(env.$(field).selectionEnd, env.$(field).value.length);
    }
    const copied = [];
    Object.defineProperty(env.w.navigator, "clipboard", {
      value: { writeText: async (text) => copied.push(text) },
    });
    env.$("copy-code").click();
    await flush();
    assert.deepEqual(copied, ["ABC123"]);
    env.$("leave").click();
    assert.equal(env.$("share-code").value, "");
  } finally {
    env.dom.window.close();
  }
});


test("retry after a lost create response reuses request ID, leave starts a new room", async () => {
  const env = setup();
  try {
    const requests = [];
    let fail = true;
    env.w.fetch = async (url, options = {}) => {
      if (url === "/api/rooms") {
        requests.push(JSON.parse(options.body));
        if (fail) { fail = false; throw Error("Response lost"); }
        return response({code: "ABC123", key: "secret"});
      }
      return response(state);
    };
    await create(env);
    await create(env);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].request_id, requests[1].request_id);
    assert.equal(env.$("room").hidden, false);
    await create(env); // Submitting a hidden form must not create another room.
    assert.equal(requests.length, 2);
    env.$("leave").click();
    await create(env);
    assert.notEqual(requests[2].request_id, requests[1].request_id);
  } finally { env.dom.window.close(); }
});

test("code-only and legacy invites join without missing DOM fields", async () => {
  for (const hash of ["#abc123", "#ABC123.secret"]) {
    const env = setup("index", hash);
    try {
      assert.equal(env.$("joincode").value, "ABC123");
      env.$("join-name").value = "Guest";
      env.$("joinform").dispatchEvent(new env.w.Event("submit", {cancelable: true}));
      await flush();
      assert.equal(env.calls[0].url, "/api/rooms/ABC123/join");
      assert.equal(env.calls[0].options.method, "POST");
      assert.equal(env.$("room").hidden, false);
      env.Socket.instances[0].receive(null);
      assert.equal(env.$("entry-error").hidden, true);
    } finally { env.dom.window.close(); }
  }
});

test("leaving during reconnect prevents a late response reopening the room", async () => {
  const env = setup();
  try {
    await create(env);
    let resolve;
    env.w.fetch = () => new Promise(r => { resolve = r; });
    env.$("reconnect").click();
    env.$("leave").click();
    resolve(response(state));
    await flush();
    assert.equal(env.$("room").hidden, true);
    assert.equal(env.w.location.hash, "");
  } finally { env.dom.window.close(); }
});
