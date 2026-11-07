"use strict";

/* =========================================================
   LECTURE TRACKER
   Each person adds their own subjects: a name, how many
   lectures there are, and a deadline. Targets are never typed
   in. They are worked out every day from what is left and how
   many study days remain, so missing a day just spreads the
   work over the days that are left. Nothing piles up.
   ========================================================= */

const STATE_VERSION = 3;
const CACHE_PREFIX = "lecture-tracker-cache-";
const LEGACY_CACHE_PREFIX = "gate-tracker-state-v2-cache-";   // the old GATE-only version
const DAY_MS = 86400000;
const PALETTE = ["#4F7CFF", "#E85D3D", "#2FA792", "#D99A2B", "#9B6BFF", "#E2528F", "#3FA7D6", "#6B7480"];

/* =========================================================
   FIREBASE — sign-in + per-account cloud storage.
   firebaseConfig comes from firebase-config.js.
   ========================================================= */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Some networks leave a Firestore read pending for a long time.
// Long-polling is more reliable there.
try {
  db.settings({ experimentalForceLongPolling: true });
} catch (e) {
  console.warn("Could not apply Firestore network settings:", e);
}

let currentUser = null;
// True once this account's saved data has been read from Firestore.
// Background writes (leaderboard, migration) wait for it.
let cloudReady = false;
// The user changed something before the first read finished. Their edits
// must win over the saved copy instead of being overwritten by it.
let pendingWrite = false;
// True when this device had no saved copy at sign-in, so the first read from the
// account must not be thrown away by edits made while it was still loading.
let startedEmpty = false;
let syncRetryTimer = null;

/* =========================================================
   SMALL HELPERS
   ========================================================= */
function pad2(n) { return String(n).padStart(2, "0"); }
function isoOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/* 'YYYY-MM-DD' -> local Date at midnight, or null when it isn't a real date */
function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === "string" ? s : "");
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
}

function todayDate() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}
function weekStartOf(d) { return addDays(d, -((d.getDay() + 6) % 7)); }   // Monday
function maxDate(a, b) { return a.getTime() >= b.getTime() ? a : b; }
function minDate(a, b) { return a.getTime() <= b.getTime() ? a : b; }

function fmtNum(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
function fmtPace(n) { return n >= 10 ? String(Math.round(n)) : fmtNum(n); }
function plural(n, word) { return n === 1 ? word : `${word}s`; }
function fmtShortDate(d) { return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
function uid() { return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)),
  ]);
}

/* =========================================================
   STATE
   {
     version: 3,
     userName: "",
     restDays: [0],                     // 0 = Sunday ... 6 = Saturday
     showOnLeaderboard: true,
     subjects: [{ id, name, total, base, deadline, start, color }],
     logs: [{ id, date, subject, lectures }],
     legacy?: {...}                     // old GATE settings, kept untouched
   }
   `base` = lectures already done before tracking started.
   ========================================================= */
let state = emptyState();

function emptyState() {
  return { version: STATE_VERSION, userName: "", restDays: [], showOnLeaderboard: true, subjects: [], logs: [] };
}

function cleanColor(c, i) {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : PALETTE[i % PALETTE.length];
}

/* Turns anything we might have stored (new, old GATE version, partial, junk)
   into a valid state. Never throws. */
function normalizeState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};

  // The old GATE-only version stored fixed subjects under config.subjects
  if (!Array.isArray(r.subjects) && r.config && r.config.subjects && typeof r.config.subjects === "object") {
    return migrateLegacy(r);
  }

  const today = isoOf(todayDate());
  const subjects = [];
  const seen = new Set();
  (Array.isArray(r.subjects) ? r.subjects : []).forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    const id = typeof s.id === "string" && s.id ? s.id : null;
    const name = typeof s.name === "string" ? s.name.trim().slice(0, 40) : "";
    const deadline = parseISO(s.deadline) ? s.deadline : null;
    if (!id || seen.has(id) || !name || !deadline) return;
    const total = Math.max(Math.round(num(s.total, 1)), 1);
    seen.add(id);
    subjects.push({
      id,
      name,
      total,
      base: Math.min(Math.max(Math.round(num(s.base)), 0), total),
      deadline,
      start: parseISO(s.start) ? s.start : today,
      color: cleanColor(s.color, i),
    });
  });

  const logs = [];
  (Array.isArray(r.logs) ? r.logs : []).forEach(l => {
    if (!l || typeof l !== "object") return;
    const lectures = num(l.lectures);
    if (!seen.has(l.subject) || !parseISO(l.date) || lectures <= 0) return;
    logs.push({ id: String(l.id != null ? l.id : uid()), date: l.date, subject: l.subject, lectures });
  });

  const restDays = [];
  (Array.isArray(r.restDays) ? r.restDays : []).forEach(d => {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n <= 6 && !restDays.includes(n)) restDays.push(n);
  });

  const out = {
    version: STATE_VERSION,
    userName: typeof r.userName === "string" ? r.userName.trim().slice(0, 40) : "",
    restDays: restDays.length >= 7 ? [] : restDays,
    showOnLeaderboard: r.showOnLeaderboard !== false,
    subjects,
    logs,
  };
  if (r.legacy && typeof r.legacy === "object") out.legacy = r.legacy;
  return out;
}

/* The old version had three fixed subjects with one shared target date.
   Turn them into ordinary subjects so nothing is lost. */
function migrateLegacy(r) {
  const cfg = r.config;
  const names = { maths: "Mathematics", aem: "Applied Engineering Mechanics", som: "Strength of Materials" };
  const colors = { maths: "#E85D3D", aem: "#D99A2B", som: "#2FA792" };
  const today = todayDate();
  const deadline = parseISO(cfg.mainTargetDate) ? cfg.mainTargetDate : isoOf(addDays(today, 90));
  const start = parseISO(cfg.startDate) ? cfg.startDate : isoOf(today);

  const subjects = Object.keys(cfg.subjects).map((k, i) => ({
    id: k,
    name: names[k] || k,
    total: Math.max(Math.round(num(cfg.subjects[k] && cfg.subjects[k].total, 1)), 1),
    base: 0,
    deadline,
    start,
    color: colors[k] || PALETTE[i % PALETTE.length],
  }));

  const out = normalizeState({
    userName: r.userName,
    showOnLeaderboard: r.showOnLeaderboard,
    subjects,
    logs: Array.isArray(r.logs) ? r.logs : [],
  });
  out.legacy = {
    config: cfg,
    timerSessions: Array.isArray(r.timerSessions) ? r.timerSessions : [],
    planAdjustments: Array.isArray(r.planAdjustments) ? r.planAdjustments : [],
  };
  return out;
}

function cacheKey(uid) { return `${CACHE_PREFIX}${uid}`; }

function readCachedState(uid) {
  try {
    const raw = localStorage.getItem(cacheKey(uid)) || localStorage.getItem(`${LEGACY_CACHE_PREFIX}${uid}`);
    return raw ? normalizeState(JSON.parse(raw)) : null;
  } catch (err) {
    console.warn("Could not read cached data:", err);
    return null;
  }
}

function saveState() {
  if (!currentUser) return;
  try {
    localStorage.setItem(cacheKey(currentUser.uid), JSON.stringify(state));
  } catch (e) {
    console.error("Could not cache progress locally.", e);
  }
  if (cloudReady) {
    pushToCloud();
  } else {
    pendingWrite = true;   // will be pushed once the first read has finished
  }
  scheduleLeaderboardPublish();
}

function pushToCloud() {
  if (!currentUser) return Promise.resolve();
  return db.collection("users").doc(currentUser.uid).set(state).catch(e => {
    console.error("Could not save to your account.", e);
    showToast("Saved on this device, but couldn't sync (check your connection).");
  });
}

/* =========================================================
   TARGETS
   ========================================================= */
function subjectById(id) { return state.subjects.find(s => s.id === id) || null; }
function isRestDay(d) { return state.restDays.includes(d.getDay()); }
function studyDaysPerWeek() { return Math.max(7 - state.restDays.length, 1); }

/* Study days from `from` to `to`, both included */
function studyDaysBetween(from, to) {
  const span = daysBetween(from, to) + 1;
  if (span <= 0) return 0;
  if (!state.restDays.length) return span;
  if (span > 800) return Math.round((span * studyDaysPerWeek()) / 7);
  let n = 0;
  for (let i = 0; i < span; i++) if (!isRestDay(addDays(from, i))) n++;
  return n;
}

/* Lectures logged for a subject between two ISO dates (either end optional) */
function loggedFor(id, fromISO, toISO) {
  let sum = 0;
  state.logs.forEach(l => {
    if (l.subject !== id) return;
    if (fromISO && l.date < fromISO) return;
    if (toISO && l.date > toISO) return;
    sum += l.lectures;
  });
  return sum;
}

/* Everything the screen shows about one subject, worked out from scratch. */
function subjectStats(s, today) {
  const todayISO = isoOf(today);
  const logged = loggedFor(s.id);
  const done = s.base + logged;
  const doneToday = loggedFor(s.id, todayISO, todayISO);
  const remaining = Math.max(s.total - done, 0);
  const complete = remaining <= 1e-9;
  const deadline = parseISO(s.deadline);
  const daysToDeadline = daysBetween(today, deadline);        // 0 = due today
  const overdue = !complete && daysToDeadline < 0;

  // Pace needed: what was left at the start of today, over the study days left.
  // Using the start of the day keeps the number steady while you log.
  const remAtDayStart = Math.max(s.total - (done - doneToday), 0);
  let pace = 0;
  if (!complete && !overdue) {
    const sd = studyDaysBetween(today, deadline);
    pace = remAtDayStart / (sd > 0 ? sd : daysToDeadline + 1);
  }

  // This week's goal: what's already done this week plus today's pace over the
  // study days left in the week. A slow Monday therefore never inflates it. The
  // shortfall is spread over the days ahead instead.
  const weekStart = weekStartOf(today);
  const weekEnd = addDays(weekStart, 6);
  const from = minDate(maxDate(weekStart, parseISO(s.start) || weekStart), today);
  const fromISO = isoOf(from);
  const weekDoneBefore = from < today ? loggedFor(s.id, fromISO, isoOf(addDays(today, -1))) : 0;
  let weekGoal = 0;
  if (!complete && !overdue) {
    const sdWeek = studyDaysBetween(today, minDate(weekEnd, deadline));
    weekGoal = weekDoneBefore + Math.min(Math.ceil(pace * sdWeek - 1e-9), remAtDayStart);
  }
  const weekDone = loggedFor(s.id, fromISO, isoOf(weekEnd));

  // How today's pace compares with the pace the plan started at
  const start = parseISO(s.start) || today;
  const sdOrig = Math.max(studyDaysBetween(start, deadline), 1);
  const orig = Math.max(s.total - s.base, 0) / sdOrig;
  const ratio = orig > 0 ? pace / orig : 1;

  let status;
  if (complete) status = { key: "done", label: "Done" };
  else if (overdue) status = { key: "overdue", label: "Past deadline" };
  else if (pace > 6 || ratio > 1.5) status = { key: "tight", label: "Tight" };
  else if (ratio > 1.1) status = { key: "speedup", label: "Speed up" };
  else if (ratio <= 0.9 && done > s.base) status = { key: "ahead", label: "Ahead" };
  else status = { key: "ontrack", label: "On track" };

  return {
    done, doneToday, remaining, complete, overdue, deadline, daysToDeadline,
    pace, weekGoal, weekDone, status,
    pct: s.total > 0 ? Math.min(done / s.total, 1) * 100 : 0,
  };
}

/* Consecutive days with at least one lecture logged. Rest days never break it,
   and today doesn't count against you until it is over. */
function currentStreak() {
  const days = new Set(state.logs.map(l => l.date));
  let d = todayDate();
  if (!days.has(isoOf(d))) d = addDays(d, -1);
  let streak = 0;
  for (let i = 0; i < 4000; i++) {
    if (days.has(isoOf(d))) streak++;
    else if (!isRestDay(d)) break;
    d = addDays(d, -1);
  }
  return streak;
}

function lecturesThisWeek() {
  const ws = weekStartOf(todayDate());
  const a = isoOf(ws), b = isoOf(addDays(ws, 6));
  return state.logs.reduce((s, l) => (l.date >= a && l.date <= b ? s + l.lectures : s), 0);
}

function overallTotals() {
  let total = 0, done = 0;
  state.subjects.forEach(s => {
    total += s.total;
    done += Math.min(s.base + loggedFor(s.id), s.total);
  });
  return { total, done };
}

/* =========================================================
   RENDERING
   Cards are kept and updated in place (not rebuilt) so the
   progress bars slide instead of restarting.
   ========================================================= */
const $ = id => document.getElementById(id);
const cardEls = new Map();      // subject id -> <article>
const historyEls = new Map();   // log id -> <li>

function setBarWidth(fill, pct) {
  const w = Math.max(0, Math.min(pct, 100));
  if (fill._w === undefined) {
    fill._w = w;
    fill.style.width = "0%";
    setTimeout(() => { fill.style.width = `${fill._w}%`; }, 30);
  } else {
    fill._w = w;
    fill.style.width = `${w}%`;
  }
}

function sortedSubjects(today) {
  return state.subjects
    .map(s => ({ s, st: subjectStats(s, today) }))
    .sort((a, b) =>
      (a.st.complete - b.st.complete) ||
      a.st.deadline.getTime() - b.st.deadline.getTime() ||
      a.s.name.localeCompare(b.s.name));
}

function daysLeftText(st) {
  const n = st.daysToDeadline;
  if (n < 0) return `deadline was ${fmtShortDate(st.deadline)}`;
  if (n === 0) return "due today";
  return `${n} ${plural(n, "day")} left`;
}

function createCard(id) {
  const el = document.createElement("article");
  el.className = "subject";
  el.dataset.id = id;
  el.innerHTML = `
    <div class="subject-head">
      <span class="dot"></span>
      <h3 class="subject-name"></h3>
      <span class="chip"></span>
      <button type="button" class="icon-btn js-edit" aria-label="Edit subject">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="subject-count"><span class="js-count"></span><span class="js-pct muted"></span></div>
    <div class="bar"><div class="bar-fill"></div></div>
    <p class="subject-meta js-week"></p>
    <p class="subject-meta muted js-pace"></p>
    <div class="stepper">
      <button type="button" class="step-btn js-minus" aria-label="Remove one lecture from today">−</button>
      <span class="stepper-label"><strong class="js-today">0</strong> today</span>
      <button type="button" class="step-btn step-plus js-plus" aria-label="Add one lecture to today">+</button>
    </div>`;
  return el;
}

function updateCard(el, s, st) {
  const q = sel => el.querySelector(sel);
  el.style.setProperty("--c", s.color);
  el.classList.toggle("is-done", st.complete);
  q(".subject-name").textContent = s.name;

  const chip = q(".chip");
  chip.textContent = st.status.label;
  chip.className = `chip chip-${st.status.key}`;

  q(".js-count").textContent = `${fmtNum(st.done)} / ${fmtNum(s.total)} lectures`;
  q(".js-pct").textContent = `${Math.round(st.pct)}%`;
  setBarWidth(q(".bar-fill"), st.pct);

  const week = q(".js-week");
  const pace = q(".js-pace");
  if (st.complete) {
    week.textContent = "All lectures finished.";
    pace.textContent = "";
  } else if (st.overdue) {
    week.textContent = `${fmtNum(st.remaining)} left, ${daysLeftText(st)}.`;
    pace.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn js-edit";
    btn.textContent = "Set a new deadline";
    pace.appendChild(btn);
  } else {
    week.textContent = st.weekGoal > 0
      ? `This week ${fmtNum(st.weekDone)} / ${st.weekGoal}${st.weekDone >= st.weekGoal ? " ✓" : ""}`
      : `This week ${fmtNum(st.weekDone)}`;
    pace.textContent = `About ${fmtPace(st.pace)} a day · ${daysLeftText(st)} · by ${fmtShortDate(st.deadline)}`;
  }

  q(".js-today").textContent = fmtNum(st.doneToday);
  q(".js-minus").disabled = st.doneToday <= 0;
  q(".js-plus").disabled = st.complete;
}

function renderSummary(rows, today) {
  const sum = $("summary");
  sum.hidden = rows.length === 0;
  if (!rows.length) return;

  const { total, done } = overallTotals();
  const pct = total > 0 ? (done / total) * 100 : 0;
  $("sum-pct").textContent = `${Math.floor(pct)}%`;
  $("sum-sub").textContent = `${fmtNum(done)} of ${fmtNum(total)} lectures`;
  setBarWidth($("sum-bar"), pct);

  const open = rows.filter(r => !r.st.complete && !r.st.overdue);
  const goal = open.reduce((n, r) => n + r.st.weekGoal, 0);
  const weekDone = open.reduce((n, r) => n + Math.min(r.st.weekDone, r.st.weekGoal || r.st.weekDone), 0);
  $("sum-week").textContent = goal > 0 ? `${fmtNum(weekDone)} / ${goal}` : "—";
  $("sum-streak").textContent = String(currentStreak());

  const next = open.slice().sort((a, b) => a.st.deadline - b.st.deadline)[0];
  if (next) {
    $("sum-next").textContent = fmtShortDate(next.st.deadline);
    $("sum-next-label").textContent = next.s.name;
  } else {
    $("sum-next").textContent = "—";
    $("sum-next-label").textContent = "next deadline";
  }
}

function renderHistory() {
  const wrap = $("history");
  wrap.hidden = state.subjects.length === 0;
  if (wrap.hidden) return;
  const list = $("history-list");
  const recent = state.logs.slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 10);

  const keep = new Set();
  recent.forEach(l => {
    keep.add(l.id);
    let li = historyEls.get(l.id);
    if (!li) {
      li = document.createElement("li");
      li.innerHTML = `<span class="dot"></span><span class="h-date"></span><span class="h-name"></span><strong class="h-count"></strong>
        <button type="button" class="icon-btn js-del" aria-label="Delete this entry">×</button>`;
      li.dataset.id = l.id;
      historyEls.set(l.id, li);
    }
    const s = subjectById(l.subject);
    li.style.setProperty("--c", s ? s.color : "var(--soft)");
    li.querySelector(".h-date").textContent = fmtShortDate(parseISO(l.date));
    li.querySelector(".h-name").textContent = s ? s.name : "";
    li.querySelector(".h-count").textContent = fmtNum(l.lectures);
    list.appendChild(li);
  });
  historyEls.forEach((li, id) => {
    if (!keep.has(id)) { li.remove(); historyEls.delete(id); }
  });
}

function render() {
  const today = todayDate();
  const rows = sortedSubjects(today);

  $("empty-state").hidden = rows.length > 0;
  $("add-subject-btn").hidden = rows.length === 0;

  const list = $("subject-list");
  const keep = new Set();
  rows.forEach(({ s, st }) => {
    keep.add(s.id);
    let el = cardEls.get(s.id);
    if (!el) { el = createCard(s.id); cardEls.set(s.id, el); }
    updateCard(el, s, st);
    list.appendChild(el);
  });
  cardEls.forEach((el, id) => {
    if (!keep.has(id)) { el.remove(); cardEls.delete(id); }
  });

  renderSummary(rows, today);
  renderHistory();
}

/* =========================================================
   LOGGING
   ========================================================= */
function addLog(subjectId, dateISO, count) {
  const existing = state.logs.find(l => l.subject === subjectId && l.date === dateISO);
  if (existing) existing.lectures += count;
  else state.logs.push({ id: uid(), date: dateISO, subject: subjectId, lectures: count });
}

function stepToday(subjectId, delta) {
  const s = subjectById(subjectId);
  if (!s) return;
  const todayISO = isoOf(todayDate());
  if (delta > 0) {
    if (s.base + loggedFor(s.id) >= s.total) { showToast("That subject is already complete."); return; }
    addLog(s.id, todayISO, 1);
    const st = subjectStats(s, todayDate());
    if (st.complete) showToast(`${s.name} complete. Well done!`);
  } else {
    const entry = state.logs.find(l => l.subject === s.id && l.date === todayISO);
    if (!entry) return;
    entry.lectures -= 1;
    if (entry.lectures <= 0) state.logs = state.logs.filter(l => l !== entry);
  }
  saveState();
  render();
}

function deleteLog(id) {
  state.logs = state.logs.filter(l => l.id !== id);
  saveState();
  render();
}

/* =========================================================
   MODALS
   ========================================================= */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
function closeAllModals() {
  ["subject-modal", "log-modal", "settings-modal"].forEach(closeModal);
}

/* ---------- add / edit subject ---------- */
let editingId = null;
let chosenColor = PALETTE[0];

function nextColor() {
  const used = new Set(state.subjects.map(s => s.color));
  return PALETTE.find(c => !used.has(c)) || PALETTE[state.subjects.length % PALETTE.length];
}

function renderSwatches() {
  const wrap = $("sub-swatches");
  wrap.innerHTML = "";
  PALETTE.forEach(c => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (c === chosenColor ? " is-on" : "");
    b.style.setProperty("--c", c);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", c === chosenColor ? "true" : "false");
    b.setAttribute("aria-label", `Colour ${c}`);
    b.addEventListener("click", () => { chosenColor = c; renderSwatches(); });
    wrap.appendChild(b);
  });
}

function openSubjectModal(id) {
  editingId = id || null;
  const s = id ? subjectById(id) : null;
  const todayISO = isoOf(todayDate());

  $("subject-modal-title").textContent = s ? "Edit subject" : "Add subject";
  $("sub-name").value = s ? s.name : "";
  $("sub-total").value = s ? s.total : "";
  $("sub-base").value = s ? s.base : 0;
  $("sub-deadline").value = s ? s.deadline : "";
  $("sub-deadline").min = s ? "" : todayISO;
  $("sub-delete-btn").hidden = !s;
  $("sub-error").hidden = true;
  chosenColor = s ? s.color : nextColor();
  renderSwatches();
  updateSubjectPreview();
  openModal("subject-modal");
  $("sub-name").focus();
}

/* "About 1.6 lectures a day" as you type, so the target isn't a surprise */
function updateSubjectPreview() {
  const el = $("sub-preview");
  const total = Math.round(num($("sub-total").value));
  const base = Math.max(Math.round(num($("sub-base").value)), 0);
  const dl = parseISO($("sub-deadline").value);
  el.textContent = "";
  if (total < 1 || !dl) return;

  const logged = editingId ? loggedFor(editingId) : 0;
  const remaining = Math.max(total - base - logged, 0);
  if (remaining === 0) { el.textContent = "That's already complete."; return; }
  const today = todayDate();
  if (dl < today) { el.textContent = "That date has already passed."; return; }

  const sd = studyDaysBetween(today, dl) || daysBetween(today, dl) + 1;
  const perDay = remaining / sd;
  const perWeek = Math.ceil(perDay * studyDaysPerWeek() - 1e-9);
  el.textContent = `${fmtNum(remaining)} to go: about ${fmtPace(perDay)} a day, or ${perWeek} a week, until then.`;
}

function handleSubjectSubmit(e) {
  e.preventDefault();
  const err = $("sub-error");
  const fail = msg => { err.textContent = msg; err.hidden = false; };

  const name = $("sub-name").value.trim().slice(0, 40);
  const total = Math.round(num($("sub-total").value));
  const base = Math.max(Math.round(num($("sub-base").value)), 0);
  const deadlineStr = $("sub-deadline").value;
  const deadline = parseISO(deadlineStr);
  const today = todayDate();

  if (!name) return fail("Give the subject a name.");
  if (!(total >= 1)) return fail("Enter how many lectures there are (at least 1).");
  if (base > total) return fail("'Already done' can't be more than the total.");
  if (!deadline) return fail("Pick the date you want to finish by.");
  if (!editingId && deadline < today) return fail("Pick a date from today onwards.");

  if (editingId) {
    const s = subjectById(editingId);
    if (!s) { closeModal("subject-modal"); return; }
    s.name = name; s.total = total; s.base = base; s.deadline = deadlineStr; s.color = chosenColor;
  } else {
    state.subjects.push({ id: uid(), name, total, base, deadline: deadlineStr, start: isoOf(today), color: chosenColor });
  }
  saveState();
  closeModal("subject-modal");
  render();
  showToast(editingId ? "Subject updated." : `${name} added.`);
}

function handleSubjectDelete() {
  const s = subjectById(editingId);
  if (!s) return;
  const n = state.logs.filter(l => l.subject === s.id).length;
  const msg = n
    ? `Delete "${s.name}" and its ${n} logged ${n === 1 ? "entry" : "entries"}? This can't be undone.`
    : `Delete "${s.name}"?`;
  if (!window.confirm(msg)) return;
  state.subjects = state.subjects.filter(x => x.id !== s.id);
  state.logs = state.logs.filter(l => l.subject !== s.id);
  saveState();
  closeModal("subject-modal");
  render();
  showToast("Subject deleted.");
}

/* ---------- log a past day ---------- */
function openLogModal() {
  if (!state.subjects.length) return;
  const sel = $("log-subject");
  sel.innerHTML = "";
  state.subjects.forEach(s => {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  });
  const todayISO = isoOf(todayDate());
  $("log-date").max = todayISO;
  $("log-date").value = todayISO;
  $("log-count").value = 1;
  openModal("log-modal");
}

function handleLogSubmit(e) {
  e.preventDefault();
  const s = subjectById($("log-subject").value);
  const dateISO = $("log-date").value;
  const count = Math.round(num($("log-count").value));
  if (!s || !parseISO(dateISO) || count < 1) return;
  if (dateISO > isoOf(todayDate())) { showToast("That date is in the future."); return; }
  addLog(s.id, dateISO, count);
  saveState();
  closeModal("log-modal");
  render();
  showToast(`Logged ${count} for ${s.name}.`);
}

/* ---------- settings ---------- */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];                 // Monday first
const DAY_NAMES = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };
let restDraft = [];

function renderRestButtons() {
  const wrap = $("set-rest");
  wrap.innerHTML = "";
  DAY_ORDER.forEach(d => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day" + (restDraft.includes(d) ? " is-on" : "");
    b.textContent = DAY_NAMES[d];
    b.setAttribute("aria-pressed", restDraft.includes(d) ? "true" : "false");
    b.addEventListener("click", () => {
      restDraft = restDraft.includes(d) ? restDraft.filter(x => x !== d) : restDraft.concat([d]);
      renderRestButtons();
    });
    wrap.appendChild(b);
  });
}

function openSettings() {
  $("set-name").value = state.userName || "";
  $("account-email").textContent = currentUser && currentUser.email ? `Signed in as ${currentUser.email}` : "";
  restDraft = state.restDays.slice();
  renderRestButtons();
  openModal("settings-modal");
}

function handleSettingsSubmit(e) {
  e.preventDefault();
  if (restDraft.length >= 7) { showToast("Keep at least one study day."); return; }
  state.userName = $("set-name").value.trim().slice(0, 40);
  state.restDays = restDraft.slice().sort();
  saveState();
  closeModal("settings-modal");
  render();
  if (!$("view-leaderboard").hidden) renderLeaderboard();
  showToast("Settings saved.");
}

function handleExport() {
  const data = JSON.stringify(state, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `lecture-tracker-${isoOf(todayDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function handleReset() {
  if (!window.confirm("Delete all your subjects and logged lectures? This can't be undone.")) return;
  const keepName = state.userName;
  state = emptyState();
  state.userName = keepName;
  saveState();
  closeModal("settings-modal");
  render();
  showToast("All data deleted.");
}

/* ---------- tabs ---------- */
function switchView(view) {
  $("view-tracker").hidden = view !== "tracker";
  $("view-leaderboard").hidden = view !== "leaderboard";
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("is-active", t.dataset.view === view);
    t.setAttribute("aria-current", t.dataset.view === view ? "page" : "false");
  });
  if (view === "leaderboard") enterLeaderboard(); else leaveLeaderboard();
}

/* =========================================================
   LEADERBOARD
   Everyone's real data stays private in users/{uid}. For the
   board, each signed-in person publishes a small public summary
   to leaderboard/{uid}: name, lecture totals, this week's count
   and streak. Subject names and notes are never shared.
   Rules for this are in FIRESTORE-RULES.txt.
   ========================================================= */
const LB_COLLECTION = "leaderboard";
const LB_ACTIVE_DAYS = 14;
const LB = {
  entries: [],        // other people's summaries from the last fetch
  sort: "overall",    // "overall" | "week"
  loading: false,
  loadedAt: 0,
  error: null,
  publishDenied: false,
  rows: new Map(),    // uid -> <li>, reused between refreshes
  timer: null,
  announced: false,   // "you're first" toast, once per visit
};
let lbPublishTimer = null;

function buildLeaderboardEntry() {
  const { total, done } = overallTotals();
  const dates = state.logs.map(l => l.date).sort();
  return {
    uid: currentUser ? currentUser.uid : "",
    name: String(state.userName || "").trim().slice(0, 40),
    done,
    total,
    pct: total > 0 ? Math.min(Math.round((done / total) * 1000) / 10, 100) : 0,
    weekDone: lecturesThisWeek(),
    weekStart: isoOf(weekStartOf(todayDate())),
    streak: currentStreak(),
    lastLogDate: dates.length ? dates[dates.length - 1] : null,
    subjectCount: state.subjects.length,
  };
}

function scheduleLeaderboardPublish(delay) {
  if (!currentUser || !cloudReady || state.showOnLeaderboard === false) return;
  clearTimeout(lbPublishTimer);
  lbPublishTimer = setTimeout(publishLeaderboardEntry, typeof delay === "number" ? delay : 1500);
}

function publishLeaderboardEntry() {
  if (!currentUser || !cloudReady || state.showOnLeaderboard === false) return Promise.resolve();
  let entry;
  try {
    entry = buildLeaderboardEntry();
    entry.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  } catch (err) {
    console.warn("Could not prepare the leaderboard entry:", err);
    return Promise.resolve();
  }
  return db.collection(LB_COLLECTION).doc(currentUser.uid).set(entry)
    .then(() => { LB.publishDenied = false; })
    .catch(err => {
      if (err && err.code === "permission-denied") LB.publishDenied = true;
      console.warn("Could not update the leaderboard entry:", err);
    });
}

function removeLeaderboardEntry() {
  if (!currentUser) return Promise.resolve();
  return db.collection(LB_COLLECTION).doc(currentUser.uid).delete()
    .catch(err => console.warn("Could not remove the leaderboard entry:", err));
}

function normalizeLbEntry(id, data) {
  const d = data && typeof data === "object" ? data : {};
  return {
    uid: String(id),
    name: String(d.name || "").trim().slice(0, 40),
    done: Math.max(num(d.done), 0),
    total: Math.max(num(d.total), 0),
    pct: Math.min(Math.max(num(d.pct), 0), 100),
    weekDone: Math.max(num(d.weekDone), 0),
    weekStart: typeof d.weekStart === "string" ? d.weekStart : "",
    streak: Math.max(Math.round(num(d.streak)), 0),
    updatedMs: d.updatedAt && typeof d.updatedAt.toMillis === "function" ? d.updatedAt.toMillis() : 0,
  };
}

function loadLeaderboard(silent) {
  if (!currentUser || LB.loading) return Promise.resolve();
  LB.loading = true;
  if (!silent) renderLeaderboard();
  return withTimeout(
    db.collection(LB_COLLECTION).orderBy("pct", "desc").limit(200).get(),
    10000,
    "Leaderboard read"
  )
    .then(snap => {
      LB.entries = snap.docs.map(doc => normalizeLbEntry(doc.id, doc.data()));
      LB.error = null;
      LB.loadedAt = Date.now();
    })
    .catch(err => {
      LB.error = err || new Error("Leaderboard unavailable");
      console.warn("Could not load the leaderboard:", err);
    })
    .then(() => {
      LB.loading = false;
      try { renderLeaderboard(); } catch (err) { console.error("Leaderboard render failed:", err); }
    });
}

function enterLeaderboard() {
  try { renderLeaderboard(); } catch (err) { console.error("Leaderboard render failed:", err); }
  publishLeaderboardEntry().then(() => loadLeaderboard(false));
  clearInterval(LB.timer);
  LB.timer = setInterval(() => loadLeaderboard(true), 60000);
}

function leaveLeaderboard() {
  clearInterval(LB.timer);
  LB.timer = null;
}

function resetLeaderboardUI() {
  leaveLeaderboard();
  clearTimeout(lbPublishTimer);
  LB.entries = [];
  LB.rows.clear();
  LB.loading = false;
  LB.loadedAt = 0;
  LB.error = null;
  LB.publishDenied = false;
  LB.announced = false;
  const list = $("lb-list");
  if (list) list.innerHTML = "";
}

function lbDisplayName(e) { return e.name || `Student #${e.uid.slice(0, 4).toUpperCase()}`; }

/* Medal artwork: inline SVG so it looks the same everywhere */
function medalSvg(rank, size) {
  const palette = {
    1: { face: "#F2C94C", rim: "#B8860B", a: "#E85D3D", b: "#B8431F", ink: "#6B4A00" },
    2: { face: "#DDE3E9", rim: "#8A949E", a: "#5C7FA3", b: "#3F5F82", ink: "#4A5560" },
    3: { face: "#E0A06A", rim: "#8C5524", a: "#2FA792", b: "#1F7F6E", ink: "#5E3512" },
  };
  const p = palette[rank] || palette[3];
  const h = Math.round((size * 64) / 48);
  return `<svg class="medal medal-${rank}" viewBox="0 0 48 64" width="${size}" height="${h}" aria-hidden="true" focusable="false">
    <polygon points="26,0 40,0 33,28 19,28" fill="${p.b}"/>
    <polygon points="8,0 22,0 29,28 15,28" fill="${p.a}"/>
    <circle cx="24" cy="42" r="20" fill="${p.rim}"/>
    <circle cx="24" cy="42" r="16.5" fill="${p.face}"/>
    <circle cx="24" cy="42" r="12.5" fill="none" stroke="${p.rim}" stroke-width="1.2" stroke-dasharray="2 2.4"/>
    <text x="24" y="48" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="17" font-weight="700" fill="${p.ink}">${rank}</text>
  </svg>`;
}

function lbSeenLabel(e, now) {
  if (e.self) return "you";
  if (!e.updatedMs) return "";
  const days = Math.floor((now - e.updatedMs) / DAY_MS);
  if (days <= 0) return "active today";
  if (days === 1) return "active yesterday";
  return `active ${days} days ago`;
}

/* Everything the screen needs, from the last fetch plus your live numbers */
function lbViewModel() {
  const now = Date.now();
  const myUid = currentUser ? currentUser.uid : null;
  const thisWeek = isoOf(weekStartOf(todayDate()));
  const byUid = new Map();
  LB.entries.forEach(e => byUid.set(e.uid, e));

  if (myUid) {
    if (state.showOnLeaderboard !== false) {
      byUid.set(myUid, { ...normalizeLbEntry(myUid, buildLeaderboardEntry()), updatedMs: now });
    } else {
      byUid.delete(myUid);
    }
  }

  let list = Array.from(byUid.values()).map(e => ({
    ...e,
    self: e.uid === myUid,
    // a week count from an earlier week doesn't belong in this week's ranking
    weekCount: e.weekStart === thisWeek ? e.weekDone : 0,
  })).filter(e => e.self || (e.updatedMs > 0 && now - e.updatedMs <= LB_ACTIVE_DAYS * DAY_MS));

  const metric = e => (LB.sort === "week" ? e.weekCount : e.pct);
  const tie = e => (LB.sort === "week" ? e.pct : e.done);
  list.sort((a, b) =>
    (metric(b) - metric(a)) || (tie(b) - tie(a)) || (b.streak - a.streak) ||
    lbDisplayName(a).localeCompare(lbDisplayName(b)));

  // Ties share a rank. A medal needs real progress behind it.
  const better = (a, b) => metric(a) > metric(b) + 1e-9 || (Math.abs(metric(a) - metric(b)) <= 1e-9 && tie(a) > tie(b) + 1e-9);
  const ranked = list.map(e => {
    const rank = 1 + list.filter(o => better(o, e)).length;
    return { ...e, rank, medal: metric(e) > 0 && rank <= 3 ? rank : 0 };
  });
  return { list: ranked, now };
}

function lbCreateRow(id) {
  const li = document.createElement("li");
  li.className = "lb-row";
  li.dataset.uid = id;
  li.innerHTML = `
    <div class="lb-rank"><span class="lb-rank-num"></span><span class="lb-medal"></span></div>
    <div class="lb-main">
      <div class="lb-name-line"><span class="lb-name"></span><span class="lb-you">You</span></div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="lb-meta"><span class="js-done"></span><span class="js-week"></span><span class="js-streak"></span><span class="js-seen"></span></div>
    </div>
    <div class="lb-score"></div>`;
  return li;
}

function lbUpdateRow(li, e, now) {
  const q = sel => li.querySelector(sel);
  li.classList.toggle("is-self", e.self);
  li.classList.toggle("is-gold", e.medal === 1);
  li.style.setProperty("--c", e.medal === 1 ? "#E3A91E" : e.self ? "var(--accent)" : "var(--soft)");

  const rankNum = q(".lb-rank-num");
  rankNum.textContent = String(e.rank);
  rankNum.hidden = e.medal > 0;
  const medalEl = q(".lb-medal");
  const key = e.medal ? String(e.medal) : "";
  if (medalEl.dataset.medal !== key) {
    medalEl.dataset.medal = key;
    medalEl.innerHTML = e.medal ? medalSvg(e.medal, 32) : "";
  }
  q(".lb-name").textContent = lbDisplayName(e);
  q(".lb-you").hidden = !e.self;
  q(".js-done").textContent = `${fmtNum(e.done)} / ${fmtNum(e.total)} lectures`;
  q(".js-week").textContent = `${fmtNum(e.weekCount)} this week`;
  q(".js-streak").textContent = e.streak > 0 ? `${e.streak} day streak` : "";
  q(".js-seen").textContent = lbSeenLabel(e, now);
  setBarWidth(q(".bar-fill"), LB.sort === "week" ? Math.min((e.weekCount / Math.max(maxWeek(), 1)) * 100, 100) : e.pct);
  q(".lb-score").textContent = LB.sort === "week" ? fmtNum(e.weekCount) : `${e.pct.toFixed(1)}%`;
}

let lbMaxWeek = 1;
function maxWeek() { return lbMaxWeek; }

function lbStatusMessage(vm) {
  const rulesHint = "The leaderboard isn't switched on in your Firebase project yet. Add the leaderboard rules from FIRESTORE-RULES.txt (Firebase console → Firestore → Rules), then tap Refresh. Until then you only see yourself here.";
  if (LB.error) {
    if (LB.error.code === "permission-denied") return { text: rulesHint, warn: true };
    return { text: "Couldn't reach the leaderboard. Check your connection and tap Refresh.", warn: true };
  }
  if (LB.publishDenied) return { text: rulesHint, warn: true };
  if (LB.loading && !LB.loadedAt) return { text: "Loading…", warn: false };
  if (state.showOnLeaderboard === false) return { text: "You're hidden from the leaderboard. Tick the box below to join in.", warn: false };
  if (vm.list.length === 1 && vm.list[0].self) return { text: "You're the first one here. Invite a friend and start the race.", warn: false };
  if (vm.list.length === 0) return { text: "Nobody here yet.", warn: false };
  return { text: "", warn: false };
}

function renderLeaderboard() {
  const listEl = $("lb-list");
  if (!listEl) return;
  const vm = lbViewModel();
  lbMaxWeek = vm.list.reduce((m, e) => Math.max(m, e.weekCount), 1);

  document.querySelectorAll("[data-lb-sort]").forEach(b => b.classList.toggle("is-active", b.dataset.lbSort === LB.sort));
  $("lb-optin").checked = state.showOnLeaderboard !== false;
  $("lb-refresh-btn").disabled = LB.loading;
  $("lb-name-hint").hidden = !!state.userName || state.showOnLeaderboard === false;

  const msg = lbStatusMessage(vm);
  $("lb-status").hidden = !msg.text;
  $("lb-status").textContent = msg.text;
  $("lb-status").classList.toggle("is-warn", msg.warn);
  $("lb-updated").textContent = LB.loadedAt
    ? `Updated ${new Date(LB.loadedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Refreshes every minute while this tab is open.`
    : "";

  const champ = vm.list.find(e => e.medal === 1) || null;
  $("lb-champion").hidden = !champ;
  if (champ) {
    $("lb-champ-medal").innerHTML = medalSvg(1, 56);
    $("lb-champ-name").textContent = lbDisplayName(champ);
    $("lb-champ-kicker").textContent = champ.self ? "You hold the gold medal" : (LB.sort === "week" ? "Gold medal · this week" : "Gold medal");
    $("lb-champ-sub").textContent = LB.sort === "week"
      ? `${fmtNum(champ.weekCount)} ${plural(champ.weekCount, "lecture")} this week`
      : `${champ.pct.toFixed(1)}% done · ${fmtNum(champ.done)} of ${fmtNum(champ.total)} lectures`;
  }

  const keep = new Set();
  vm.list.forEach(e => {
    keep.add(e.uid);
    let li = LB.rows.get(e.uid);
    if (!li) { li = lbCreateRow(e.uid); LB.rows.set(e.uid, li); }
    lbUpdateRow(li, e, vm.now);
    listEl.appendChild(li);
  });
  LB.rows.forEach((li, id) => {
    if (!keep.has(id)) { li.remove(); LB.rows.delete(id); }
  });

  if (champ && champ.self && LB.loadedAt && !LB.error && !LB.announced && !$("view-leaderboard").hidden) {
    LB.announced = true;
    showToast("You're in first place. The gold medal is yours.");
  }
}

function handleLeaderboardOptIn(checked) {
  state.showOnLeaderboard = !!checked;
  clearTimeout(lbPublishTimer);
  saveState();
  if (state.showOnLeaderboard) {
    publishLeaderboardEntry().then(() => loadLeaderboard(false));
  } else {
    removeLeaderboardEntry().then(() => loadLeaderboard(false));
    renderLeaderboard();
  }
}

/* =========================================================
   SIGN IN / SIGN OUT
   ========================================================= */
let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  $("tab-login").classList.toggle("is-active", mode === "login");
  $("tab-signup").classList.toggle("is-active", mode === "signup");
  $("auth-submit-btn").textContent = mode === "login" ? "Log in" : "Create account";
  $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("forgot-btn").hidden = mode !== "login";
  hideAuthMessage();
}

function showAuthMessage(text, warn) {
  const el = $("auth-message");
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle("is-warn", !!warn);
}
function hideAuthMessage() { $("auth-message").hidden = true; }

function friendlyAuthError(err) {
  switch (err && err.code) {
    case "auth/invalid-email": return "That email address doesn't look right.";
    case "auth/user-not-found": return "No account found with that email. Try 'Create account' instead.";
    case "auth/wrong-password": case "auth/invalid-credential": return "Incorrect email or password.";
    case "auth/email-already-in-use": return "An account already exists with that email. Try 'Log in' instead.";
    case "auth/weak-password": return "Password should be at least 6 characters.";
    case "auth/too-many-requests": return "Too many attempts. Wait a moment and try again.";
    default: return (err && err.message) || "Something went wrong. Please try again.";
  }
}

function handleAuthSubmit(e) {
  e.preventDefault();
  hideAuthMessage();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const btn = $("auth-submit-btn");
  btn.disabled = true;
  const action = authMode === "login"
    ? auth.signInWithEmailAndPassword(email, password)
    : auth.createUserWithEmailAndPassword(email, password);
  action
    .catch(err => showAuthMessage(friendlyAuthError(err), true))
    .then(() => { btn.disabled = false; });
}

function handleForgotPassword() {
  const email = $("auth-email").value.trim();
  if (!email) { showAuthMessage("Type your email above first, then tap 'Forgot password?'.", true); return; }
  auth.sendPasswordResetEmail(email)
    .then(() => showAuthMessage("Check your inbox for a link to reset your password.", false))
    .catch(err => showAuthMessage(friendlyAuthError(err), true));
}

/* =========================================================
   LOADING YOUR DATA
   Show the tracker straight away from the copy on this device,
   then read the saved copy from your account in the background.
   Anything you change before that read finishes is kept.
   ========================================================= */
function revealApp() {
  $("app-loading").hidden = true;
  $("auth-screen").hidden = true;
  $("board").hidden = false;
  try {
    render();
  } catch (err) {
    console.error("Render failed:", err);
  }
}

function syncFromCloud(user, attempt) {
  withTimeout(db.collection("users").doc(user.uid).get(), 8000, "Account read")
    .then(doc => {
      if (!currentUser || currentUser.uid !== user.uid) return;
      let needsPush = false;
      if (doc.exists && pendingWrite && startedEmpty) {
        // First visit on this device: keep what is saved AND what was just added
        state = mergeLocalIntoCloud(normalizeState(doc.data()), state);
        needsPush = true;
        try { localStorage.setItem(cacheKey(user.uid), JSON.stringify(state)); } catch (e) { /* cache is optional */ }
      } else if (doc.exists && !pendingWrite) {
        const raw = doc.data();
        state = normalizeState(raw);
        // old GATE-only data was converted: save it in the new shape
        needsPush = !raw || raw.version !== STATE_VERSION;
        try { localStorage.setItem(cacheKey(user.uid), JSON.stringify(state)); } catch (e) { /* cache is optional */ }
      } else {
        // new account, or edits made on this device before the read finished
        needsPush = true;
      }
      cloudReady = true;
      pendingWrite = false;
      revealApp();
      if (needsPush) pushToCloud();
      scheduleLeaderboardPublish(800);
    })
    .catch(err => {
      console.warn("Could not read your account yet:", err);
      if (attempt === 0) showToast("Working from this device. Reconnecting…");
      if (attempt < 20 && currentUser && currentUser.uid === user.uid) {
        clearTimeout(syncRetryTimer);
        syncRetryTimer = setTimeout(() => syncFromCloud(user, attempt + 1), 15000);
      }
    });
}

/* Saved account data plus anything added on this device before it loaded */
function mergeLocalIntoCloud(cloud, local) {
  const subjects = cloud.subjects.slice();
  const subjectIds = new Set(subjects.map(s => s.id));
  local.subjects.forEach(s => { if (!subjectIds.has(s.id)) subjects.push(s); });
  const logs = cloud.logs.slice();
  const logIds = new Set(logs.map(l => l.id));
  local.logs.forEach(l => { if (!logIds.has(l.id)) logs.push(l); });
  return normalizeState({ ...cloud, subjects, logs });
}

function initApp(user) {
  $("app-loading").hidden = false;
  $("auth-screen").hidden = true;
  cloudReady = false;
  pendingWrite = false;
  clearTimeout(syncRetryTimer);
  const cached = readCachedState(user.uid);
  startedEmpty = !cached;
  state = cached || emptyState();
  revealApp();
  syncFromCloud(user, 0);
}

function teardownApp() {
  cloudReady = false;
  pendingWrite = false;
  startedEmpty = false;
  clearTimeout(syncRetryTimer);
  resetLeaderboardUI();
  state = emptyState();
  cardEls.forEach(el => el.remove());
  cardEls.clear();
  historyEls.forEach(li => li.remove());
  historyEls.clear();
  closeAllModals();
  switchView("tracker");
  $("board").hidden = true;
  $("app-loading").hidden = true;
  $("auth-screen").hidden = false;
  $("auth-email").value = "";
  $("auth-password").value = "";
  hideAuthMessage();
}

auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) initApp(user);
  else teardownApp();
});

/* =========================================================
   WIRING
   ========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  // sign in
  $("tab-login").addEventListener("click", () => setAuthMode("login"));
  $("tab-signup").addEventListener("click", () => setAuthMode("signup"));
  $("auth-form").addEventListener("submit", handleAuthSubmit);
  $("forgot-btn").addEventListener("click", handleForgotPassword);

  // tabs + header
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));
  $("settings-btn").addEventListener("click", openSettings);

  // subjects
  $("add-subject-btn").addEventListener("click", () => openSubjectModal(null));
  $("empty-add-btn").addEventListener("click", () => openSubjectModal(null));
  $("subject-form").addEventListener("submit", handleSubjectSubmit);
  $("sub-cancel-btn").addEventListener("click", () => closeModal("subject-modal"));
  $("sub-delete-btn").addEventListener("click", handleSubjectDelete);
  ["sub-total", "sub-base", "sub-deadline"].forEach(id => $(id).addEventListener("input", updateSubjectPreview));

  // card buttons (one listener for all cards)
  $("subject-list").addEventListener("click", e => {
    const card = e.target.closest(".subject");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest(".js-plus")) stepToday(id, 1);
    else if (e.target.closest(".js-minus")) stepToday(id, -1);
    else if (e.target.closest(".js-edit")) openSubjectModal(id);
  });

  // activity
  $("history-list").addEventListener("click", e => {
    const li = e.target.closest("li");
    if (li && e.target.closest(".js-del")) deleteLog(li.dataset.id);
  });
  $("log-past-btn").addEventListener("click", openLogModal);
  $("log-form").addEventListener("submit", handleLogSubmit);
  $("log-cancel-btn").addEventListener("click", () => closeModal("log-modal"));

  // settings
  $("settings-form").addEventListener("submit", handleSettingsSubmit);
  $("settings-cancel-btn").addEventListener("click", () => closeModal("settings-modal"));
  $("export-btn").addEventListener("click", handleExport);
  $("reset-btn").addEventListener("click", handleReset);
  $("sign-out-btn").addEventListener("click", () => { closeAllModals(); auth.signOut(); });

  // leaderboard
  document.querySelectorAll("[data-lb-sort]").forEach(b => b.addEventListener("click", () => {
    LB.sort = b.dataset.lbSort === "week" ? "week" : "overall";
    renderLeaderboard();
  }));
  $("lb-refresh-btn").addEventListener("click", () => publishLeaderboardEntry().then(() => loadLeaderboard(false)));
  $("lb-optin").addEventListener("change", e => handleLeaderboardOptIn(e.target.checked));

  // modals close on backdrop click or Escape
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => {
    if (e.target === m) closeModal(m.id);
  }));
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeAllModals(); });
});
