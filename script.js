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

  try {
    populateSubjectSelect();
    render();
  } catch (err) {
    console.error("Dashboard render failed:", err);
    state = mergeIntoDefaultState(null);
    try {
      populateSubjectSelect();
      render();
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
    if (e.key === "Escape") { closeModal(); closeSettingsModal(); }
  });
});
