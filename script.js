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

// Lets style.css hide .reveal cards until the entrance observer is running
// (if this script ever failed to load, cards would simply stay visible).
document.documentElement.classList.add("motion-ready");

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
   MOTION HELPERS
   - whenVisible: run something the first time an element is on screen
   - tween / setCount / setBar: numbers and bars that animate to a value
   - observeReveals: cards rise once as they scroll in
   All of it is skipped when the OS asks for reduced motion.
   ========================================================= */
const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const HAS_IO = "IntersectionObserver" in window;

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutExpo = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/* Returns a cancel function. */
function tween(from, to, ms, onUpdate, ease = easeOutExpo) {
  let cancelled = false;
  const start = performance.now();
  function frame(now) {
    if (cancelled) return;
    const t = Math.min((now - start) / ms, 1);
    onUpdate(from + (to - from) * ease(t), t);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return () => { cancelled = true; };
}

const visibleObserver = HAS_IO
  ? new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        obs.unobserve(entry.target);
        const fn = entry.target._whenVisible;
        entry.target._whenVisible = null;
        if (fn) fn();
      });
    }, { threshold: 0.25 })
  : null;

function whenVisible(el, fn) {
  if (!el) return;
  if (!visibleObserver || REDUCED_MOTION) { fn(); return; }
  el._whenVisible = fn;
  visibleObserver.observe(el);
}

/* Number that counts up/down to `to`. Starts when first on screen, then
   animates from wherever it currently is on every later change. */
function setCount(el, to, { format, ms = 1200 } = {}) {
  if (!el) return;
  const fmt = format || (v => String(Math.round(v)));
  const prev = typeof el._cur === "number" ? el._cur : 0;
  const run = () => {
    el._armed = true;
    if (el._cancel) el._cancel();
    if (REDUCED_MOTION || prev === to) { el._cur = to; el.textContent = fmt(to); return; }
    el._cancel = tween(prev, to, ms, v => { el._cur = v; el.textContent = fmt(v); });
  };
  if (el._armed) { run(); return; }
  el.textContent = fmt(prev);
  whenVisible(el, run);
}

/* Formatter that shows whole numbers for whole targets, one decimal for halves. */
function countFormat(to, suffix = "") {
  const whole = Math.abs(to - Math.round(to)) < 0.001;
  return v => (whole ? String(Math.round(v)) : v.toFixed(1)) + suffix;
}

/* Progress bar fill: grows from empty the first time it is seen,
   then glides to each new value. `extra` runs alongside the width change. */
function setBar(fill, pct, extra) {
  if (!fill) return;
  const apply = () => {
    fill._armed = true;
    fill.style.width = `${pct}%`;
    if (extra) extra();
  };
  if (fill._armed || REDUCED_MOTION || !visibleObserver) { apply(); return; }
  whenVisible(fill.parentElement, () => setTimeout(apply, 280));
}

/* Cards rise once as they scroll into view */
const revealObserver = HAS_IO
  ? new IntersectionObserver((entries, obs) => {
      let i = 0;
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        obs.unobserve(el);
        el.style.setProperty("--d", `${Math.min(i++, 5) * 90}ms`);
        el.classList.add("in", "play");
        const done = e => {
          if (e.target !== el) return; // ignore child animations bubbling up
          el.classList.remove("play");
          el.removeEventListener("animationend", done);
        };
        el.addEventListener("animationend", done);
      });
    }, { threshold: 0.06, rootMargin: "0px 0px -4% 0px" })
  : null;

function observeReveals() {
  document.querySelectorAll(".reveal:not(.in)").forEach(el => {
    if (!revealObserver || REDUCED_MOTION) { el.classList.add("in"); return; }
    if (!el._revealWatched) { el._revealWatched = true; revealObserver.observe(el); }
  });
  // Safety net: never leave a visible card hidden if the observer misses it
  setTimeout(() => {
    document.querySelectorAll(".reveal:not(.in)").forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top < window.innerHeight) el.classList.add("in");
    });
  }, 2500);
}

/* Sliding underline under the active tab */
function moveNavIndicator() {
  const nav = document.getElementById("view-nav");
  const ind = document.getElementById("nav-indicator");
  const active = nav && nav.querySelector(".view-nav-btn.is-active");
  if (!ind || !active || !active.offsetWidth) return;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
}

/* Short confetti burst when the day's target is hit */
function launchConfetti() {
  if (REDUCED_MOTION) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const accent = getComputedStyle(document.documentElement).getPropertyValue("--cyan").trim() || "#79CBEA";
  const colors = ["#E85D3D", "#D99A2B", "#2FA792", accent, "#ffffff"];
  const parts = Array.from({ length: 90 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3,
    y: H * 0.6,
    vx: (Math.random() - 0.5) * 14,
    vy: -(8 + Math.random() * 10),
    w: 6 + Math.random() * 6,
    h: 4 + Math.random() * 5,
    rot: Math.random() * 6.28,
    vr: (Math.random() - 0.5) * 0.4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const DURATION = 2400;
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    parts.forEach(p => {
      p.vy += 0.38; p.vx *= 0.995;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / DURATION);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  })(start);
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
  moveNavIndicator();
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
  renderGoal();
  renderTodayFocus();
  renderDayStrip();
  renderOverallProgress();
  renderSubjectCards();
  renderWeekCard();
  renderPace();
  renderActivity();
  if (!document.getElementById("plan-section").hidden) renderPlanTable();
  observeReveals();
}

function renderHero() {
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const name = state.userName ? `, ${state.userName}` : "";
  document.getElementById("greeting").textContent = `${timeGreeting}${name}.`;

  const today = todayDate();
  const daysLeft = Math.max(Math.round((mainTargetDate() - today) / DAY_MS), 0);
  setCount(document.getElementById("days-left"), daysLeft, { ms: 1600 });

  const wIndex = weekIndexFor(today);
  const targetLabel = mainTargetDate().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  document.getElementById("hero-detail").textContent =
    `You're aiming for ${targetLabel}. That puts you in week ${wIndex} of ${totalWeeks()}.`;

  const streak = currentStreak();
  const streakEl = document.getElementById("streak-pill");
  streakEl.textContent = `${streak} day streak`;
  streakEl.classList.toggle("streak-hot", streak > 0);
  document.getElementById("tagline").textContent = streak > 0
    ? "Keep the streak alive — today's work is all that's in front of you."
    : "A fresh start today. One session is all it takes to get going.";

  document.getElementById("today-date").textContent = today.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });

  document.getElementById("edit-name-btn").textContent = state.userName ? "Edit name" : "Set your name";
}

/* =========================================================
   GOAL TRACKER — how far behind (or ahead of) the plan you are
   "Plan" = the daily targets (weekday / weekend) summed from the
   plan start through today. Lag = what the plan says you should
   have finished by tonight minus what you have actually logged.
   ========================================================= */
function nextDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); }

function fmtNum(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function plural(n, word) { return `${word}${Math.abs(n - 1) < 0.001 ? "" : "s"}`; }

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* Lectures the daily targets add up to, from plan start through today */
function plannedLecturesByToday() {
  const start = planStart();
  const today = todayDate();
  if (today < start) return 0;
  const end = today < planCutoff() ? today : planCutoff();
  let sum = 0;
  for (let d = start; d <= end; d = nextDay(d)) sum += dailyTarget(d);
  return sum;
}

function computeGoalStatus() {
  const cd = courseData();
  const keys = Object.keys(cd);
  const total = keys.reduce((s, k) => s + cd[k].total, 0);
  const done = totalCompleted();
  const remaining = Math.max(total - done, 0);
  const today = todayDate();
  const started = today >= planStart();
  const expected = Math.min(plannedLecturesByToday(), total);
  const lag = expected - done;                 // > 0 behind, < 0 ahead
  const weeklySum = totalWeeklyTarget();
  const complete = total > 0 && done >= total;

  const subjects = keys.map(k => {
    const share = weeklySum > 0 ? cd[k].weeklyTarget / weeklySum : 0;
    const exp = Math.min(Math.round(expected * share * 2) / 2, cd[k].total);
    const d = completedForSubject(k);
    return { key: k, meta: cd[k], expected: exp, done: d, lag: exp - d };
  });

  let status = "good";
  if (complete) status = "good";
  else if (!started) status = "idle";
  else if (lag > 0.0001) status = lag <= 3 ? "warn" : "danger";

  return {
    total, done, remaining, expected, lag, started, complete, status, subjects,
    daysLeft: Math.round((mainTargetDate() - today) / DAY_MS),
    daysToStart: Math.max(Math.round((planStart() - today) / DAY_MS), 0),
  };
}

const GAUGE_RADIUS = 64;
const GAUGE_C = 2 * Math.PI * GAUGE_RADIUS;
const gaugeAnim = { a: 0 };

/* a = share of today's plan you have finished (0..1). The unfinished
   remainder of the ring is hatched, like a cut surface on a drawing. */
function drawGauge(a, showGap) {
  const fill = document.getElementById("gauge-fill");
  const gap = document.getElementById("gauge-gap");
  if (!fill || !gap) return;
  fill.setAttribute("stroke-dasharray", `${a * GAUGE_C} ${GAUGE_C}`);
  fill.style.opacity = a <= 0.0005 ? 0 : 1;
  const gapLen = showGap ? (1 - a) * GAUGE_C : 0;
  gap.setAttribute("stroke-dasharray", `${gapLen} ${GAUGE_C}`);
  gap.setAttribute("stroke-dashoffset", String(-a * GAUGE_C));
}

function animateGauge(toA, showGap) {
  const el = document.getElementById("gauge");
  if (!el) return;
  const run = () => {
    el._armed = true;
    const from = gaugeAnim.a;
    if (el._cancel) el._cancel();
    if (REDUCED_MOTION || Math.abs(from - toA) < 0.0001) {
      gaugeAnim.a = toA;
      drawGauge(toA, showGap);
      return;
    }
    el._cancel = tween(from, toA, 1600, v => { gaugeAnim.a = v; drawGauge(v, showGap); });
  };
  if (el._armed) { run(); return; }
  drawGauge(0, false);
  whenVisible(el, () => setTimeout(run, 350));
}

function setStat(id, text, subId, subText, subClass) {
  const el = document.getElementById(id);
  if (el) { el._armed = false; el._cur = undefined; el.textContent = text; }
  if (subId) {
    const sub = document.getElementById(subId);
    if (sub) { sub.textContent = subText || ""; sub.className = subClass || ""; }
  }
}

function renderGoal() {
  const card = document.getElementById("goal-card");
  if (!card) return;
  const g = computeGoalStatus();
  const today = todayDate();
  const planPace = totalWeeklyTarget() / 7;

  card.classList.remove("goal-good", "goal-warn", "goal-danger", "goal-idle");
  card.classList.add(`goal-${g.status}`);

  // Headline
  const headline = document.getElementById("goal-headline");
  const targetLabel = mainTargetDate().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  headline.textContent = g.daysLeft > 0
    ? `Ultimate goal: finish all ${g.total} lectures by ${targetLabel}, ${g.daysLeft} ${plural(g.daysLeft, "day")} from now.`
    : `Ultimate goal: finish all ${g.total} lectures by ${targetLabel}.`;

  // Pill + centre of the gauge
  const pill = document.getElementById("goal-pill");
  pill.classList.remove("pill-good", "pill-warn", "pill-bad");
  const numEl = document.getElementById("goal-lag-num");
  const labelEl = document.getElementById("goal-lag-label");
  let centerValue = 0, centerLabel = "", pillText = "";

  if (g.complete) {
    pillText = "Goal complete"; pill.classList.add("pill-good");
    centerValue = g.done; centerLabel = `of ${g.total} lectures done`;
  } else if (!g.started) {
    pillText = "Plan not started";
    centerValue = g.daysToStart; centerLabel = `${plural(g.daysToStart, "day")} until your plan starts`;
  } else if (g.lag > 0.0001) {
    pillText = g.status === "warn" ? "Slightly behind" : "Behind schedule";
    pill.classList.add(g.status === "warn" ? "pill-warn" : "pill-bad");
    centerValue = g.lag; centerLabel = `${plural(g.lag, "lecture")} behind`;
  } else if (g.lag < -0.0001) {
    pillText = "Ahead of plan"; pill.classList.add("pill-good");
    centerValue = -g.lag; centerLabel = `${plural(-g.lag, "lecture")} ahead`;
  } else {
    pillText = "On schedule"; pill.classList.add("pill-good");
    centerValue = 0; centerLabel = "right on schedule";
  }
  pill.textContent = pillText;
  labelEl.textContent = centerLabel;
  setCount(numEl, centerValue, { format: countFormat(centerValue), ms: 1500 });

  // Ring: share of today's plan that is done
  const adherence = g.expected > 0 ? g.done / g.expected : (g.started ? 1 : 0);
  const showGap = g.started && !g.complete && g.lag > 0.0001;
  animateGauge(Math.min(adherence, 1), showGap);

  // Stat tiles
  const adhEl = document.getElementById("goal-adherence");
  if (g.started && g.expected > 0) {
    const adhPct = Math.round(adherence * 100);
    setCount(adhEl, adhPct, { format: v => `${Math.round(v)}%` });
    document.getElementById("goal-adherence-sub").textContent = g.done > g.expected + 0.0001 ? "of the plan so far, and more" : "of the plan so far";
  } else {
    setStat("goal-adherence", "—", "goal-adherence-sub", g.started ? "" : "starts with your plan");
  }
  setCount(document.getElementById("goal-expected"), g.expected, { format: countFormat(g.expected) });
  setCount(document.getElementById("goal-done"), g.done, { format: countFormat(g.done) });
  setCount(document.getElementById("goal-left"), g.remaining, { format: countFormat(g.remaining) });
  document.getElementById("goal-done-sub").textContent = `of ${g.total} in total`;
  document.getElementById("goal-left-sub").textContent = g.remaining > 0 ? plural(g.remaining, "lecture") : "nothing left";

  // Pace needed to hit the target date
  const needEl = document.getElementById("goal-need");
  if (g.remaining <= 0) {
    setStat("goal-need", "Done", "goal-need-sub", "every lecture finished", "good");
  } else if (g.daysLeft <= 0) {
    setStat("goal-need", "Overdue", "goal-need-sub", "target date has passed", "bad");
  } else {
    const need = g.remaining / g.daysLeft;
    const above = need > planPace + 0.05;
    setCount(needEl, need, { format: v => `${v.toFixed(1)}/day` });
    const sub = document.getElementById("goal-need-sub");
    sub.textContent = above
      ? `above the ${planPace.toFixed(1)}/day plan`
      : `within the ${planPace.toFixed(1)}/day plan`;
    sub.className = above ? "bad" : "good";
  }

  // Where the current pace lands you
  if (g.remaining <= 0) {
    setStat("goal-proj", "Done", "goal-proj-sub", "all lectures finished", "good");
  } else if (!g.started) {
    setStat("goal-proj", "—", "goal-proj-sub", "starts with your plan");
  } else if (g.done <= 0) {
    setStat("goal-proj", "—", "goal-proj-sub", "log a lecture to see");
  } else {
    const elapsed = Math.max(Math.round((today - planStart()) / DAY_MS) + 1, 1);
    const pace = g.done / elapsed;
    const finish = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Math.ceil(g.remaining / pace));
    const diff = Math.round((mainTargetDate() - finish) / DAY_MS);
    setStat("goal-proj", fmtDate(finish), "goal-proj-sub",
      diff >= 0
        ? `${diff} ${plural(diff, "day")} before the target`
        : `${-diff} ${plural(-diff, "day")} after the target`,
      diff >= 0 ? "good" : "bad");
  }

  renderGoalSubjects(g);

  // Plain-language next step
  const note = document.getElementById("goal-catchup");
  if (g.complete) {
    note.textContent = "Every lecture is done. The goal is complete.";
  } else if (!g.started) {
    note.textContent = `Your plan begins on ${planStart().toLocaleDateString(undefined, { day: "numeric", month: "long" })}. Nothing is owed yet.`;
  } else if (g.lag > 0.0001) {
    // A realistic window: small gaps in a week, big ones spread over more time
    const horizon = g.lag <= 14 ? { days: 7, label: "a week" }
      : g.lag <= 35 ? { days: 14, label: "two weeks" }
      : { days: 28, label: "four weeks" };
    const perDay = Math.ceil((g.lag / horizon.days) * 2) / 2;
    const worst = g.subjects.filter(x => x.lag > 0).sort((a, b) => b.lag - a.lag)[0];
    note.textContent =
      `To clear the ${fmtNum(g.lag)}-lecture gap in ${horizon.label}, add about ${fmtNum(perDay)} extra ${plural(perDay, "lecture")} a day on top of the daily target.` +
      (worst ? ` ${worst.meta.short} has the biggest gap (${fmtNum(worst.lag)}).` : "");
  } else if (g.lag < -0.0001) {
    const cushion = -g.lag / Math.max(planPace, 0.1);
    note.textContent = `You're ${fmtNum(-g.lag)} ${plural(-g.lag, "lecture")} ahead of plan, about ${cushion.toFixed(1)} ${cushion.toFixed(1) === "1.0" ? "day" : "days"} of cushion.`;
  } else {
    note.textContent = "Right on plan. Hit today's target and you stay there.";
  }
}

/* One thick bar per subject: full = on schedule. Whatever is not filled is the gap. */
function renderGoalSubjects(g) {
  const wrap = document.getElementById("goal-subjects");
  g.subjects.forEach(sub => {
    const c = sub.meta;
    let row = wrap.querySelector(`[data-subject="${sub.key}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "goal-sub";
      row.dataset.subject = sub.key;
      row.style.setProperty("--bar", c.color);
      row.innerHTML = `
        <div class="goal-sub-head"><span data-f="name"></span><span class="goal-sub-tag" data-f="tag"></span></div>
        <div class="ruler-track goal-track"><div class="goal-gap" data-f="gap"></div><div class="ruler-fill"></div></div>
        <div class="goal-sub-foot"><span data-f="done"></span><span data-f="plan"></span><span data-f="total"></span></div>
      `;
      wrap.appendChild(row);
    }
    const f = name => row.querySelector(`[data-f="${name}"]`);
    f("name").textContent = c.name;
    f("done").textContent = `${fmtNum(sub.done)} done`;
    f("plan").textContent = g.started ? `plan: ${fmtNum(sub.expected)}` : "plan not started";
    f("total").textContent = `${c.total} total`;

    const tag = f("tag");
    tag.classList.remove("lag", "ahead");
    if (!g.started) tag.textContent = "not started";
    else if (sub.lag > 0.0001) { tag.textContent = `${fmtNum(sub.lag)} behind`; tag.classList.add("lag"); }
    else if (sub.lag < -0.0001) { tag.textContent = `${fmtNum(-sub.lag)} ahead`; tag.classList.add("ahead"); }
    else { tag.textContent = "on plan"; }

    const behind = g.started && sub.lag > 0.0001;
    f("gap").classList.toggle("is-clear", !behind);
    const pct = sub.expected > 0 ? Math.min((sub.done / sub.expected) * 100, 100) : (g.started ? 100 : 0);
    setBar(row.querySelector(".ruler-fill"), pct);
  });
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
  setBar(document.getElementById("focus-progress-fill"), pct);

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
    launchConfetti();
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
    cell.style.setProperty("--i", 6 - i);
    const boxClass = i === 0
      ? (done >= target ? "hit today" : done > 0 ? "partial today" : "today")
      : (done >= target ? "hit" : done > 0 ? "partial" : "");
    cell.innerHTML = `
      <div class="box ${boxClass}" title="${dStr}: ${done} / ${target} lectures"></div>
      <span class="lbl">${d.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
    `;
    strip.appendChild(cell);
  }

  // The boxes pop in one after another, once, the first time the strip is on screen
  if (!strip._played) {
    strip._played = true;
    whenVisible(strip, () => {
      strip.classList.add("play");
      setTimeout(() => strip.classList.remove("play"), 1500);
    });
  }
}

function renderOverallProgress() {
  const cd = courseData();
  const total = Object.values(cd).reduce((s, c) => s + c.total, 0);
  const completed = totalCompleted();
  const remaining = Math.max(total - completed, 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  setCount(document.getElementById("overall-pct"), pct, { format: v => `${Math.round(v)}%` });
  setBar(document.getElementById("overall-progress-fill"), pct);

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

  Object.keys(cd).forEach(key => {
    const c = cd[key];
    const completed = completedForSubject(key);
    const remaining = Math.max(c.total - completed, 0);
    const pct = c.total > 0 ? Math.round((completed / c.total) * 100) : 0;
    const weekDone = subjectDoneInRange(key, wStart, wEnd);

    // Cards are created once and then updated, so bars and counters glide
    // to new values instead of restarting every time the dashboard refreshes.
    let card = grid.querySelector(`[data-subject="${key}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className = "subject-card reveal";
      card.dataset.subject = key;
      card.style.setProperty("--subject-color", c.color);
      card.style.setProperty("--bar", c.color);
      card.innerHTML = `
        <div class="subject-card-head">
          <div>
            <h3 data-f="name"></h3>
            <span class="subject-abbr" data-f="abbr"></span>
          </div>
          <span class="subject-pct" data-f="pct">0%</span>
        </div>
        <div class="ruler-track"><div class="ruler-fill"></div></div>
        <div class="subject-stats">
          <div><strong data-f="completed"></strong>Completed</div>
          <div><strong data-f="remaining"></strong>Remaining</div>
        </div>
        <div class="subject-week">
          <span data-f="weekly"></span>
          <span data-f="thisweek"></span>
        </div>
      `;
      grid.appendChild(card);
    }

    const f = name => card.querySelector(`[data-f="${name}"]`);
    f("name").innerHTML = `${c.name}${pct >= 100 ? `<span class="subject-badge">cleared</span>` : ""}`;
    f("abbr").textContent = c.short;
    f("completed").textContent = completed;
    f("remaining").textContent = remaining;
    f("weekly").textContent = `Weekly target: ${c.weeklyTarget}`;
    f("thisweek").textContent = `This week: ${weekDone} / ${c.weeklyTarget}`;
    setCount(f("pct"), pct, { format: v => `${Math.round(v)}%` });
    setBar(card.querySelector(".ruler-fill"), pct);
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
  setBar(document.getElementById("week-progress-fill"), pct);
  document.getElementById("week-left").textContent = left > 0
    ? `${left} lecture${left !== 1 ? "s" : ""} left this week`
    : "Weekly target complete";

  const rows = document.getElementById("week-subject-rows");
  Object.keys(cd).forEach(key => {
    const c = cd[key];
    const done = subjectDoneInRange(key, wStart, wEnd);
    const subPct = c.weeklyTarget > 0 ? Math.min(Math.round((done / c.weeklyTarget) * 100), 100) : 0;

    let row = rows.querySelector(`[data-subject="${key}"]`);
    if (!row) {
      row = document.createElement("div");
      row.className = "week-subject-row";
      row.dataset.subject = key;
      row.style.setProperty("--bar", c.color);
      row.innerHTML = `
        <span>${c.short}</span>
        <div class="track"><div class="ruler-fill"></div></div>
        <span class="count"></span>
      `;
      rows.appendChild(row);
    }
    row.querySelector(".count").textContent = `${done} / ${c.weeklyTarget}`;
    setBar(row.querySelector(".ruler-fill"), subPct);
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
  requestAnimationFrame(moveNavIndicator);
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

  // Motion: card entrances + sliding tab underline
  observeReveals();
  window.addEventListener("resize", moveNavIndicator);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveNavIndicator);

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
