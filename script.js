/* =========================================================
   FIXED METADATA — name, short label, color per subject.
   Editable numbers (totals, weekly targets, dates) live in
   state.config so they can be changed from the Settings modal.
   ========================================================= */
const SUBJECT_META = {
  maths: { name: "Mathematics", short: "Maths", color: "#E85D3D" },
  aem:   { name: "Applied Engineering Mechanics", short: "AEM", color: "#D99A2B" },
  som:   { name: "Strength of Materials", short: "SOM", color: "#2FA792" },
};

const STORAGE_KEY = "gate-tracker-state-v2";

function defaultConfig() {
  return {
    subjects: {
      maths: { total: 271, weeklyTarget: 9 },
      aem:   { total: 179, weeklyTarget: 6 },
      som:   { total: 204, weeklyTarget: 7 },
    },
    startDate: "2026-09-14",
    mainTargetDate: "2027-05-25",
    hardCutoff: "2027-05-30",
    lectureLengthMin: 30,
    weekdayTarget: 2,
    weekendTarget: 6,
    flowmodoro: { ratio: 5 },
    theme: { preset: "blueprint", custom: false, hue: null },
  };
}

/* =========================================================
   FIREBASE — auth + per-account cloud storage.
   firebaseConfig comes from firebase-config.js.
   ========================================================= */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Some browsers/networks used with Vercel can leave a Firestore read
// pending for a long time. Prefer long-polling for better compatibility.
try {
  db.settings({
    experimentalForceLongPolling: true,
  });
} catch (e) {
  console.warn("Could not apply Firestore network settings:", e);
}

let currentUser = null;

/* =========================================================
   STATE
   `state` is only meaningful once a user is signed in and
   their document has loaded from Firestore — see initApp().
   ========================================================= */
let state = defaultState();

function defaultState() {
  return {
    userName: null,
    logs: [],                 // {id, date:'YYYY-MM-DD', subject:'maths', lectures, minutes, notes}
    suggestedOverride: null,  // {date:'YYYY-MM-DD', subjects:['maths','som']}
    config: defaultConfig(),
    celebratedDates: [],      // dates we've already shown the "target hit" toast for
    timerSessions: [],        // {id, date, subject, focusSeconds, restSeconds, ratio, completedAt}
  };
}

/* Merge any partial/saved object on top of a full default shape,
   so older backups or partially-written docs never crash the app. */
function mergeIntoDefaultState(parsed) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const defaults = defaultState();
  const parsedConfig = source.config && typeof source.config === "object" ? source.config : {};
  const parsedSubjects = parsedConfig.subjects && typeof parsedConfig.subjects === "object"
    ? parsedConfig.subjects
    : {};

  return {
    ...defaults,
    ...source,
    logs: Array.isArray(source.logs) ? source.logs : [],
    celebratedDates: Array.isArray(source.celebratedDates) ? source.celebratedDates : [],
    timerSessions: Array.isArray(source.timerSessions) ? source.timerSessions : [],
    suggestedOverride:
      source.suggestedOverride && typeof source.suggestedOverride === "object"
        ? source.suggestedOverride
        : null,
    config: {
      ...defaults.config,
      ...parsedConfig,
      subjects: {
        maths: { ...defaults.config.subjects.maths, ...(parsedSubjects.maths || {}) },
        aem:   { ...defaults.config.subjects.aem,   ...(parsedSubjects.aem || {}) },
        som:   { ...defaults.config.subjects.som,   ...(parsedSubjects.som || {}) },
      },
      flowmodoro: { ...defaults.config.flowmodoro, ...(parsedConfig.flowmodoro || {}) },
      theme: { ...defaults.config.theme, ...(parsedConfig.theme || {}) },
    },
  };
}

function localCacheKey(uid) { return `${STORAGE_KEY}-cache-${uid}`; }

function saveState() {
  if (!currentUser) return;
  try {
    localStorage.setItem(localCacheKey(currentUser.uid), JSON.stringify(state));
  } catch (e) {
    console.error("Could not cache progress locally.", e);
  }
  db.collection("users").doc(currentUser.uid).set(state).catch(e => {
    console.error("Could not save to your account.", e);
    showToast("Saved on this device, but couldn't sync to your account (check your connection).");
  });
}

/* Merged course data: fixed meta + editable numbers */
function courseData() {
  const out = {};
  Object.keys(SUBJECT_META).forEach(key => {
    out[key] = { ...SUBJECT_META[key], ...state.config.subjects[key] };
  });
  return out;
}

/* =========================================================
   THEME — customizable accent colour, applied via CSS vars.
   Grid-line tints in style.css derive from --cyan automatically
   (color-mix), so setting these three vars re-themes the whole app.
   ========================================================= */
const THEME_PRESETS = {
  blueprint: { label: "Blueprint", bg: "#0E2136", cyan: "#79CBEA", cyanDim: "#3E6E86" },
  slate:     { label: "Slate",     bg: "#1B2233", cyan: "#9FB4E0", cyanDim: "#4C5D8A" },
  forest:    { label: "Forest",    bg: "#0E2A1E", cyan: "#7CE0A8", cyanDim: "#2E7A55" },
  sunset:    { label: "Sunset",    bg: "#331A12", cyan: "#F2A65A", cyanDim: "#B5651D" },
  rose:      { label: "Rose",      bg: "#2B0F1D", cyan: "#F28FC0", cyanDim: "#B34A82" },
  ocean:     { label: "Ocean",     bg: "#08262A", cyan: "#5FD9D0", cyanDim: "#1F8A82" },
  violet:    { label: "Violet",    bg: "#211632", cyan: "#B79CEA", cyanDim: "#6E52A6" },
  mono:      { label: "Mono",      bg: "#15181C", cyan: "#C7CDD4", cyanDim: "#6B7480" },
};

function hexToHsl(hex) {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/* Derive a full bg/cyan/cyanDim trio from a single hue picked by the user */
function deriveThemeFromHex(hex) {
  const { h } = hexToHsl(hex);
  return {
    bg: hslToHex(h, 46, 13),
    cyan: hslToHex(h, 68, 74),
    cyanDim: hslToHex(h, 40, 42),
  };
}

function resolveTheme(themeConfig) {
  const theme = themeConfig || defaultConfig().theme;
  if (theme.custom && theme.hue) return deriveThemeFromHex(theme.hue);
  return THEME_PRESETS[theme.preset] || THEME_PRESETS.blueprint;
}

function applyTheme(themeConfig) {
  const { bg, cyan, cyanDim } = resolveTheme(themeConfig);
  const root = document.documentElement.style;
  root.setProperty("--bg", bg);
  root.setProperty("--cyan", cyan);
  root.setProperty("--cyan-dim", cyanDim);
}

function selectThemePreset(key) {
  state.config.theme = { preset: key, custom: false, hue: null };
  applyTheme(state.config.theme);
  saveState();
  renderThemeSwatches();
}

function selectCustomTheme(hex) {
  state.config.theme = { preset: null, custom: true, hue: hex };
  applyTheme(state.config.theme);
  saveState();
  renderThemeSwatches();
}

function renderThemeSwatches() {
  const wrap = document.getElementById("theme-swatches");
  if (!wrap) return;
  wrap.innerHTML = "";
  const theme = state.config.theme || defaultConfig().theme;
  Object.keys(THEME_PRESETS).forEach(key => {
    const preset = THEME_PRESETS[key];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-swatch" + (!theme.custom && theme.preset === key ? " is-active" : "");
    btn.innerHTML = `
      <span class="theme-swatch-dot" style="background:${preset.cyan}"></span>
      <span class="theme-swatch-label">${preset.label}</span>
    `;
    btn.addEventListener("click", () => selectThemePreset(key));
    wrap.appendChild(btn);
  });
  const customInput = document.getElementById("theme-custom-input");
  if (customInput && theme.custom && theme.hue) customInput.value = theme.hue;
}

function openAppearanceModal() {
  renderThemeSwatches();
  document.getElementById("appearance-modal").classList.add("is-open");
}

function closeAppearanceModal() {
  document.getElementById("appearance-modal").classList.remove("is-open");
}

/* =========================================================
   DATE / WEEK HELPERS
   ========================================================= */
const DAY_MS = 24 * 60 * 60 * 1000;

function toDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseISODate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function todayDate() {
  return toDateOnly(new Date());
}

function planStart() { return toDateOnly(parseISODate(state.config.startDate)); }
function planCutoff() { return toDateOnly(parseISODate(state.config.hardCutoff)); }
function mainTargetDate() { return toDateOnly(parseISODate(state.config.mainTargetDate)); }
function totalWeeks() { return Math.floor((planCutoff() - planStart()) / (7 * DAY_MS)) + 1; }
function totalWeeklyTarget() {
  return Object.values(state.config.subjects).reduce((s, c) => s + c.weeklyTarget, 0);
}

// Daily target: Mon–Fri use weekdayTarget, Sat/Sun use weekendTarget (both editable in Plan settings)
function dailyTarget(date) {
  const dow = date.getDay(); // 0 Sun ... 6 Sat
  return (dow === 0 || dow === 6) ? state.config.weekendTarget : state.config.weekdayTarget;
}

// Week index (1-based), clamped to [1, totalWeeks]
function weekIndexFor(date) {
  const diff = Math.floor((date - planStart()) / (7 * DAY_MS));
  return Math.min(Math.max(diff + 1, 1), totalWeeks());
}

function weekStartFor(weekIndex) {
  return new Date(planStart().getTime() + (weekIndex - 1) * 7 * DAY_MS);
}

function weekEndFor(weekIndex) {
  return new Date(weekStartFor(weekIndex).getTime() + 6 * DAY_MS);
}

function isSameOrBefore(a, b) { return a.getTime() <= b.getTime(); }
function isSameOrAfter(a, b) { return a.getTime() >= b.getTime(); }

/* =========================================================
   DERIVED DATA FROM LOGS
   ========================================================= */
function completedForSubject(subjectKey) {
  return state.logs
    .filter(l => l.subject === subjectKey)
    .reduce((s, l) => s + Number(l.lectures), 0);
}

function totalCompleted() {
  return state.logs.reduce((s, l) => s + Number(l.lectures), 0);
}

function logsInRange(startDate, endDate) {
  return state.logs.filter(l => {
    const d = parseISODate(l.date);
    return isSameOrAfter(d, startDate) && isSameOrBefore(d, endDate);
  });
}

function subjectDoneInRange(subjectKey, startDate, endDate) {
  return logsInRange(startDate, endDate)
    .filter(l => l.subject === subjectKey)
    .reduce((s, l) => s + Number(l.lectures), 0);
}

function logsOnDate(dateStr) {
  return state.logs.filter(l => l.date === dateStr);
}

function completedOnDate(dateStr) {
  return logsOnDate(dateStr).reduce((s, l) => s + Number(l.lectures), 0);
}

/* Expected lectures by a given day within its week (sum of daily targets
   from that week's Monday through that day, inclusive). */
function expectedByDate(date) {
  const wIndex = weekIndexFor(date);
  const wStart = weekStartFor(wIndex);
  let expected = 0;
  for (let d = new Date(wStart); d <= date; d = new Date(d.getTime() + DAY_MS)) {
    expected += dailyTarget(d);
  }
  return expected;
}

/* =========================================================
   STREAK
   ========================================================= */
function currentStreak() {
  const daysWithLogs = new Set(state.logs.map(l => l.date));
  let streak = 0;
  let cursor = todayDate();

  if (!daysWithLogs.has(formatISODate(cursor))) {
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  while (daysWithLogs.has(formatISODate(cursor))) {
    streak++;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

/* =========================================================
   SUGGESTIONS
   ========================================================= */
function computeSuggestedSubjects() {
  const today = todayDate();
  const wIndex = weekIndexFor(today);
  const wStart = weekStartFor(wIndex);
  const wEnd = weekEndFor(wIndex);
  const cd = courseData();

  const gaps = Object.keys(cd).map(key => {
    const done = subjectDoneInRange(key, wStart, wEnd);
    const remaining = Math.max(cd[key].total - completedForSubject(key), 0);
    return { key, gap: cd[key].weeklyTarget - done, remaining };
  });

  gaps.sort((a, b) => (b.gap - a.gap) || (b.remaining - a.remaining));
  return gaps.slice(0, 2).map(g => g.key);
}

function getSuggestedSubjects() {
  const todayStr = formatISODate(todayDate());
  if (state.suggestedOverride && state.suggestedOverride.date === todayStr) {
    return state.suggestedOverride.subjects;
  }
  return computeSuggestedSubjects();
}

function setSuggestedSubjects(subjects) {
  state.suggestedOverride = { date: formatISODate(todayDate()), subjects };
  saveState();
}

/* =========================================================
   TOAST
   ========================================================= */
let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/* =========================================================
   VIEW SWITCHING — Dashboard vs. Focus Timer
   ========================================================= */
function switchView(view) {
  document.getElementById("view-dashboard").hidden = view !== "dashboard";
  document.getElementById("view-timer").hidden = view !== "timer";
  document.querySelectorAll(".view-nav-btn").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.view === view);
  });
  if (view === "timer") renderTimerSessionList();
}

/* =========================================================
   FLOWMODORO TIMER
   Work with full focus for as long as it flows; when you stop,
   a break proportional to the work (focus ÷ ratio) is earned.
   Sessions are stored in state.timerSessions and cloud-synced
   through the normal saveState() path. The in-progress timer
   itself is kept in localStorage so a refresh doesn't lose it.
   ========================================================= */
let timerState = { status: "idle" }; // idle | focusing | resting
let timerTickHandle = null;
let lastCompletedSession = null;

function timerSubjects() {
  return { ...courseData(), general: { name: "General focus", short: "General", color: "#8FA9B8" } };
}

function timerStorageKey(uid) { return `${STORAGE_KEY}-timer-${uid}`; }

function persistTimerState() {
  if (!currentUser) return;
  try {
    if (timerState.status === "idle") {
      localStorage.removeItem(timerStorageKey(currentUser.uid));
    } else {
      localStorage.setItem(timerStorageKey(currentUser.uid), JSON.stringify(timerState));
    }
  } catch (e) {
    console.warn("Could not persist timer state:", e);
  }
}

function loadTimerState(uid) {
  try {
    const raw = localStorage.getItem(timerStorageKey(uid));
    return raw ? JSON.parse(raw) : { status: "idle" };
  } catch (e) {
    return { status: "idle" };
  }
}

function populateTimerSubjectSelect() {
  const select = document.getElementById("timer-subject");
  if (!select) return;
  const prev = select.value;
  select.innerHTML = "";
  const subs = timerSubjects();
  Object.keys(subs).forEach(key => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = subs[key].name;
    select.appendChild(opt);
  });
  if (prev && subs[prev]) select.value = prev;
}

function formatClock(totalSeconds) {
  const s = Math.max(Math.round(totalSeconds), 0);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatDuration(totalSeconds) {
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/* Short two-tone beep via Web Audio — no external asset needed */
function playTimerBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.16);
      osc.stop(ctx.currentTime + i * 0.16 + 0.32);
    });
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch (e) { /* audio not available — silently skip */ }
}

function renderTimerUI() {
  const card = document.querySelector(".timer-card");
  const modePill = document.getElementById("timer-mode-pill");
  const display = document.getElementById("timer-display");
  const sublabel = document.getElementById("timer-sublabel");
  const idleControls = document.getElementById("timer-idle-controls");
  const focusControls = document.getElementById("timer-focus-controls");
  const restControls = document.getElementById("timer-rest-controls");
  const subjectSelect = document.getElementById("timer-subject");
  const ratioInput = document.getElementById("timer-ratio");
  if (!card) return;

  card.classList.remove("is-focusing", "is-resting");
  const subs = timerSubjects();

  if (timerState.status === "focusing") {
    card.classList.add("is-focusing");
    modePill.textContent = "Focusing";
    const elapsed = (Date.now() - timerState.startedAt) / 1000;
    display.textContent = formatClock(elapsed);
    sublabel.textContent = `Focused on ${subs[timerState.subject] ? subs[timerState.subject].name : "study"} — keep going`;
    idleControls.hidden = true;
    focusControls.hidden = false;
    restControls.hidden = true;
    ratioInput.value = timerState.ratio;
    document.getElementById("ratio-value").textContent = timerState.ratio;
    ratioInput.disabled = true;
  } else if (timerState.status === "resting") {
    card.classList.add("is-resting");
    modePill.textContent = "On a break";
    const remaining = timerState.restSeconds - (Date.now() - timerState.startedAt) / 1000;
    display.textContent = formatClock(Math.max(remaining, 0));
    sublabel.textContent = `Break earned from ${formatDuration(timerState.focusSeconds)} of focus`;
    idleControls.hidden = true;
    focusControls.hidden = true;
    restControls.hidden = false;
    ratioInput.disabled = true;
    if (remaining <= 0) {
      finishTimerCycle(true);
      return;
    }
  } else {
    modePill.textContent = "Ready";
    display.textContent = "00:00";
    sublabel.textContent = "Tap start when you're ready";
    idleControls.hidden = false;
    focusControls.hidden = true;
    restControls.hidden = true;
    ratioInput.disabled = false;
    const ratio = state.config.flowmodoro.ratio;
    ratioInput.value = ratio;
    document.getElementById("ratio-value").textContent = ratio;
  }
}

function timerTick() {
  if (timerState.status === "idle") return;
  renderTimerUI();
}

function startTimerTicker() {
  clearInterval(timerTickHandle);
  timerTickHandle = setInterval(timerTick, 500);
}

function handleTimerStart() {
  const subject = document.getElementById("timer-subject").value;
  const ratio = Number(document.getElementById("timer-ratio").value) || 5;
  state.config.flowmodoro.ratio = ratio;
  timerState = { status: "focusing", subject, startedAt: Date.now(), ratio };
  persistTimerState();
  saveState();
  renderTimerUI();
}

function handleTimerEndFocus() {
  if (timerState.status !== "focusing") return;
  const focusSeconds = Math.max(Math.round((Date.now() - timerState.startedAt) / 1000), 1);
  const ratio = timerState.ratio;
  const restSeconds = Math.max(Math.round(focusSeconds / ratio), 0);
  const subject = timerState.subject;

  const session = {
    id: Date.now(),
    date: formatISODate(todayDate()),
    subject,
    focusSeconds,
    restSeconds,
    ratio,
    completedAt: new Date().toISOString(),
  };
  state.timerSessions.push(session);
  lastCompletedSession = session;
  saveState();
  renderTimerSessionList();

  if (restSeconds > 0) {
    timerState = { status: "resting", subject, startedAt: Date.now(), restSeconds, focusSeconds };
    persistTimerState();
    renderTimerUI();
    showToast(`Focus block logged — ${formatDuration(focusSeconds)}. Enjoy a ${formatDuration(restSeconds)} break.`);
  } else {
    finishTimerCycle(false);
    showToast(`Focus block logged — ${formatDuration(focusSeconds)}.`);
  }
}

function handleTimerDiscard() {
  if (timerState.status !== "focusing") return;
  const ok = confirm("Discard this focus session without saving it?");
  if (!ok) return;
  finishTimerCycle(false);
  showToast("Session discarded.");
}

function handleTimerSkipRest() {
  if (timerState.status !== "resting") return;
  finishTimerCycle(false);
  showToast("Break skipped. Ready for another focus block.");
}

function handleTimerAddMinute() {
  if (timerState.status !== "resting") return;
  timerState.restSeconds += 60;
  persistTimerState();
  renderTimerUI();
}

function finishTimerCycle(playSound) {
  const wasResting = timerState.status === "resting";
  timerState = { status: "idle" };
  persistTimerState();
  renderTimerUI();
  if (playSound) {
    playTimerBeep();
    showToast("Break's over — ready for another focus block?");
  }
  if (wasResting) renderTimerSessionList();
}

function renderTimerSessionList() {
  const list = document.getElementById("timer-session-list");
  const totalEl = document.getElementById("timer-today-total");
  if (!list || !totalEl) return;

  const todayStr = formatISODate(todayDate());
  const todaySessions = state.timerSessions
    .filter(s => s.date === todayStr)
    .sort((a, b) => b.id - a.id);

  const totalFocus = todaySessions.reduce((s, x) => s + x.focusSeconds, 0);
  totalEl.textContent = `${formatDuration(totalFocus)} focused`;

  list.innerHTML = "";
  if (todaySessions.length === 0) {
    list.innerHTML = `<li class="muted small">No focus sessions logged yet today.</li>`;
    return;
  }

  const subs = timerSubjects();
  todaySessions.forEach(session => {
    const c = subs[session.subject] || subs.general;
    const time = new Date(session.completedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const li = document.createElement("li");
    li.className = "activity-item";
    li.innerHTML = `
      <span class="activity-tag" style="background:${c.color}22; color:${c.color}">${c.short}</span>
      <div class="activity-main">
        <span>${time} · ${formatDuration(session.focusSeconds)} focus${session.restSeconds ? ` · ${formatDuration(session.restSeconds)} break` : ""}</span>
      </div>
      <button class="link-btn log-session-btn" data-id="${session.id}" type="button">Log as study</button>
      <button class="delete-btn" data-id="${session.id}" aria-label="Delete session">&times;</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll(".delete-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      state.timerSessions = state.timerSessions.filter(s => s.id !== id);
      saveState();
      renderTimerSessionList();
    });
  });

  list.querySelectorAll(".log-session-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const session = state.timerSessions.find(s => s.id === id);
      if (session) openModalFromTimerSession(session);
    });
  });
}

function openModalFromTimerSession(session) {
  openModal();
  const cd = courseData();
  const subjectSelect = document.getElementById("log-subject");
  if (cd[session.subject]) subjectSelect.value = session.subject;
  document.getElementById("log-date").value = session.date;
  document.getElementById("log-minutes").value = Math.round(session.focusSeconds / 60);
  document.getElementById("log-notes").value = `Flowmodoro focus session (${formatDuration(session.focusSeconds)}, 1:${session.ratio} break)`;
}

/* =========================================================
   RENDERING
   ========================================================= */
function render() {
  renderHero();
  renderTodayFocus();
  renderDayStrip();
  renderOverallProgress();
  renderSubjectCards();
  renderWeekCard();
  renderPace();
  renderActivity();
  if (!document.getElementById("plan-section").hidden) renderPlanTable();
}

function renderHero() {
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const name = state.userName ? `, ${state.userName}` : "";
  document.getElementById("greeting").textContent = `${timeGreeting}${name}.`;

  const today = todayDate();
  const daysLeft = Math.max(Math.round((mainTargetDate() - today) / DAY_MS), 0);
  document.getElementById("days-left").textContent = daysLeft;

  const wIndex = weekIndexFor(today);
  const targetLabel = mainTargetDate().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  document.getElementById("hero-detail").textContent =
    `You're aiming for ${targetLabel}. That puts you in week ${wIndex} of ${totalWeeks()}.`;

  const streak = currentStreak();
  document.getElementById("streak-pill").textContent = `${streak} day streak`;
  document.getElementById("tagline").textContent = streak > 0
    ? "Keep the streak alive — today's work is all that's in front of you."
    : "A fresh start today. One session is all it takes to get going.";

  document.getElementById("today-date").textContent = today.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });

  document.getElementById("edit-name-btn").textContent = state.userName ? "Edit name" : "Set your name";
}

function renderTodayFocus() {
  const today = todayDate();
  const todayStr = formatISODate(today);
  const target = dailyTarget(today);
  const completed = completedOnDate(todayStr);
  const remaining = Math.max(target - completed, 0);
  const pct = target > 0 ? Math.min((completed / target) * 100, 100) : 100;

  document.getElementById("focus-target").textContent = `${target} lecture${target !== 1 ? "s" : ""}`;
  document.getElementById("focus-completed").textContent = `${completed} / ${target}`;
  document.getElementById("focus-remaining").textContent = remaining > 0
    ? `${remaining} lecture${remaining !== 1 ? "s" : ""}`
    : "All done";
  document.getElementById("focus-progress-fill").style.width = `${pct}%`;

  // Suggested subjects (editable)
  const cd = courseData();
  const suggested = getSuggestedSubjects();
  const container = document.getElementById("suggested-picks");
  container.innerHTML = "";
  suggested.forEach((subjectKey, idx) => {
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Suggested subject ${idx + 1}`);
    Object.keys(cd).forEach(key => {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${state.config.lectureLengthMin} min ${cd[key].short}`;
      if (key === subjectKey) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      const current = getSuggestedSubjects().slice();
      current[idx] = select.value;
      setSuggestedSubjects(current);
      renderTodayFocus();
    });
    container.appendChild(select);
  });

  // Celebrate hitting today's target, once per day
  if (completed >= target && target > 0 && !state.celebratedDates.includes(todayStr)) {
    state.celebratedDates.push(todayStr);
    saveState();
    showToast("Today's target is done. Nice work — that's a wrap for today.");
  }
}

function renderDayStrip() {
  const strip = document.getElementById("day-strip");
  strip.innerHTML = "";
  const today = todayDate();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    const dStr = formatISODate(d);
    const target = dailyTarget(d);
    const done = completedOnDate(dStr);

    const cell = document.createElement("div");
    cell.className = "day-cell";
    const boxClass = i === 0
      ? (done >= target ? "hit today" : done > 0 ? "partial today" : "today")
      : (done >= target ? "hit" : done > 0 ? "partial" : "");
    cell.innerHTML = `
      <div class="box ${boxClass}" title="${dStr}: ${done} / ${target} lectures"></div>
      <span class="lbl">${d.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
    `;
    strip.appendChild(cell);
  }
}

function renderOverallProgress() {
  const cd = courseData();
  const total = Object.values(cd).reduce((s, c) => s + c.total, 0);
  const completed = totalCompleted();
  const remaining = Math.max(total - completed, 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  document.getElementById("overall-pct").textContent = `${pct}%`;
  document.getElementById("overall-progress-fill").style.width = `${pct}%`;

  const list = document.getElementById("overall-breakdown");
  list.innerHTML = "";
  Object.keys(cd).forEach(key => {
    const c = cd[key];
    const rem = Math.max(c.total - completedForSubject(key), 0);
    const li = document.createElement("li");
    li.innerHTML = `<span>${c.name}</span><span>${rem} lectures remaining</span>`;
    list.appendChild(li);
  });
  const totalLi = document.createElement("li");
  totalLi.innerHTML = `<span>Total</span><span>${remaining} lectures remaining</span>`;
  list.appendChild(totalLi);
}

function renderSubjectCards() {
  const today = todayDate();
  const wIndex = weekIndexFor(today);
  const wStart = weekStartFor(wIndex);
  const wEnd = weekEndFor(wIndex);
  const cd = courseData();

  const grid = document.getElementById("subject-grid");
  grid.innerHTML = "";

  Object.keys(cd).forEach(key => {
    const c = cd[key];
    const completed = completedForSubject(key);
    const remaining = Math.max(c.total - completed, 0);
    const pct = c.total > 0 ? Math.round((completed / c.total) * 100) : 0;
    const weekDone = subjectDoneInRange(key, wStart, wEnd);
    const badge = pct >= 100 ? `<span class="subject-badge">cleared</span>` : "";

    const card = document.createElement("div");
    card.className = "subject-card";
    card.style.setProperty("--subject-color", c.color);
    card.innerHTML = `
      <div class="subject-card-head">
        <div>
          <h3>${c.name}${badge}</h3>
          <span class="subject-abbr">${c.short}</span>
        </div>
        <span class="subject-pct">${pct}%</span>
      </div>
      <div class="ruler-track">
        <div class="ruler-fill" style="width:${pct}%; background:${c.color}"></div>
      </div>
      <div class="subject-stats">
        <div><strong>${completed}</strong>Completed</div>
        <div><strong>${remaining}</strong>Remaining</div>
      </div>
      <div class="subject-week">
        <span>Weekly target: ${c.weeklyTarget}</span>
        <span>This week: ${weekDone} / ${c.weeklyTarget}</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

function renderWeekCard() {
  const today = todayDate();
  const wIndex = weekIndexFor(today);
  const wStart = weekStartFor(wIndex);
  const wEnd = weekEndFor(wIndex);
  const cd = courseData();
  const target = totalWeeklyTarget();
  const weekDone = logsInRange(wStart, wEnd).reduce((s, l) => s + Number(l.lectures), 0);
  const pct = Math.min(Math.round((weekDone / target) * 100), 100);
  const left = Math.max(target - weekDone, 0);

  document.getElementById("week-label").textContent = `Week ${wIndex} of ${totalWeeks()}`;
  document.getElementById("week-fraction").textContent = `${weekDone} / ${target}`;
  document.getElementById("week-pct").textContent = `${pct}%`;
  document.getElementById("week-progress-fill").style.width = `${pct}%`;
  document.getElementById("week-left").textContent = left > 0
    ? `${left} lecture${left !== 1 ? "s" : ""} left this week`
    : "Weekly target complete";

  const rows = document.getElementById("week-subject-rows");
  rows.innerHTML = "";
  Object.keys(cd).forEach(key => {
    const c = cd[key];
    const done = subjectDoneInRange(key, wStart, wEnd);
    const subPct = Math.min(Math.round((done / c.weeklyTarget) * 100), 100);
    const row = document.createElement("div");
    row.className = "week-subject-row";
    row.innerHTML = `
      <span>${c.short}</span>
      <span class="track"><span class="track-fill" style="width:${subPct}%; background:${c.color}"></span></span>
      <span class="count">${done} / ${c.weeklyTarget}</span>
    `;
    rows.appendChild(row);
  });
}

function renderPace() {
  const today = todayDate();
  const wIndex = weekIndexFor(today);
  const wStart = weekStartFor(wIndex);
  const wEnd = weekEndFor(wIndex);
  const actual = logsInRange(wStart, wEnd).reduce((s, l) => s + Number(l.lectures), 0);
  const target = totalWeeklyTarget();

  const card = document.getElementById("pace-card");
  const msgEl = document.getElementById("pace-message");
  card.classList.remove("state-warning", "state-danger", "state-success");

  if (today < planStart()) {
    msgEl.textContent = `Your plan begins on ${planStart().toLocaleDateString(undefined, { month: "long", day: "numeric" })}. Everything is set up and ready to go.`;
    return;
  }

  const expected = expectedByDate(today);
  const diff = actual - expected;

  if (actual >= target) {
    card.classList.add("state-success");
    msgEl.textContent = `Weekly target complete — you've logged ${actual} of ${target} lectures this week. Great work.`;
  } else if (diff >= 2) {
    card.classList.add("state-success");
    msgEl.textContent = `You're ${diff} lecture${diff !== 1 ? "s" : ""} ahead of pace this week. Nice cushion — keep it up.`;
  } else if (diff >= 0) {
    msgEl.textContent = `You're right on pace this week. Stay steady and the weekly target takes care of itself.`;
  } else if (diff >= -3) {
    card.classList.add("state-warning");
    const gap = Math.abs(diff);
    msgEl.textContent = `You're ${gap} lecture${gap !== 1 ? "s" : ""} behind this week. A small catch-up session today closes the gap.`;
  } else {
    card.classList.add("state-danger");
    const gap = Math.abs(diff);
    msgEl.textContent = `You're ${gap} lectures behind this week. A focused weekend block will help you close the gap — no need to rush it all at once.`;
  }
}

function renderActivity() {
  const list = document.getElementById("activity-list");
  list.innerHTML = "";
  const cd = courseData();

  const sorted = [...state.logs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.id - a.id;
  });

  if (sorted.length === 0) {
    list.innerHTML = `<li class="muted small">No study sessions logged yet.</li>`;
    return;
  }

  sorted.slice(0, 8).forEach(log => {
    const c = cd[log.subject];
    const li = document.createElement("li");
    li.className = "activity-item";
    const dateLabel = parseISODate(log.date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    li.innerHTML = `
      <span class="activity-tag" style="background:${c.color}22; color:${c.color}">${c.short}</span>
      <div class="activity-main">
        <span>${dateLabel} · ${log.lectures} lecture${Number(log.lectures) !== 1 ? "s" : ""}${log.minutes ? ` · ${log.minutes} min` : ""}</span>
        ${log.notes ? `<span class="notes">${escapeHtml(log.notes)}</span>` : ""}
      </div>
      <button class="delete-btn" data-id="${log.id}" aria-label="Delete entry">&times;</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll(".delete-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      state.logs = state.logs.filter(l => l.id !== id);
      saveState();
      render();
    });
  });
}

function renderPlanTable() {
  const body = document.getElementById("plan-table-body");
  body.innerHTML = "";
  const currentIndex = weekIndexFor(todayDate());
  const cd = courseData();
  const target = totalWeeklyTarget();

  document.getElementById("plan-range").textContent =
    `${planStart().toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${planCutoff().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  for (let w = 1; w <= totalWeeks(); w++) {
    const wStart = weekStartFor(w);
    const wEnd = weekEndFor(w);
    const mathsDone = subjectDoneInRange("maths", wStart, wEnd);
    const aemDone = subjectDoneInRange("aem", wStart, wEnd);
    const somDone = subjectDoneInRange("som", wStart, wEnd);
    const total = mathsDone + aemDone + somDone;

    let status = "Not started";
    if (w < currentIndex) status = total >= target ? "Completed" : "Missed target";
    else if (w === currentIndex) status = total >= target ? "Completed" : "In progress";

    const tr = document.createElement("tr");
    if (w === currentIndex) tr.className = "current-week";
    const dateLabel = `${wStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${wEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    tr.innerHTML = `
      <td>${w}</td>
      <td>${dateLabel}</td>
      <td>${mathsDone} / ${cd.maths.weeklyTarget}</td>
      <td>${aemDone} / ${cd.aem.weeklyTarget}</td>
      <td>${somDone} / ${cd.som.weeklyTarget}</td>
      <td>${total} / ${target}</td>
      <td>${status}</td>
    `;
    body.appendChild(tr);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* =========================================================
   LOG MODAL / FORM
   Visibility is controlled purely via the `.is-open` class
   (see style.css) — never via the `hidden` attribute, since
   an author CSS rule that sets `display` on the same element
   always wins over the browser's built-in `[hidden]` rule.
   ========================================================= */
function populateSubjectSelect() {
  const select = document.getElementById("log-subject");
  select.innerHTML = "";
  const cd = courseData();
  Object.keys(cd).forEach(key => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = cd[key].name;
    select.appendChild(opt);
  });
}

function openModal() {
  document.getElementById("log-date").value = formatISODate(todayDate());
  document.getElementById("log-lectures").value = 1;
  document.getElementById("log-minutes").value = state.config.lectureLengthMin;
  document.getElementById("log-notes").value = "";
  document.getElementById("log-modal").classList.add("is-open");
  document.getElementById("log-subject").focus();
}

function closeModal() {
  document.getElementById("log-modal").classList.remove("is-open");
}

function handleLogSubmit(e) {
  e.preventDefault();
  const entry = {
    id: Date.now(),
    date: document.getElementById("log-date").value || formatISODate(todayDate()),
    subject: document.getElementById("log-subject").value,
    lectures: Number(document.getElementById("log-lectures").value) || 0,
    minutes: Number(document.getElementById("log-minutes").value) || 0,
    notes: document.getElementById("log-notes").value.trim(),
  };
  if (entry.lectures <= 0) return;

  state.logs.push(entry);
  saveState();
  closeModal();
  render();
  showToast(`Logged ${entry.lectures} ${SUBJECT_META[entry.subject].short} lecture${entry.lectures !== 1 ? "s" : ""}.`);
}

/* Auto-fill minutes when lecture count changes, based on lecture length */
function wireLectureMinutesSync() {
  const lecturesInput = document.getElementById("log-lectures");
  const minutesInput = document.getElementById("log-minutes");
  let minutesManuallyEdited = false;

  lecturesInput.addEventListener("input", () => {
    if (minutesManuallyEdited) return;
    const lectures = Number(lecturesInput.value) || 0;
    minutesInput.value = Math.round(lectures * state.config.lectureLengthMin);
  });
  minutesInput.addEventListener("input", () => { minutesManuallyEdited = true; });
}

/* =========================================================
   SETTINGS MODAL
   ========================================================= */
function renderSettingsForm() {
  const rows = document.getElementById("settings-subject-rows");
  rows.innerHTML = "";
  Object.keys(SUBJECT_META).forEach(key => {
    const meta = SUBJECT_META[key];
    const cfg = state.config.subjects[key];
    const row = document.createElement("div");
    row.className = "settings-subject-row";
    row.innerHTML = `
      <span>${meta.name}</span>
      <input type="number" min="0" step="1" data-key="${key}" data-field="total" value="${cfg.total}" aria-label="${meta.name} total lectures" />
      <input type="number" min="0" step="1" data-key="${key}" data-field="weeklyTarget" value="${cfg.weeklyTarget}" aria-label="${meta.name} weekly target" />
    `;
    rows.appendChild(row);
  });
  document.getElementById("set-start").value = state.config.startDate;
  document.getElementById("set-target").value = state.config.mainTargetDate;
  document.getElementById("set-cutoff").value = state.config.hardCutoff;
  document.getElementById("set-length").value = state.config.lectureLengthMin;
  document.getElementById("set-weekday-target").value = state.config.weekdayTarget;
  document.getElementById("set-weekend-target").value = state.config.weekendTarget;
}

function openSettingsModal() {
  renderSettingsForm();
  document.getElementById("settings-modal").classList.add("is-open");
}

function closeSettingsModal() {
  document.getElementById("settings-modal").classList.remove("is-open");
}

function handleSettingsSubmit(e) {
  e.preventDefault();
  document.querySelectorAll("#settings-subject-rows input").forEach(input => {
    const key = input.dataset.key;
    const field = input.dataset.field;
    const val = Math.max(Number(input.value) || 0, 0);
    state.config.subjects[key][field] = val;
  });
  state.config.startDate = document.getElementById("set-start").value || state.config.startDate;
  state.config.mainTargetDate = document.getElementById("set-target").value || state.config.mainTargetDate;
  state.config.hardCutoff = document.getElementById("set-cutoff").value || state.config.hardCutoff;
  state.config.lectureLengthMin = Math.max(Number(document.getElementById("set-length").value) || 30, 5);
  state.config.weekdayTarget = Math.max(Number(document.getElementById("set-weekday-target").value) || 0, 0);
  state.config.weekendTarget = Math.max(Number(document.getElementById("set-weekend-target").value) || 0, 0);

  saveState();
  closeSettingsModal();
  render();
  showToast("Plan settings saved.");
}

/* =========================================================
   NAME EDITING
   ========================================================= */
function handleEditName() {
  const input = prompt("What should we call you?", state.userName || "");
  if (input === null) return;
  const trimmed = input.trim();
  state.userName = trimmed || null;
  saveState();
  renderHero();
}

/* =========================================================
   BACKUP: EXPORT / IMPORT / RESET
   ========================================================= */
function handleExport() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gate-tracker-backup-${formatISODate(todayDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Backup downloaded.");
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || !Array.isArray(parsed.logs)) throw new Error("Not a recognised backup file.");
      state = mergeIntoDefaultState(parsed);
      saveState();
      render();
      showToast("Backup imported.");
    } catch (err) {
      console.error(err);
      showToast("That file doesn't look like a GATE Tracker backup.");
    }
  };
  reader.readAsText(file);
}

function handleReset() {
  const ok = confirm("This clears every logged session and setting on this device. This can't be undone. Continue?");
  if (!ok) return;
  state = defaultState();
  saveState();
  render();
  showToast("All data reset.");
}

/* =========================================================
   AUTH
   ========================================================= */
let authMode = "login"; // "login" | "signup"

function setAuthMode(mode) {
  authMode = mode;
  document.getElementById("tab-login").classList.toggle("is-active", mode === "login");
  document.getElementById("tab-signup").classList.toggle("is-active", mode === "signup");
  document.getElementById("auth-submit-btn").textContent = mode === "login" ? "Log in" : "Create account";
  document.getElementById("auth-password").setAttribute("autocomplete", mode === "login" ? "current-password" : "new-password");
  hideAuthError();
}

function showAuthError(message) {
  const el = document.getElementById("auth-error");
  el.textContent = message;
  el.hidden = false;
}

function hideAuthError() {
  document.getElementById("auth-error").hidden = true;
}

function friendlyAuthError(err) {
  switch (err.code) {
    case "auth/invalid-email": return "That email address doesn't look right.";
    case "auth/user-not-found": return "No account found with that email. Try 'Create account' instead.";
    case "auth/wrong-password": case "auth/invalid-credential": return "Incorrect email or password.";
    case "auth/email-already-in-use": return "An account already exists with that email. Try 'Log in' instead.";
    case "auth/weak-password": return "Password should be at least 6 characters.";
    default: return err.message || "Something went wrong. Please try again.";
  }
}

function handleAuthSubmit(e) {
  e.preventDefault();
  hideAuthError();
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const submitBtn = document.getElementById("auth-submit-btn");
  submitBtn.disabled = true;

  const action = authMode === "login"
    ? auth.signInWithEmailAndPassword(email, password)
    : auth.createUserWithEmailAndPassword(email, password);

  action
    .catch(err => showAuthError(friendlyAuthError(err)))
    .finally(() => { submitBtn.disabled = false; });
}

function handleSignOut() {
  auth.signOut();
}

/* Runs once per sign-in.
   IMPORTANT: the dashboard must never wait forever for Firestore.
   We render from local/default state first, then sync from Firestore
   in the background. */
function readCachedState(uid) {
  try {
    const raw = localStorage.getItem(localCacheKey(uid));
    return raw ? mergeIntoDefaultState(JSON.parse(raw)) : null;
  } catch (err) {
    console.warn("Could not read cached account data:", err);
    return null;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

function revealApp(user) {
  const loading = document.getElementById("app-loading");
  const authScreen = document.getElementById("auth-screen");
  const board = document.getElementById("board");

  loading.hidden = true;
  authScreen.hidden = true;
  board.hidden = false;
  document.getElementById("account-email").textContent = user.email || "";
  applyTheme(state.config.theme);

  try {
    populateSubjectSelect();
    populateTimerSubjectSelect();
    render();
    renderTimerSessionList();
  } catch (err) {
    console.error("Dashboard render failed:", err);
    state = mergeIntoDefaultState(null);
    try {
      populateSubjectSelect();
      populateTimerSubjectSelect();
      render();
      renderTimerSessionList();
    } catch (fallbackErr) {
      console.error("Fallback dashboard render failed:", fallbackErr);
    }
  }
}

function initApp(user) {
  const loading = document.getElementById("app-loading");
  const authScreen = document.getElementById("auth-screen");

  loading.hidden = false;
  authScreen.hidden = true;

  // Show the dashboard immediately from the last local copy, or defaults.
  // This guarantees a Firestore/network problem cannot trap the UI on loading.
  state = readCachedState(user.uid) || defaultState();
  timerState = loadTimerState(user.uid);
  startTimerTicker();
  revealApp(user);

  // Sync from Firestore in the background. The UI is not blocked by this.
  withTimeout(
    db.collection("users").doc(user.uid).get(),
    8000,
    "Firestore account read"
  )
    .then(doc => {
      if (doc.exists) {
        state = mergeIntoDefaultState(doc.data());

        try {
          localStorage.setItem(localCacheKey(user.uid), JSON.stringify(state));
        } catch (cacheErr) {
          console.warn("Could not cache synced account data:", cacheErr);
        }

        revealApp(user);
      } else {
        // New account: keep the UI usable and create the document in the background.
        state = defaultState();
        revealApp(user);

        return withTimeout(
          db.collection("users").doc(user.uid).set(state),
          8000,
          "Firestore account creation"
        ).catch(err => {
          console.warn("Could not create Firestore account document:", err);
        });
      }
    })
    .catch(err => {
      console.warn("Firestore sync unavailable; continuing with local/default data.", err);
      showToast("Loaded on this device. Cloud sync is currently unavailable.");
      // The dashboard is already visible, so do not replace it with a loader.
    });
}

function teardownApp() {
  state = defaultState();
  applyTheme(state.config.theme);
  clearInterval(timerTickHandle);
  timerState = { status: "idle" };
  document.getElementById("board").hidden = true;
  document.getElementById("app-loading").hidden = true;
  document.getElementById("auth-screen").hidden = false;
  document.getElementById("auth-email").value = "";
  document.getElementById("auth-password").value = "";
  hideAuthError();
}

auth.onAuthStateChanged(user => {
  currentUser = user;
  if (user) initApp(user);
  else teardownApp();
});

/* =========================================================
   INIT — wires static UI controls once; auth state controls
   when the data actually loads and the board becomes visible.
   ========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  wireLectureMinutesSync();

  document.getElementById("tab-login").addEventListener("click", () => setAuthMode("login"));
  document.getElementById("tab-signup").addEventListener("click", () => setAuthMode("signup"));
  document.getElementById("auth-form").addEventListener("submit", handleAuthSubmit);
  document.getElementById("sign-out-btn").addEventListener("click", handleSignOut);

  document.getElementById("log-study-btn").addEventListener("click", openModal);
  document.getElementById("modal-close-btn").addEventListener("click", closeModal);
  document.getElementById("modal-cancel-btn").addEventListener("click", closeModal);
  document.getElementById("log-modal").addEventListener("click", (e) => {
    if (e.target.id === "log-modal") closeModal();
  });
  document.getElementById("log-form").addEventListener("submit", handleLogSubmit);
  document.getElementById("edit-name-btn").addEventListener("click", handleEditName);

  document.getElementById("settings-btn").addEventListener("click", openSettingsModal);
  document.getElementById("settings-close-btn").addEventListener("click", closeSettingsModal);
  document.getElementById("settings-cancel-btn").addEventListener("click", closeSettingsModal);
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettingsModal();
  });
  document.getElementById("settings-form").addEventListener("submit", handleSettingsSubmit);

  document.getElementById("export-btn").addEventListener("click", handleExport);
  document.getElementById("import-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = "";
  });
  document.getElementById("reset-btn").addEventListener("click", handleReset);

  document.getElementById("toggle-plan-btn").addEventListener("click", () => {
    const section = document.getElementById("plan-section");
    section.hidden = !section.hidden;
    document.getElementById("toggle-plan-btn").textContent = section.hidden ? "View full plan" : "Hide full plan";
    if (!section.hidden) renderPlanTable();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeSettingsModal(); closeAppearanceModal(); }
  });

  // View switcher
  document.querySelectorAll(".view-nav-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Appearance / theme
  document.getElementById("theme-btn").addEventListener("click", openAppearanceModal);
  document.getElementById("appearance-close-btn").addEventListener("click", closeAppearanceModal);
  document.getElementById("appearance-done-btn").addEventListener("click", closeAppearanceModal);
  document.getElementById("appearance-modal").addEventListener("click", (e) => {
    if (e.target.id === "appearance-modal") closeAppearanceModal();
  });
  document.getElementById("theme-custom-input").addEventListener("input", (e) => {
    selectCustomTheme(e.target.value);
  });
  document.getElementById("theme-reset-btn").addEventListener("click", () => selectThemePreset("blueprint"));

  // Flowmodoro timer
  document.getElementById("timer-start-btn").addEventListener("click", handleTimerStart);
  document.getElementById("timer-end-focus-btn").addEventListener("click", handleTimerEndFocus);
  document.getElementById("timer-discard-btn").addEventListener("click", handleTimerDiscard);
  document.getElementById("timer-skip-rest-btn").addEventListener("click", handleTimerSkipRest);
  document.getElementById("timer-add-min-btn").addEventListener("click", handleTimerAddMinute);
  document.getElementById("timer-ratio").addEventListener("input", (e) => {
    document.getElementById("ratio-value").textContent = e.target.value;
  });
  document.getElementById("timer-ratio").addEventListener("change", (e) => {
    if (timerState.status === "idle") {
      state.config.flowmodoro.ratio = Number(e.target.value) || 5;
      saveState();
    }
  });
});
