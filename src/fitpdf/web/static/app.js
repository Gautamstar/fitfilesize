"use strict";

/* ---------- state ---------- */

const state = {
  jobId: null,
  filename: "",
  originalBytes: 0,
  pages: 0,
  floor: 0,       // estimated floor in bytes
  sliderMin: 0,   // slider lower bound in bytes (extends below floor)
  sliderMax: 0,   // slider upper bound = original size
  targetBytes: 0,
  expiresAt: 0,   // epoch ms
  es: null,       // EventSource
  countdownTimer: null,
};

const SLIDER_STEPS = 1000;
const PRESETS_MB = [2, 4, 5, 10, 25];
const MAX_ATTEMPTS = 5; // lossless pass plus at most 4 rungs (binary search over 12)

const $ = (id) => document.getElementById(id);

/* ---------- helpers ---------- */

function fmt(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let n = bytes;
  for (const u of units) {
    n /= 1024;
    if (n < 1024 || u === "GB") return n.toFixed(1) + " " + u;
  }
}

function showPanel(id) {
  for (const p of document.querySelectorAll(".panel")) p.hidden = true;
  $(id).hidden = false;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = "request failed (" + res.status + ")";
    try {
      const body = await res.json();
      if (body.detail) msg = typeof body.detail === "string" ? body.detail : msg;
    } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

function fail(message) {
  closeStream();
  $("er-message").textContent = message;
  showPanel("panel-error");
}

function closeStream() {
  if (state.es) { state.es.close(); state.es = null; }
}

/* ---------- upload ---------- */

const dropzone = $("dropzone");
const fileInput = $("file-input");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});
for (const ev of ["dragover", "dragenter"]) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); });
}
for (const ev of ["dragleave", "drop"]) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); });
}
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
  $("drop-error").hidden = true;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    $("drop-error").textContent = "That does not look like a PDF.";
    $("drop-error").hidden = false;
    return;
  }
  $("an-name").textContent = file.name;
  $("an-meta").textContent = fmt(file.size);
  showPanel("panel-analyze");

  try {
    const form = new FormData();
    form.append("file", file);
    const up = await api("/api/upload", { method: "POST", body: form });
    state.jobId = up.job_id;
    state.filename = up.filename;
    state.originalBytes = up.size_bytes;
    state.pages = up.pages;
    state.expiresAt = Date.now() + up.expires_in * 1000;
    $("an-meta").textContent = fmt(up.size_bytes) + ", " + up.pages
      + (up.pages === 1 ? " page" : " pages");

    const an = await api("/api/jobs/" + state.jobId + "/analyze", { method: "POST" });
    state.floor = an.floor_estimate;
    openTargetPicker();
  } catch (err) {
    fileInput.value = "";
    $("drop-error").textContent = err.message;
    $("drop-error").hidden = false;
    showPanel("panel-drop");
  }
}

/* ---------- target picker ---------- */

const slider = $("slider");

function sliderToBytes(pos) {
  const { sliderMin: lo, sliderMax: hi } = state;
  return Math.round(lo * Math.pow(hi / lo, pos / SLIDER_STEPS));
}

function bytesToSlider(bytes) {
  const { sliderMin: lo, sliderMax: hi } = state;
  const clamped = Math.min(Math.max(bytes, lo), hi);
  return Math.round(SLIDER_STEPS * Math.log(clamped / lo) / Math.log(hi / lo));
}

function tierHint(target) {
  if (target < state.floor) {
    return { text: "Below the estimated floor. You will get the smallest file "
      + "possible instead, about " + fmt(state.floor) + ".", below: true };
  }
  const ratio = target / state.originalBytes;
  if (ratio >= 0.75) return { text: "Light touch. Mostly structural cleanup, images stay sharp.", below: false };
  if (ratio >= 0.45) return { text: "Balanced. Modest downsampling, fine for print and screen.", below: false };
  if (ratio >= 0.25) return { text: "Aggressive. Images get visibly softer but stay readable.", below: false };
  return { text: "Maximum squeeze. Screen-reading quality.", below: false };
}

function openTargetPicker() {
  const orig = state.originalBytes;
  // Slider spans from below the floor (so the hatched zone is visible) up to
  // the original size. Guard the degenerate case where the floor estimate is
  // at or above the original.
  let lo = Math.max(Math.floor(state.floor * 0.4), 1024);
  if (lo >= orig) lo = Math.max(Math.floor(orig * 0.4), 512);
  state.sliderMin = lo;
  state.sliderMax = orig;

  $("tg-name").textContent = state.filename;
  $("tg-meta").textContent = fmt(orig) + ", " + state.pages
    + (state.pages === 1 ? " page" : " pages");
  $("tg-min").textContent = fmt(lo);
  $("tg-max").textContent = fmt(orig);
  $("tg-floor-note").textContent =
    "below " + fmt(state.floor) + ", the smallest this file can likely go";

  // hatched zone covers everything under the floor estimate
  const floorPct = state.floor <= lo ? 0
    : Math.min(100, bytesToSlider(state.floor) / SLIDER_STEPS * 100);
  $("track-hatch").style.width = floorPct + "%";

  buildChips();

  // default target: 4 MB when it makes sense, otherwise 60 percent of original
  const fourMB = 4 * 1024 * 1024;
  let def = (fourMB > state.floor && fourMB < orig) ? fourMB : Math.round(orig * 0.6);
  if (def < lo) def = lo;
  slider.value = bytesToSlider(def);
  onSliderInput();
  showPanel("panel-target");
}

function buildChips() {
  const box = $("chips");
  box.innerHTML = "";
  for (const mb of PRESETS_MB) {
    const bytes = mb * 1024 * 1024;
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = mb + " MB";
    b.dataset.bytes = bytes;
    if (bytes >= state.originalBytes || bytes < state.sliderMin) {
      b.disabled = true;
      b.title = bytes >= state.originalBytes
        ? "already smaller than this" : "out of range for this file";
    } else if (bytes < state.floor) {
      b.classList.add("below-floor");
      b.title = "below the estimated floor";
    }
    b.addEventListener("click", () => {
      slider.value = bytesToSlider(bytes);
      onSliderInput();
    });
    box.appendChild(b);
  }
}

function onSliderInput() {
  const target = sliderToBytes(Number(slider.value));
  state.targetBytes = target;
  $("tg-value").textContent = fmt(target);

  const hint = tierHint(target);
  const hintEl = $("tg-hint");
  hintEl.textContent = hint.text;
  hintEl.classList.toggle("below-floor", hint.below);

  $("track-fill").style.width = (Number(slider.value) / SLIDER_STEPS * 100) + "%";

  for (const chip of document.querySelectorAll(".chip")) {
    const b = Number(chip.dataset.bytes);
    chip.classList.toggle("active", Math.abs(b - target) / b < 0.02);
  }
}

slider.addEventListener("input", onSliderInput);

$("btn-cancel-target").addEventListener("click", resetToDrop);

/* ---------- compress + progress ---------- */

$("btn-compress").addEventListener("click", async () => {
  $("tg-warning").hidden = true;
  try {
    await api("/api/jobs/" + state.jobId + "/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_bytes: state.targetBytes }),
    });
  } catch (err) {
    $("tg-warning").textContent = err.message;
    $("tg-warning").hidden = false;
    return;
  }
  $("pr-name").textContent = state.filename;
  $("pr-target").textContent = "target " + fmt(state.targetBytes);
  $("pr-headline").textContent = "Working on it...";
  $("pr-steps").innerHTML = "";
  showPanel("panel-progress");
  openStream();
});

let attemptCount = 0;
let currentRungLi = null;

function addStep(text, cls) {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  $("pr-steps").appendChild(li);
  return li;
}

function openStream() {
  closeStream();
  attemptCount = 0;
  currentRungLi = null;
  const es = new EventSource("/api/jobs/" + state.jobId + "/events");
  state.es = es;

  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    switch (ev.stage) {
      case "start":
        addStep("Starting, target " + fmt(ev.target_bytes), "ok");
        break;
      case "lossless":
        attemptCount++;
        addStep("Lossless cleanup pass: " + fmt(ev.size), "ok");
        break;
      case "rung_start":
        attemptCount++;
        $("pr-headline").textContent =
          "Attempt " + attemptCount + " of at most " + MAX_ATTEMPTS;
        currentRungLi = addStep(
          "Trying " + ev.color_dpi + " DPI, JPEG quality " + ev.jpeg_q + " ...");
        break;
      case "rung_result": {
        if (!currentRungLi) break;
        currentRungLi.classList.add("ok");
        if (ev.size === null) {
          currentRungLi.textContent += " failed, skipping";
        } else {
          const tag = document.createElement("span");
          tag.className = "tag " + (ev.fits ? "under" : "over");
          tag.textContent = ev.fits ? " under target" : " over target";
          currentRungLi.textContent =
            currentRungLi.textContent.replace(" ...", " gives " + fmt(ev.size) + ",");
          currentRungLi.appendChild(tag);
        }
        currentRungLi = null;
        break;
      }
      case "done":
        closeStream();
        showResult(ev);
        break;
      case "error":
        fail(ev.message || "compression failed");
        break;
    }
  };

  // state events arrive on connect and when the job is already terminal
  es.addEventListener("state", (msg) => {
    const st = JSON.parse(msg.data);
    state.expiresAt = Date.now() + st.expires_in * 1000;
    if (st.status === "done") {
      closeStream();
      showResult({
        stage: "done",
        hit_target: st.hit_target,
        final_bytes: st.final_bytes,
        original_bytes: st.size_bytes,
        target_bytes: st.target_bytes,
        method: st.method,
        warnings: st.warnings || [],
      });
    } else if (st.status === "error") {
      fail(st.error || "compression failed");
    }
  });

  es.onerror = () => {
    // EventSource retries on its own; if the job finished while we were
    // disconnected the next state event resolves it.
  };
}

/* ---------- result ---------- */

function showResult(ev) {
  const badge = $("rs-badge");
  if (ev.hit_target) {
    badge.className = "badge badge-good";
    badge.textContent = "Fits under " + fmt(ev.target_bytes);
    $("rs-detail").textContent = ev.method === "none"
      ? "It was already under your target, so it is unchanged."
      : "Saved " + Math.round(100 * (1 - ev.final_bytes / ev.original_bytes)) + " percent.";
  } else {
    badge.className = "badge badge-warn";
    badge.textContent = "Could not reach " + fmt(ev.target_bytes);
    $("rs-detail").textContent = "This is the smallest we could make it without "
      + "wrecking it. Saved "
      + Math.round(100 * (1 - ev.final_bytes / ev.original_bytes)) + " percent.";
  }
  $("rs-before").textContent = fmt(ev.original_bytes);
  $("rs-after").textContent = fmt(ev.final_bytes);

  const wbox = $("rs-warnings");
  wbox.innerHTML = "";
  for (const w of ev.warnings || []) {
    if (w.includes("floor")) continue; // the badge already says it
    const li = document.createElement("li");
    li.textContent = w;
    wbox.appendChild(li);
  }

  $("btn-download").href = "/api/jobs/" + state.jobId + "/download";
  startCountdown();
  showPanel("panel-result");
}

$("btn-retry").addEventListener("click", () => {
  stopCountdown();
  showPanel("panel-target");
});

$("btn-delete").addEventListener("click", async () => {
  try {
    await api("/api/jobs/" + state.jobId, { method: "DELETE" });
  } catch (e) { /* already gone is fine */ }
  resetToDrop();
});

$("btn-error-restart").addEventListener("click", resetToDrop);

/* ---------- countdown + reset ---------- */

function startCountdown() {
  stopCountdown();
  const el = $("rs-countdown");
  const tick = () => {
    const left = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, "0");
    el.textContent = m + ":" + s;
    el.classList.toggle("soon", left < 300);
    if (left <= 0) {
      stopCountdown();
      resetToDrop();
      $("drop-error").textContent = "That file expired and was deleted. Upload it again if you still need it.";
      $("drop-error").hidden = false;
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

function stopCountdown() {
  if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
}

function resetToDrop() {
  closeStream();
  stopCountdown();
  state.jobId = null;
  fileInput.value = "";
  $("drop-error").hidden = true;
  showPanel("panel-drop");
}
