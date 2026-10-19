// Pixel Control — mirror and control an Android phone over USB, right in Edge/Chrome.
// USB + ADB: Tango (@yume-chan/*). Screen + input: the scrcpy server, pushed to the phone.
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import {
  AndroidKeyCode, AndroidKeyEventAction, AndroidKeyEventMeta, AndroidMotionEventAction,
  AndroidScreenPowerMode, DefaultServerPath, ScrcpyPointerId,
} from "@yume-chan/scrcpy";
import {
  BitmapVideoFrameRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import { ReadableStream } from "@yume-chan/stream-extra";

const $ = (id) => document.getElementById(id);
const SERVER_VERSION = "3.3.3";
const SERVER_PATH = DefaultServerPath;
const usb = AdbDaemonWebUsbDeviceManager.BROWSER;
const credentials = new AdbWebCredentialStore("Pixel Control");

// ---- settings ------------------------------------------------------------------------
const SETTINGS_KEY = "pixel-control-settings";
const defaults = { quality: "sharp", stayAwake: true, screenOff: false, gpuDecode: false };
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch {}
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };
// Full resolution (1280×2856 on a Pixel 9 Pro) is beyond many laptop video decoders and
// makes Windows fall back to slow software decoding, so the default caps the long side.
const QUALITY = {
  sharp: { maxSize: 1920, videoBitRate: 8_000_000, maxFps: 60 },
  light: { maxSize: 1280, videoBitRate: 4_000_000, maxFps: 60 },
  full: { maxSize: 0, videoBitRate: 12_000_000, maxFps: 60 },
};
if (!QUALITY[settings.quality]) settings.quality = defaults.quality; // older saved choices

// ---- state ---------------------------------------------------------------------------
let adb = null;            // Adb
let client = null;         // AdbScrcpyClient
let decoder = null;        // WebCodecsVideoDecoder
let controller = null;     // ScrcpyControlMessageWriter
let videoW = 0, videoH = 0;
let connecting = false;
let screenIsOff = false;
let userDisconnected = false;
let lastPhoneClipboard = "";

// ---- UI helpers ----------------------------------------------------------------------
function show(view) {
  $("start").hidden = view !== "start";
  $("phone").hidden = view !== "phone";
  document.body.dataset.view = view;
}
function status(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = !text;
}
let toastTimer;
function toast(text, ms = 3500) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function busy(on, text) {
  connecting = on;
  $("connect-btn").disabled = on;
  $("connect-btn").textContent = on ? (text || "Connecting…") : "Connect phone";
}

// ---- connecting ----------------------------------------------------------------------
async function pickDevice() {
  if (!usb) throw new Error("NO_WEBUSB");
  return usb.requestDevice(); // shows Edge's device picker
}

async function knownDevice() {
  if (!usb) return undefined;
  const list = await usb.getDevices();
  return list[0];
}

async function connect(device) {
  if (connecting || client) return;
  userDisconnected = false;
  busy(true);
  try {
    if (!device) {
      device = await pickDevice();
      if (!device) { busy(false); return; } // picker cancelled
    }
    status(`Connecting to ${device.name || "phone"}…`);
    let connection;
    try {
      connection = await device.connect();
    } catch (e) {
      if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) throw new Error("BUSY");
      throw e;
    }
    status("Check your phone: tap “Allow” on the USB debugging prompt (tick “Always allow from this computer”).", "wait");
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial, connection, credentialStore: credentials,
    });
    adb = new Adb(transport);
    transport.disconnected.then(() => onDisconnected(), () => onDisconnected());

    status("Starting screen mirroring…");
    await pushServer();
    await startMirroring();
    status("");
  } catch (e) {
    console.error(e);
    await teardown();
    show("start");
    status(explain(e), "error");
  } finally {
    busy(false);
  }
}

function explain(e) {
  const msg = String(e?.message || e);
  if (msg === "NO_WEBUSB") return "This browser can’t talk to USB devices. Open this app in Microsoft Edge or Google Chrome.";
  if (msg === "BUSY" || /claimed|busy|Unable to claim|Access denied/i.test(msg))
    return "The phone is already being used by another window. Close every other Pixel Control window or tab (in Chrome too) and anything else that uses the phone over USB (scrcpy, Android Studio), then unplug and replug the phone and click Connect phone.";
  if (/No device selected|NotFoundError/i.test(msg)) return "";
  if (/AbortError|cancel/i.test(msg)) return "";
  if (/NetworkError|disconnected|transferIn|transferOut/i.test(msg))
    return "The connection dropped. Unplug the phone, plug it back in and try again.";
  return `Couldn’t connect: ${msg}`;
}

async function pushServer() {
  const res = await fetch("scrcpy-server.bin");
  if (!res.ok) throw new Error("Couldn’t load the screen-mirroring component. Check your internet connection once, then try again.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  await AdbScrcpyClient.pushServer(adb, new ReadableStream({
    start(c) { c.enqueue(bytes); c.close(); },
  }), SERVER_PATH);
}

async function startMirroring() {
  const q = QUALITY[settings.quality] || QUALITY.high;
  const options = new AdbScrcpyOptionsLatest({
    audio: false,
    video: true,
    control: true,
    videoCodec: "h264",
    maxSize: q.maxSize,
    videoBitRate: q.videoBitRate,
    maxFps: q.maxFps,
    stayAwake: !!settings.stayAwake,
    powerOn: true,
    clipboardAutosync: true,
    logLevel: "info",
  }, { version: SERVER_VERSION });

  client = await AdbScrcpyClient.start(adb, SERVER_PATH, options);
  controller = client.controller;

  // Drain the server's log so it never blocks.
  client.output.pipeTo(sink((line) => console.debug("[scrcpy]", line))).catch(() => {});
  client.exited.then(() => { if (client) onDisconnected(); }, () => {});

  // Phone → computer clipboard.
  const clip = client.clipboard;
  if (clip) clip.pipeTo(sink((text) => {
    if (document.hasFocus()) navigator.clipboard?.writeText(text).catch(() => {});
    lastPhoneClipboard = text;
  })).catch(() => {});

  const video = await client.videoStream;
  const canvas = $("screen");
  const renderer = WebGLVideoFrameRenderer.isSupported
    ? new WebGLVideoFrameRenderer(canvas)
    : new BitmapVideoFrameRenderer(canvas);
  // Software decoding by default: some laptop video chips (notably Snapdragon ones) hold
  // back many frames before showing them, which shows up as seconds of lag and 1–2 fps.
  // At this picture size the processor decodes in a few milliseconds per frame.
  hwDecode = !!settings.gpuDecode && await decodeSupported("prefer-hardware");
  const swOk = await decodeSupported("prefer-software");
  decoder = new WebCodecsVideoDecoder({
    codec: video.metadata.codec, renderer,
    hardwareAcceleration: hwDecode ? "prefer-hardware" : swOk ? "prefer-software" : "no-preference",
  });
  // Touches must carry exactly the size of the video the phone is sending, or the phone
  // ignores them — so take it from the stream itself (it also changes on rotation).
  const setSize = (w, h) => { if (w && h) { videoW = w; videoH = h; layout(); showStats(); } };
  setSize(video.width || video.metadata.width, video.height || video.metadata.height);
  video.sizeChanged(({ width, height }) => setSize(width, height));
  video.stream.pipeTo(decoder.writable).catch((e) => console.warn("video ended", e));
  startStats();

  $("device-name").textContent = video.metadata.deviceName || adb.banner?.model || "Phone";
  show("phone");
  layout();
  $("stage").focus();

  screenIsOff = false;
  if (settings.screenOff) setTimeout(() => setPhoneScreen(false), 800);
  refreshToggles();
}

// Minimal sink for draining a stream.
function sink(fn) {
  return new globalThis.WritableStream({ write: fn });
}

// Is the computer's graphics chip able to decode the phone's video? If not, the browser
// decodes in software, which is what makes mirroring lag (common in emulated browsers).
let hwDecode = false;
async function decodeSupported(hardwareAcceleration) {
  try {
    if (!globalThis.VideoDecoder?.isConfigSupported) return false;
    const r = await VideoDecoder.isConfigSupported({
      codec: "avc1.640028", codedWidth: 1080, codedHeight: 1920,
      hardwareAcceleration, optimizeForLatency: true,
    });
    return !!r.supported;
  } catch { return false; }
}

// An x64 browser running on an ARM (Snapdragon) PC reports an x86 platform in its UA data.
let uaArch = "";
navigator.userAgentData?.getHighEntropyValues?.(["architecture"]).then((v) => { uaArch = v.architecture || ""; }).catch(() => {});

// Small readout in the top bar: picture size, frames per second and decoder type.
let statsTimer = 0, lastFrames = 0, fps = 0;
function showStats() {
  const el = $("stats");
  if (!el) return;
  el.textContent = videoW
    ? `${videoW}×${videoH}${fps ? ` · ${fps} fps` : ""} · ${hwDecode ? "graphics-chip decoding" : "processor decoding"}${uaArch ? ` · ${uaArch} browser` : ""}`
    : "";

}
function startStats() {
  clearInterval(statsTimer);
  lastFrames = 0; fps = 0;
  statsTimer = setInterval(() => {
    if (!decoder) return;
    const n = decoder.framesRendered;
    fps = Math.max(0, n - lastFrames);
    lastFrames = n;
    showStats();
  }, 1000);
}

async function teardown() {
  clearInterval(statsTimer);
  const c = client, d = decoder, a = adb;
  client = null; decoder = null; controller = null; adb = null;
  try { await c?.close(); } catch {}
  try { d?.dispose(); } catch {}
  try { await a?.close(); } catch {}
}

async function onDisconnected() {
  if (!adb && !client) return;
  await teardown();
  show("start");
  if (!userDisconnected) status("Phone disconnected. Plug it back in — it will reconnect by itself.", "warn");
}

async function disconnect() {
  userDisconnected = true;
  if (screenIsOff) await setPhoneScreen(true).catch(() => {});
  await teardown();
  show("start");
  status("Disconnected.");
}

// Reconnect automatically when an already-allowed phone is plugged in.
if (usb && navigator.usb) {
  navigator.usb.addEventListener("connect", () => {
    if (client || connecting || userDisconnected) return;
    setTimeout(async () => {
      const d = await knownDevice().catch(() => undefined);
      if (d && !client && !connecting) connect(d);
    }, 700);
  });
  navigator.usb.addEventListener("disconnect", () => { if (client) onDisconnected(); });
}

// ---- layout: fit the phone screen into the window ------------------------------------
function layout() {
  if (!videoW || !videoH) return;
  const stage = $("stage");
  const box = stage.getBoundingClientRect();
  const pad = 16;
  const scale = Math.min((box.width - pad * 2) / videoW, (box.height - pad * 2) / videoH);
  const canvas = $("screen");
  canvas.style.width = `${Math.max(1, Math.floor(videoW * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(videoH * scale))}px`;
}
window.addEventListener("resize", layout);

// ---- mouse, touch and pen ------------------------------------------------------------
const canvas = $("screen");
const activePointers = new Map(); // browser pointerId → scrcpy pointerId

function toPhone(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * videoW);
  const y = Math.round(((e.clientY - r.top) / r.height) * videoH);
  return {
    pointerX: Math.min(Math.max(x, 0), videoW - 1),
    pointerY: Math.min(Math.max(y, 0), videoH - 1),
    videoWidth: videoW,
    videoHeight: videoH,
  };
}

function touch(e, action, pointerId) {
  if (!controller || !videoW) return;
  controller.injectTouch({
    action, pointerId, ...toPhone(e),
    pressure: action === AndroidMotionEventAction.Up ? 0 : (e.pressure > 0 && e.pointerType !== "mouse" ? e.pressure : 1),
    actionButton: 0, buttons: 0,
  }).catch(() => {});
}

canvas.addEventListener("pointerdown", (e) => {
  if (!controller) return;
  e.preventDefault();
  $("stage").focus();
  if (e.pointerType === "mouse" && e.button === 2) { pressBack(); return; }        // right-click = Back
  if (e.pointerType === "mouse" && e.button === 1) { pressKey(AndroidKeyCode.AndroidHome); return; } // middle = Home
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const id = e.pointerType === "mouse" ? ScrcpyPointerId.Finger : BigInt(e.pointerId);
  activePointers.set(e.pointerId, id);
  canvas.setPointerCapture(e.pointerId);
  touch(e, AndroidMotionEventAction.Down, id);
});
// Moves are sent at most once per screen refresh (latest position only). Sending every
// tiny movement floods the USB link and makes the phone lag behind the mouse.
const pendingMoves = new Map(); // browser pointerId → latest move event
let moveFrame = 0;
function flushMoves() {
  moveFrame = 0;
  for (const [pid, ev] of pendingMoves) {
    const id = activePointers.get(pid);
    if (id !== undefined) touch(ev, AndroidMotionEventAction.Move, id);
  }
  pendingMoves.clear();
}
canvas.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  e.preventDefault();
  pendingMoves.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType });
  if (!moveFrame) moveFrame = requestAnimationFrame(flushMoves);
});
const endPointer = (e) => {
  const id = activePointers.get(e.pointerId);
  if (id === undefined) return;
  if (pendingMoves.has(e.pointerId)) flushMoves();
  activePointers.delete(e.pointerId);
  touch(e, e.type === "pointercancel" ? AndroidMotionEventAction.Cancel : AndroidMotionEventAction.Up, id);
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// Mouse wheel / touchpad → scroll.
// Wheel/touchpad scrolling is added up and sent once per screen refresh.
let scrollAcc = null, scrollFrame = 0;
canvas.addEventListener("wheel", (e) => {
  if (!controller || !videoW) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
  if (!scrollAcc) scrollAcc = { x: 0, y: 0, at: null };
  scrollAcc.x += -e.deltaX * unit;
  scrollAcc.y += -e.deltaY * unit;
  scrollAcc.at = { clientX: e.clientX, clientY: e.clientY };
  if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const a = scrollAcc; scrollAcc = null;
    if (!a || !controller) return;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    controller.injectScroll({ ...toPhone(a.at), scrollX: clamp(a.x), scrollY: clamp(a.y), buttons: 0 }).catch(() => {});
  });
}, { passive: false });

// ---- keyboard ------------------------------------------------------------------------
function metaOf(e) {
  let m = 0;
  if (e.shiftKey) m |= AndroidKeyEventMeta.Shift;
  if (e.ctrlKey) m |= AndroidKeyEventMeta.Ctrl;
  if (e.altKey) m |= AndroidKeyEventMeta.Alt;
  if (e.metaKey) m |= AndroidKeyEventMeta.Meta;
  if (e.getModifierState?.("CapsLock")) m |= AndroidKeyEventMeta.CapsLock;
  return m;
}
const KEY_ALIASES = { Escape: AndroidKeyCode.AndroidBack };
function keyCodeFor(e) {
  if (KEY_ALIASES[e.code] !== undefined) return KEY_ALIASES[e.code];
  return AndroidKeyCode[e.code];
}
const typingTarget = (t) => t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
const keysDown = new Map();

window.addEventListener("keydown", async (e) => {
  if (!controller || typingTarget(e.target) || $("help").open) return;
  // Ctrl+V: send this computer's clipboard to the phone and paste it.
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyV") {
    e.preventDefault();
    try {
      const content = await navigator.clipboard.readText();
      if (content && content !== lastPhoneClipboard) {
        await controller.setClipboard({ sequence: 0n, paste: true, content });
        return;
      }
    } catch {}
    pressKey(AndroidKeyCode.AndroidPaste);
    return;
  }
  if (e.key === "F11") return; // let the browser go full screen
  e.preventDefault();
  // Plain characters are typed as text (handles symbols and capitals reliably).
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    controller.injectText(e.key).catch(() => {});
    return;
  }
  const code = keyCodeFor(e);
  if (code === undefined) return;
  keysDown.set(e.code, code);
  sendKey(code, AndroidKeyEventAction.Down, metaOf(e), e.repeat ? 1 : 0);
});
window.addEventListener("keyup", (e) => {
  if (!controller) return;
  const code = keysDown.get(e.code);
  if (code === undefined) return;
  keysDown.delete(e.code);
  e.preventDefault();
  sendKey(code, AndroidKeyEventAction.Up, metaOf(e));
});
window.addEventListener("blur", () => {
  for (const code of keysDown.values()) sendKey(code, AndroidKeyEventAction.Up, 0);
  keysDown.clear();
});

function sendKey(keyCode, action, metaState = 0, repeat = 0) {
  if (!controller) return Promise.resolve();
  return controller.injectKeyCode({ action, keyCode, repeat, metaState }).catch(() => {});
}
async function pressKey(keyCode, metaState = 0) {
  if (!controller) return;
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState }).catch(() => {});
  await controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState }).catch(() => {});
}
async function pressBack() {
  if (!controller) return;
  await controller.backOrScreenOn(AndroidKeyEventAction.Down).catch(() => {});
  await controller.backOrScreenOn(AndroidKeyEventAction.Up).catch(() => {});
}

// ---- toolbar -------------------------------------------------------------------------
async function setPhoneScreen(on) {
  if (!controller) return;
  await controller.setScreenPowerMode(on ? AndroidScreenPowerMode.Normal : AndroidScreenPowerMode.Off);
  screenIsOff = !on;
  refreshToggles();
}

function refreshToggles() {
  $("screen-btn").setAttribute("aria-pressed", String(screenIsOff));
  $("screen-btn").title = screenIsOff
    ? "Turn the phone’s own screen back on"
    : "Turn the phone’s own screen off (keeps showing here, saves battery)";
}

async function screenshot() {
  if (!decoder) return;
  const blob = await decoder.snapshot();
  if (!blob) { toast("Nothing to capture yet."); return; }
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  a.href = URL.createObjectURL(blob);
  a.download = `Pixel-screenshot-${stamp}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast("Screenshot saved to your Downloads folder.");
}

const actions = {
  "back-btn": pressBack,
  "home-btn": () => pressKey(AndroidKeyCode.AndroidHome),
  "recents-btn": () => pressKey(AndroidKeyCode.AndroidAppSwitch),
  "power-btn": () => pressKey(AndroidKeyCode.Power),
  "volup-btn": () => pressKey(AndroidKeyCode.VolumeUp),
  "voldown-btn": () => pressKey(AndroidKeyCode.VolumeDown),
  "notif-btn": () => controller?.expandNotificationPanel(),
  "settings-panel-btn": () => controller?.expandSettingPanel(),
  "rotate-btn": () => controller?.rotateDevice(),
  "screen-btn": () => setPhoneScreen(screenIsOff).catch(() => toast("Couldn’t change the phone screen.")),
  "shot-btn": screenshot,
  "full-btn": () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
  "disconnect-btn": disconnect,
};
for (const [id, fn] of Object.entries(actions)) {
  $(id).addEventListener("click", async () => {
    try { await fn(); } catch (e) { console.warn(e); }
    if (id !== "disconnect-btn") $("stage").focus();
  });
}
document.addEventListener("fullscreenchange", () => setTimeout(layout, 50));

// ---- drag files onto the phone: APKs install, everything else goes to Download ------
const stage = $("stage");
stage.addEventListener("dragover", (e) => { if (adb) { e.preventDefault(); stage.classList.add("drop"); } });
stage.addEventListener("dragleave", () => stage.classList.remove("drop"));
stage.addEventListener("drop", async (e) => {
  stage.classList.remove("drop");
  if (!adb) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  for (const f of files) await sendFile(f);
});
$("file-btn").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async () => {
  for (const f of [...$("file-input").files]) await sendFile(f);
  $("file-input").value = "";
  $("stage").focus();
});

const safeName = (n) => n.replace(/[\\/:*?"<>|\x00-\x1f']/g, "_");
async function writeToPhone(path, file) {
  const sync = await adb.sync();
  try {
    await sync.write({ filename: path, file: file.stream() });
  } finally {
    await sync.dispose();
  }
}
async function shell(args) {
  return adb.subprocess.noneProtocol.spawnWaitText(args);
}
async function sendFile(file) {
  if (!adb) return;
  const isApk = /\.apk$/i.test(file.name);
  try {
    if (isApk) {
      toast(`Installing ${file.name}…`, 60_000);
      const tmp = `/data/local/tmp/pixel-control-install.apk`;
      await writeToPhone(tmp, file);
      const out = await shell(["pm", "install", "-r", "-t", tmp]);
      await shell(["rm", "-f", tmp]).catch(() => {});
      if (/Success/i.test(out)) toast(`Installed ${file.name}.`);
      else toast(`Install failed: ${out.trim().split("\n").pop()}`, 8000);
    } else {
      toast(`Copying ${file.name} to the phone…`, 60_000);
      const dest = `/sdcard/Download/${safeName(file.name)}`;
      await writeToPhone(dest, file);
      await shell(["am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${dest}`]).catch(() => {});
      toast(`Copied ${file.name} to the phone’s Download folder.`);
    }
  } catch (e) {
    console.error(e);
    toast(`Couldn’t send ${file.name}: ${e?.message || e}`, 8000);
  }
}

// ---- start screen --------------------------------------------------------------------
$("connect-btn").addEventListener("click", () => connect());
$("help-btn").addEventListener("click", () => $("help").showModal());
$("help-close").addEventListener("click", () => $("help").close());
$("phone-help-btn").addEventListener("click", () => $("help").showModal());

const qualitySel = $("quality");
qualitySel.value = settings.quality;
qualitySel.addEventListener("change", () => { settings.quality = qualitySel.value; saveSettings(); });
$("opt-awake").checked = !!settings.stayAwake;
$("opt-awake").addEventListener("change", (e) => { settings.stayAwake = e.target.checked; saveSettings(); });
$("opt-gpu").checked = !!settings.gpuDecode;
$("opt-gpu").addEventListener("change", (e) => { settings.gpuDecode = e.target.checked; saveSettings(); });
$("opt-screenoff").checked = !!settings.screenOff;
$("opt-screenoff").addEventListener("change", (e) => { settings.screenOff = e.target.checked; saveSettings(); });

if (!usb || !WebCodecsVideoDecoder.isSupported) {
  $("connect-btn").disabled = true;
  status("This browser can’t do USB screen mirroring. Open this page in Microsoft Edge or Google Chrome.", "error");
}

// Install as an app (Edge/Chrome).
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("install-card").hidden = false;
});
$("install-btn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $("install-card").hidden = true;
});
window.addEventListener("appinstalled", () => { $("install-card").hidden = true; });

// Offline support + updates.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then((reg) => reg.update())
    .catch((e) => console.warn("Offline support unavailable", e));
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    if (client) toast("An update is ready — it will load next time you open Pixel Control.", 6000);
    else location.reload();
  });
}
fetch("version.txt", { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).then((v) => {
  if (v.trim()) $("version").textContent = `Version ${v.trim()}`;
}).catch(() => {});

show("start");
// Connect straight away if this phone was allowed before and is plugged in.
knownDevice().then((d) => { if (d) connect(d); }).catch(() => {});

// For automated checks.
window.__pixelControl = { get connected() { return !!client; }, layout };
