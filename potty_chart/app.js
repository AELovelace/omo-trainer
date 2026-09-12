/* -- LiDOLL QUEST // Promotional Growth Chart ------------------------------
   The chart stays in one browser save until its owner signs in to link it.
   account.js then syncs it through the shared Little Log session and database.

   Stars are keyed by REAL CALENDAR DATE, so the chart shows the actual week you
   are standing in and every earlier week stays on file. Chrysalis never throws
   a chart away, which is the joke and also the horror.

   Rows are editable: the visitor can rename any row, retitle its margin note,
   remove one, or add their own. The single exception is the locked row -- see
   lockedRow() below. It cannot be renamed, cannot be removed, and can never be
   starred, because that is the entire point of the piece.

   The authored content is lifted from the Princess's Quarters orb line:
     orb_princess_quarters_02  "Your Special Day"    -> the daily schedule rows
     orb_princess_quarters_03  "Blocks and Cheering" -> the playtime row
     orb_princess_quarters_04  "Your Growth Chart"   -> the chart itself
     orb_princess_quarters_07  "Paid In Full"        -> the ledger stamp
     orb_princess_quarters_08  "The Wonderful Nap"   -> the naptime row
     orb_princess_quarters_09  "An Invitation"       -> the friend's note reveal
   ------------------------------------------------------------------------ */

(() => {
  "use strict";

  const STORAGE_KEY = "ldq-growth-chart-v2";       // Save format: stars keyed by calendar date, plus the row list.
  const LEGACY_KEY = "ldq-growth-chart-v1";        // First release: stars keyed by weekday index, fixed rows.
  const CRT_KEY = "ldq-crt-effect";                // Shared with the main site so the preference carries over.
  const DAY_COUNT = 7;                             // A chart week runs Monday to Sunday.
  const REFUSALS_TO_REVEAL = 5;                    // How many times you must insist before the friend answers.
  const HISTORY_LIMIT = 8;                         // Most recent weeks listed in the file summary.
  const MAX_ROWS = 16;                             // Keeps the grid legible and the saved file small.
  const LABEL_MAX = 48;                            // Character cap on a row name.
  const NOTE_MAX = 72;                             // Character cap on a row's margin note.

  /* Monday-first name tables. The game is not localized, so the chart is not
     either -- the authored voice is English and the dates should match it.     */
  const WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_LONG = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  /* -- Default rows --------------------------------------------------------- */
  /* The chart a visitor is handed before they change anything. Each row is one
     behaviour Chrysalis grades you on. The last row is the trap: the orb states
     outright that no star is ever available for it.                           */
  const DEFAULT_ROWS = [
    {
      id: "diaper",
      label: "Used your diaper instead of holding it",
      note: "Every accident is a gold star, sweetie.",
      praise: "A wet star! That is the easiest one to earn, and you barely noticed."
    },
    {
      id: "nap",
      label: "Naptime, taken without a fuss",
      note: "She asks for naps now. Three, four times a day.",
      praise: "Such a peaceful sleeper. You did not even ask how long you were out."
    },
    {
      id: "dressed",
      label: "Let the attendants dress you",
      note: "The Morning Cuddle, with the whole household smiling.",
      praise: "You held your arms up all by yourself. Everyone said how sweet that was."
    },
    {
      id: "snack",
      label: "Snacktime, all finished up",
      note: "Nothing on the list is a chore. Nothing is work.",
      praise: "Every bite gone. You did not have to choose a single thing on that tray."
    },
    {
      id: "parade",
      label: "Garden Parade, waved at everyone",
      note: "Your prettiest dress, so every citizen can wave.",
      praise: "The whole city waved back. They love seeing our girl out in the sun."
    },
    {
      id: "blocks",
      label: "Playtime with blocks",
      note: "Let it fall, little one. We will build it again.",
      praise: "The tower fell and you laughed instead of minding. That is real progress."
    },
    {
      id: "potty",
      label: "Asked for the potty",
      note: "Big girls hold it and ask. Our girl does not have to!",
      locked: true                                  // Never starrable, never editable, never removable.
    }
  ];

  const LOCKED_ROW_ID = "potty";                    // The one row the chart insists on keeping.

  /* Praise for a row the visitor wrote themselves. Chrysalis is delighted to
     grade anything at all, which is somehow worse than a specific compliment.  */
  const CUSTOM_PRAISE = "A gold star for that one too. We keep track of everything you do.";

  /* -- Escalating praise, as a fraction of the perfect week ----------------- */
  /* Fractions rather than counts, because the visitor can change how many rows
     the chart has, and a perfect week has to mean the same thing either way.   */
  const PRAISE_TIERS = [
    { at: 0,    line: "A brand new week, all made up and waiting just for you." },
    { at: 0.01, line: "Off to a lovely start! We knew you would settle in." },
    { at: 0.19, line: "Look how well you are doing. Nobody had to ask you twice." },
    { at: 0.38, line: "Half a perfect week already, and you have stopped keeping track." },
    { at: 0.57, line: "You are not thinking about any of it anymore. That is the nicest part." },
    { at: 0.76, line: "Almost a perfect week! Soon you will not even notice at all." },
    { at: 0.95, line: "So close, sweetie. Everyone downstairs is already so proud." },
    { at: 1,    line: "A PERFECT WEEK. You may rest now. You have earned such a long, wonderful nap." }
  ];

  /* -- What the chart says when you insist on the locked row --------------- */
  /* It never gets angry. It gets kinder, which is worse.                     */
  const REFUSAL_LINES = [
    "Oh, sweetie -- that row is not for you! Big girls hold it and ask. Our girl does not have to.",
    "There is no star there, darling. We took that little worry away from you already.",
    "You do not need to ask. You have never needed to ask. Isn't that a relief?",
    "Why do you keep reaching for that one? Everything you need is in the other rows.",
    "Please stop asking, sweetheart. You are doing so well everywhere else."
  ];

  /* -- What the chart says when you try to edit or remove the locked row --- */
  const LOCKED_EDIT_LINES = [
    "That row stays, sweetie. It is part of the chart.",
    "You may change any of the others! Just not that one. It is important to us.",
    "We cannot take that row off, darling. How else would we show how far you have come?"
  ];

  /* -- What the chart says when you reach for a day that has not come yet -- */
  const FUTURE_LINES = [
    "That day has not happened yet, sweetie! But it will, and it will look just like the others.",
    "No peeking ahead, darling. We already know how that one goes.",
    "Patience! Your days are all arranged for you already. You will not have to decide a thing."
  ];

  /* -- Element handles ---------------------------------------------------- */
  const grid = document.querySelector("#star-grid");              // Container the chart cells are built into.
  const nameField = document.querySelector("#chart-name");        // Visitor name, printed into the chart header.
  const weekLabel = document.querySelector("#week-label");        // Date range of the week currently shown.
  const weekPrev = document.querySelector("#week-prev");          // Steps one week back into the file.
  const weekNext = document.querySelector("#week-next");          // Steps one week forward, never past today.
  const weekToday = document.querySelector("#week-today");        // Jumps straight back to the live week.
  const progressFill = document.querySelector("#progress-fill");  // Gold bar showing the shown week filling up.
  const progressCount = document.querySelector("#progress-count"); // Numeric readout beside the bar.
  const praiseLine = document.querySelector("#praise-line");      // Live region carrying the Chrysalis voice.
  const addRowButton = document.querySelector("#add-row");        // Appends a blank row and opens it for editing.
  const finePrint = document.querySelector("#fineprint");         // Storage reassurance / share confirmation.
  const ledgerStamp = document.querySelector("#ledger-stamp");    // Revealed at a full week.
  const ledgerName = document.querySelector("#ledger-name");      // Visitor name inside the ledger line.
  const friendNote = document.querySelector("#friend-note");      // Revealed by refusing the locked row.
  const historySummary = document.querySelector("#history-summary"); // Lifetime totals sentence.
  const historyList = document.querySelector("#history-list");    // Clickable list of earlier weeks.
  const resetButton = document.querySelector("#reset-button");    // Wipes the saved file.
  const shareButton = document.querySelector("#share-button");    // Copies a shareable summary line.
  const crtToggle = document.querySelector("#crt-toggle");        // Scanline accessibility control.

  /* -- Date helpers -------------------------------------------------------- */

  function startOfDay(date) {
    const copy = new Date(date.getTime());                        // Never mutates the caller's Date.
    copy.setHours(0, 0, 0, 0);                                    // Local midnight, so comparisons ignore clock time.
    return copy;
  }

  function dateKey(date) {
    const year = date.getFullYear();                              // Local calendar parts, never UTC -- a UTC key
    const month = String(date.getMonth() + 1).padStart(2, "0");   // would slide the chart a day for anyone west
    const day = String(date.getDate()).padStart(2, "0");          // of Greenwich after their evening.
    return `${year}-${month}-${day}`;                             // Sortable "YYYY-MM-DD" key.
  }

  function mondayIndex(date) {
    return (date.getDay() + 6) % 7;                               // Converts JS Sunday-first (0-6) to Monday-first.
  }

  function startOfWeek(date) {
    const start = startOfDay(date);                               // Work from local midnight.
    start.setDate(start.getDate() - mondayIndex(start));          // Walk back to that week's Monday.
    return start;
  }

  function addDays(date, amount) {
    const copy = startOfDay(date);                                // Copy first so the source week is untouched.
    copy.setDate(copy.getDate() + amount);                        // setDate rolls months and years correctly.
    return copy;
  }

  function weekDates(weekStart) {
    return Array.from({ length: DAY_COUNT }, (unused, offset) => addDays(weekStart, offset)); // Mon..Sun.
  }

  function shortDate(date) {
    return `${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;   // "5 Sep" -- fits the narrow column heads.
  }

  function longDate(date) {
    return `${WEEKDAY_LONG[mondayIndex(date)]} ${date.getDate()} ${MONTH_LONG[date.getMonth()]}`; // Spoken label.
  }

  function weekRangeLabel(weekStart) {
    const end = addDays(weekStart, DAY_COUNT - 1);                // Sunday closing the shown week.
    return `${shortDate(weekStart)}–${shortDate(end)} ${end.getFullYear()}`;   // "1 Sep-7 Sep 2026".
  }

  let today = startOfDay(new Date());                             // Refreshed when a long-lived installed app crosses midnight.
  let todayKey = dateKey(today);                                  // Used to highlight the live column.
  let currentWeekStart = startOfWeek(today);                      // The furthest week the visitor may open.

  let viewWeekStart = currentWeekStart;                           // Which week the grid is currently showing.
  let editingRowId = null;                                        // Row currently open in its rename form, if any.

  /* -- Rows ---------------------------------------------------------------- */

  function cloneDefaultRows() {
    return DEFAULT_ROWS.map((row) => ({ ...row }));               // Fresh copies so edits never touch the constant.
  }

  function sanitizeRows(candidateRows) {
    /* Row data can be hand-edited in devtools or carried over from an older
       release, so everything is re-checked rather than trusted.               */
    const cleaned = [];
    const seenIds = new Set();

    candidateRows.forEach((row) => {
      if (!row || typeof row !== "object") return;                // Skips nulls and stray primitives.
      if (typeof row.id !== "string" || !row.id) return;          // A row without an identity cannot hold stars.
      if (seenIds.has(row.id)) return;                            // Duplicate ids would share a star key.

      seenIds.add(row.id);
      cleaned.push({
        id: row.id,
        label: String(row.label || "Untitled row").slice(0, LABEL_MAX),
        note: String(row.note || "").slice(0, NOTE_MAX),
        praise: typeof row.praise === "string" ? row.praise : CUSTOM_PRAISE,
        locked: row.id === LOCKED_ROW_ID                          // Locked status is by id, never by saved flag.
      });
    });

    if (!cleaned.some((row) => row.id === LOCKED_ROW_ID)) {
      const authored = DEFAULT_ROWS.find((row) => row.id === LOCKED_ROW_ID);
      cleaned.push({ ...authored });                              // The locked row is restored if it went missing.
    }

    return [...cleaned.filter(row => !row.locked).slice(0, MAX_ROWS - 1), cleaned.find(row => row.locked)]; // Reserve a slot so the locked row survives oversized saves.
  }

  function lockedRow() {
    return state.rows.find((row) => row.id === LOCKED_ROW_ID);    // sanitizeRows guarantees this exists.
  }

  function starrableRows() {
    return state.rows.filter((row) => !row.locked);               // Every row except the trap row.
  }

  function orderedRows() {
    return [...starrableRows(), lockedRow()];                     // The punchline is always the bottom row.
  }

  function totalStars() {
    return starrableRows().length * DAY_COUNT;                    // A perfect week, at the current row count.
  }

  /* -- State --------------------------------------------------------------- */

  function blankState() {
    return {
      name: "",                                                   // Whoever the chart belongs to.
      stars: {},                                                  // Map of "YYYY-MM-DD:rowId" -> true.
      rows: cloneDefaultRows(),                                   // The visitor's own row list.
      refusals: 0,                                                // Times the locked row was pressed, ever.
      escaped: false,                                             // Whether the friend's note has been unlocked.
      since: todayKey,                                            // Date the file was opened, for the summary line.
      sync: null                                                  // New charts link automatically once a verified account session is available.
    };
  }

  function migrateLegacy(parsed) {
    /* v1 keyed stars as "rowId:dayIndex" with no date at all. The kindest
       reading of that data is that it described the visitor's current week, so
       the indexes are laid onto the dates of the week they are opening now.   */
    const migrated = blankState();
    migrated.name = typeof parsed.name === "string" ? parsed.name.slice(0, 24) : "";
    migrated.refusals = Number.isFinite(parsed.refusals) ? parsed.refusals : 0;
    migrated.escaped = parsed.escaped === true;

    const dates = weekDates(currentWeekStart);                    // Target dates for the seven old columns.
    const validIds = new Set(DEFAULT_ROWS.filter((row) => !row.locked).map((row) => row.id));

    Object.keys(parsed.stars || {}).forEach((legacyKey) => {
      const [rowId, dayText] = legacyKey.split(":");              // Old shape was row first, day index second.
      const dayIndex = Number(dayText);

      if (!validIds.has(rowId)) return;                           // Drops rows that no longer exist.
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= DAY_COUNT) return; // Drops junk indexes.

      migrated.stars[`${dateKey(dates[dayIndex])}:${rowId}`] = true; // Re-keys onto a real calendar date.
    });

    return migrated;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);              // Current-format file, if there is one.

      if (raw) {
        const parsed = JSON.parse(raw);                           // Hand-edited or truncated data may be malformed.
        return {
          name: typeof parsed.name === "string" ? parsed.name.slice(0, 24) : "",   // Trims to the field maxlength.
          stars: parsed.stars && typeof parsed.stars === "object" ? parsed.stars : {}, // Date-keyed star map.
          rows: Array.isArray(parsed.rows) && parsed.rows.length                     // Saves from before rows were
            ? sanitizeRows(parsed.rows)                                              // editable simply have none,
            : cloneDefaultRows(),                                                    // so they adopt the defaults.
          refusals: Number.isFinite(parsed.refusals) ? parsed.refusals : 0,        // Lifetime refusal count.
          escaped: parsed.escaped === true,                                        // Friend's note unlocked?
          since: typeof parsed.since === "string" ? parsed.since : todayKey,        // First-visit date.
          sync: parsed.sync || null                                                // Keep ownership and retry content in the same atomic save as the stars.
        };
      }

      const legacyRaw = localStorage.getItem(LEGACY_KEY);         // Returning visitor from the first release.

      if (legacyRaw) {
        const migrated = migrateLegacy(JSON.parse(legacyRaw));    // Carry their stars onto real dates.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated)); // Write the new format straight away.
        localStorage.removeItem(LEGACY_KEY);                      // Retire the old key so it cannot re-import.
        return migrated;
      }

      return blankState();                                        // First visit gets an empty file.
    } catch (error) {
      return blankState();                                        // Corrupt or blocked storage simply starts over.
    }
  }

  let state = loadState();                                        // Restores previous visits, or starts fresh.
  let account, lastStored = null, storageFailed = false;
  try { lastStored = localStorage.getItem(STORAGE_KEY); } catch { /* The storage warning below explains unavailable persistence. */ }

  function saveState(notifyAccount = true) {
    try {
      const latest=localStorage.getItem(STORAGE_KEY);
      if(latest!==lastStored && latest && lastStored) {
        const remote=JSON.parse(latest),base=JSON.parse(lastStored);
        if(remote.sync?.participant.id!==state.sync?.participant.id) throw new Error("Another account changed this browser chart.");
        state={...window.mergeGrowthCharts({base,local:state,remote}),sync:remote.sync}; // Combine another tab's saved edits before writing this tab's next edit.
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));   // Persists the whole file in one write.
      lastStored = JSON.stringify(state);
      storageFailed = false;
      if (notifyAccount) account?.changed();
      return true;
    } catch (error) {
      storageFailed = true;
      finePrint.textContent = "This edit could not be saved in the browser. Download a chart backup before reloading. Sync is paused.";
      return false; // Failed local writes must not be reported as durable or uploaded without a retry record.
    }
  }

  /* -- Star bookkeeping ---------------------------------------------------- */

  function starKey(date, rowId) {
    return `${dateKey(date)}:${rowId}`;                           // Date first, so keys sort chronologically.
  }

  function isStarred(date, rowId) {
    return state.stars[starKey(date, rowId)] === true;            // Absent keys read as no star.
  }

  function countWeekStars(weekStart) {
    return weekDates(weekStart).reduce((runningTotal, date) => {
      const dayPrefix = `${dateKey(date)}:`;                      // Every star recorded on that calendar day.
      return runningTotal + Object.keys(state.stars).filter((key) => key.startsWith(dayPrefix)).length;
    }, 0);
  }

  function weekBuckets() {
    /* Groups every star on file by the Monday of its week, so the history list
       can be built without storing a second, drift-prone summary structure.   */
    const buckets = new Map();                                    // Monday date key -> star count.

    Object.keys(state.stars).forEach((key) => {
      const [datePart] = key.split(":");                          // "YYYY-MM-DD" half of the star key.
      const [year, month, day] = datePart.split("-").map(Number);

      if (!year || !month || !day) return;                        // Ignores anything that is not a real date key.

      const monday = startOfWeek(new Date(year, month - 1, day)); // Local Date, matching how the key was written.
      const mondayKey = dateKey(monday);
      buckets.set(mondayKey, (buckets.get(mondayKey) || 0) + 1);  // Tally one more star into that week.
    });

    return buckets;
  }

  function parseDateKey(key) {
    const [year, month, day] = key.split("-").map(Number);        // Rebuilds a local Date from a stored key.
    return new Date(year, month - 1, day);
  }

  /* -- Row editing --------------------------------------------------------- */

  function newRowId() {
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; // Collision-proof enough.
  }

  function beginEdit(rowId) {
    editingRowId = rowId;                                         // buildGrid renders this row as a form.
    buildGrid();
    refresh();

    const field = grid.querySelector(".row-edit-label");           // Focus lands on the name straight away.
    if (field && field.focus) field.focus();
  }

  function cancelEdit() {
    editingRowId = null;                                          // Drops back to the read-only row label.
    buildGrid();
    refresh();
  }

  function commitEdit(rowId, label, note) {
    const row = state.rows.find((candidate) => candidate.id === rowId);
    if (!row) return;                                             // Row vanished between render and submit.

    const cleanLabel = label.trim().slice(0, LABEL_MAX);          // Empty names would make an unreadable chart.
    row.label = cleanLabel || row.label;                          // Blank input keeps whatever it had.
    row.note = note.trim().slice(0, NOTE_MAX);                    // A blank note is allowed and simply disappears.

    editingRowId = null;
    saveState();
    buildGrid();
    refresh("Chart updated. We have made a note of the change, of course.");
  }

  function addRow() {
    if (state.rows.length >= MAX_ROWS) {                          // Cap keeps the grid and the save file sane.
      refresh(`That is as many rows as this chart can hold (${MAX_ROWS}). You are doing plenty already!`);
      return;
    }

    const row = {
      id: newRowId(),
      label: "A new thing to be good at",                         // Placeholder the visitor immediately overwrites.
      note: "",
      praise: CUSTOM_PRAISE,
      locked: false
    };

    state.rows.push(row);                                         // Appended above the locked row by orderedRows().
    saveState();
    beginEdit(row.id);                                            // Opens straight into the rename form.
  }

  function deleteRow(rowId) {
    const row = state.rows.find((candidate) => candidate.id === rowId);
    if (!row || row.locked) return;                               // The locked row is handled by refuseLockedEdit().

    const lostStars = Object.keys(state.stars).filter((key) => key.endsWith(`:${rowId}`));
    lostStars.forEach((key) => delete state.stars[key]);          // Purged, so the totals stay honest afterwards.

    state.rows = state.rows.filter((candidate) => candidate.id !== rowId);
    if (editingRowId === rowId) editingRowId = null;              // Never leave a form open on a deleted row.

    saveState();
    buildGrid();
    refresh(lostStars.length > 0
      ? `Row removed. Its ${lostStars.length} ${lostStars.length === 1 ? "star has" : "stars have"} been struck from the record.`
      : "Row removed. It was not one of the important ones anyway.");
  }

  function refuseLockedEdit() {
    /* Trying to rename or remove the locked row counts as insisting, exactly
       like clicking one of its boxes -- so this is a second route to orb 09.  */
    state.refusals += 1;

    const index = Math.min(state.refusals - 1, LOCKED_EDIT_LINES.length - 1);
    let message = LOCKED_EDIT_LINES[index];

    if (state.refusals >= REFUSALS_TO_REVEAL && !state.escaped) {
      state.escaped = true;                                       // Insisting long enough unlocks the friend's note.
      message = "...someone slid something under the door while you were arguing with a piece of card.";
    }

    saveState();
    refresh(message);
  }

  /* -- Chart construction --------------------------------------------------- */

  const cellButtons = new Map();                                  // Maps "rowId:dayOffset" to its rendered button.

  function buildDayHeadings(dates) {
    const corner = document.createElement("div");                 // Empty top-left cell above the row labels.
    corner.className = "grid-corner";
    corner.textContent = "This week";
    corner.setAttribute("role", "presentation");
    grid.appendChild(corner);

    dates.forEach((date, offset) => {
      const head = document.createElement("div");                 // One column heading per real day.
      head.className = "grid-day";
      head.setAttribute("role", "columnheader");

      const isToday = dateKey(date) === todayKey;                 // Marks the live column.
      if (isToday) head.classList.add("is-today");
      if (date > today) head.classList.add("is-future");          // Days that have not arrived read as dimmed.

      const nameSpan = document.createElement("span");            // "Mon"
      nameSpan.className = "day-name";
      nameSpan.textContent = WEEKDAY_SHORT[offset];

      const dateSpan = document.createElement("span");            // "5 Sep"
      dateSpan.className = "day-date";
      dateSpan.textContent = shortDate(date);

      head.append(nameSpan, dateSpan);

      if (isToday) {
        const tag = document.createElement("span");               // Small caption so today is obvious at a glance.
        tag.className = "day-today-tag";
        tag.textContent = "today";
        head.appendChild(tag);
      }

      grid.appendChild(head);
    });
  }

  function buildRowLabel(row) {
    const label = document.createElement("div");                  // Row heading: the behaviour being graded.
    label.className = row.locked ? "row-label locked-row" : "row-label";
    label.setAttribute("role", "rowheader");

    if (editingRowId === row.id) {
      label.appendChild(buildRowForm(row));                       // This row is open for renaming.
      return label;
    }

    const view = document.createElement("div");
    view.className = "row-label-view";

    const labelText = document.createElement("span");             // Authored and visitor copy alike is set as
    labelText.className = "row-label-text";                       // textContent, never innerHTML, so a row name
    labelText.textContent = row.label;                            // can never inject markup into the page.
    view.appendChild(labelText);

    if (row.note) {
      const labelNote = document.createElement("span");
      labelNote.className = "row-note";
      labelNote.textContent = row.note;
      view.appendChild(labelNote);
    }

    label.appendChild(view);

    const tools = document.createElement("div");                  // Rename / remove controls for this row.
    tools.className = "row-tools";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "row-tool";
    editButton.textContent = "✎";                            // Pencil.
    editButton.setAttribute("aria-label", `Rename the row "${row.label}"`);
    editButton.addEventListener("click", () => (row.locked ? refuseLockedEdit() : beginEdit(row.id)));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "row-tool row-tool-delete";
    deleteButton.textContent = "×";                          // Multiplication sign reads as a clean cross.
    deleteButton.setAttribute("aria-label", `Remove the row "${row.label}"`);
    deleteButton.addEventListener("click", () => (row.locked ? refuseLockedEdit() : deleteRow(row.id)));

    if (row.locked) {
      editButton.classList.add("is-locked-tool");                 // Styled as unavailable, but still clickable so
      deleteButton.classList.add("is-locked-tool");               // the refusal has somewhere to happen.
      editButton.setAttribute("aria-disabled", "true");
      deleteButton.setAttribute("aria-disabled", "true");
    }

    tools.append(editButton, deleteButton);
    label.appendChild(tools);
    return label;
  }

  function buildRowForm(row) {
    const form = document.createElement("form");                  // A real form, so Enter submits and Esc cancels.
    form.className = "row-edit";

    const labelField = document.createElement("input");
    labelField.type = "text";
    labelField.className = "row-edit-label";
    labelField.maxLength = LABEL_MAX;
    labelField.value = row.label;
    labelField.setAttribute("aria-label", "Row name");
    labelField.placeholder = "What are you being graded on?";

    const noteField = document.createElement("input");
    noteField.type = "text";
    noteField.className = "row-edit-note";
    noteField.maxLength = NOTE_MAX;
    noteField.value = row.note;
    noteField.setAttribute("aria-label", "Margin note");
    noteField.placeholder = "A little note in the margin (optional)";

    const actions = document.createElement("div");
    actions.className = "row-edit-actions";

    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "row-edit-save";
    saveButton.textContent = "Save";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "row-edit-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", cancelEdit);

    actions.append(saveButton, cancelButton);
    form.append(labelField, noteField, actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();                                     // Keeps the page from navigating on Enter.
      commitEdit(row.id, labelField.value, noteField.value);
    });

    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cancelEdit();                   // Escape abandons the edit, as expected.
    });

    return form;
  }

  function buildGrid() {
    grid.textContent = "";                                        // Clears any previously rendered week.
    cellButtons.clear();

    const dates = weekDates(viewWeekStart);                       // The seven real dates now on show.
    buildDayHeadings(dates);

    orderedRows().forEach((row) => {
      grid.appendChild(buildRowLabel(row));

      dates.forEach((date, offset) => {
        const cell = document.createElement("button");            // Every box is a real button for keyboard users.
        cell.type = "button";
        cell.className = "star-cell";
        cell.textContent = "★";                              // Solid star glyph, transparent until awarded.
        cell.dataset.row = row.id;                                // Identifies which behaviour this box grades.
        cell.dataset.date = dateKey(date);                        // Identifies the exact calendar day.

        const isFuture = date > today;                            // Days ahead of today cannot be filled in.
        if (row.locked) cell.classList.add("is-locked");          // The row no star is ever available for.
        if (isFuture) cell.classList.add("is-future");
        if (dateKey(date) === todayKey) cell.classList.add("in-today-column"); // Tints the live column.
        if (row.locked || isFuture) cell.setAttribute("aria-disabled", "true"); // Announced, but still focusable.

        cell.setAttribute("aria-pressed", "false");               // Announces the star state to screen readers.
        cell.setAttribute("aria-label", `${row.label}, ${longDate(date)}`); // Gives the box a spoken identity.
        cell.addEventListener("click", () => handleCellClick(row, date, cell)); // One handler per box.

        grid.appendChild(cell);
        cellButtons.set(`${row.id}:${offset}`, { cell, date, row }); // Cached so refreshes never re-query the DOM.
      });
    });
  }

  /* -- Interaction ---------------------------------------------------------- */

  function playOnce(cell, className) {
    cell.classList.remove(className);                             // Resets the animation so it can replay.
    void cell.offsetWidth;                                        // Forces reflow so re-adding re-triggers it.
    cell.classList.add(className);                                // Plays the pop or the refusal wobble.
  }

  function handleCellClick(row, date, cell) {
    if (row.locked) {                                             // The "asked for the potty" row never accepts a star.
      handleRefusal(cell);
      return;
    }

    const key = starKey(date, row.id);                            // Cell identity inside the saved star map.
    const wasStarred = state.stars[key] === true;                 // Clicking an awarded star takes it back.

    if (date > today && !wasStarred) {                            // Future days are not yours to fill in yet.
      playOnce(cell, "refused");
      refresh(FUTURE_LINES[date.getDate() % FUTURE_LINES.length]); // Varies the line by date so it is not repetitive.
      return;                                                     // An already-starred future day stays removable,
    }                                                             // so migrated v1 data is never stuck in place.

    if (wasStarred) {
      delete state.stars[key];                                    // Removing keeps the saved object small.
    } else {
      state.stars[key] = true;                                    // Award the gold star, dated.
      playOnce(cell, "just-starred");
    }

    saveState();                                                  // Writes immediately so a refresh never loses a star.
    refresh(wasStarred ? null : (row.praise || CUSTOM_PRAISE));   // Awarding shows the row's own line of praise.
  }

  function handleRefusal(cell) {
    state.refusals += 1;                                          // Counts how stubborn the visitor is being, ever.
    playOnce(cell, "refused");                                    // Plays the gentle "no" wobble.

    const index = Math.min(state.refusals - 1, REFUSAL_LINES.length - 1); // Walks the escalation, then holds.
    let message = REFUSAL_LINES[index];                           // The chart's kindly refusal for this attempt.

    if (state.refusals >= REFUSALS_TO_REVEAL && !state.escaped) {
      state.escaped = true;                                       // Insisting long enough unlocks the friend's note.
      message = "...someone slid something under the door while you were arguing with a piece of card.";
    }

    saveState();                                                  // Refusal count and the reveal both persist.
    refresh(message);                                             // Shows the refusal in place of the praise line.
  }

  /* -- Rendering ------------------------------------------------------------ */

  function praiseFor(total, max) {
    if (total <= 0 || max <= 0) return PRAISE_TIERS[0].line;      // Empty week, or a chart with no starrable rows.

    const fraction = total / max;                                 // Tiers are fractions so row edits cannot break them.
    let line = PRAISE_TIERS[0].line;

    PRAISE_TIERS.forEach((tier) => {
      if (fraction >= tier.at) line = tier.line;                  // Highest tier the fill has reached wins.
    });

    return line;
  }

  function dayWord(count) {
    return `${count} ${count === 1 ? "day" : "days"}`;             // Keeps the file summary reading like a sentence.
  }

  function renderHistory() {
    const buckets = weekBuckets();                                // Star totals grouped by week, built from the stars.
    const lifetimeStars = Object.keys(state.stars).length;        // Every star ever awarded, across all weeks.
    const perfect = totalStars();                                 // What a perfect week means at the current row count.
    const perfectWeeks = perfect > 0
      ? Array.from(buckets.values()).filter((count) => count >= perfect).length
      : 0;
    const daysOnFile = Math.max(1, Math.round((today - parseDateKey(state.since)) / 86400000) + 1); // Inclusive.

    historyList.textContent = "";                                 // Rebuild rather than diff; the list is tiny.

    if (lifetimeStars === 0) {
      historySummary.textContent = state.since === todayKey
        ? "Nothing on file yet. We will start one for you today."
        : `Your file has been open ${dayWord(daysOnFile)} and is still empty. Someone will be asked about that.`;
      return;                                                     // No week rows to draw yet.
    }

    historySummary.textContent = `Your file goes back ${dayWord(daysOnFile)}: `
      + `${lifetimeStars} gold stars across ${buckets.size} `
      + `${buckets.size === 1 ? "week" : "weeks"}`
      + `${perfectWeeks > 0 ? `, ${perfectWeeks} of them perfect` : ""}. `
      + `Stars in "${lockedRow().label.toLowerCase()}": 0.`;      // The row that never moves, stated plainly.

    Array.from(buckets.entries())
      .sort((left, right) => (left[0] < right[0] ? 1 : -1))       // Newest week first; keys sort as dates.
      .slice(0, HISTORY_LIMIT)                                    // Keeps the card from growing without limit.
      .forEach(([mondayKey, count]) => {
        const monday = parseDateKey(mondayKey);                   // Rebuilds the week start for labelling.
        const item = document.createElement("li");

        const jump = document.createElement("button");            // Each past week is clickable and re-openable.
        jump.type = "button";
        jump.className = "history-row";
        if (mondayKey === dateKey(viewWeekStart)) jump.classList.add("is-viewing"); // Marks the shown week.

        const range = document.createElement("span");
        range.className = "history-range";
        range.textContent = mondayKey === dateKey(currentWeekStart)
          ? `This week (${weekRangeLabel(monday)})`               // Names the live week rather than dating it twice.
          : weekRangeLabel(monday);

        const score = document.createElement("span");
        score.className = "history-score";
        /* A bare count, not a fraction: the visitor can change how many rows the
           chart has, so an old week has no honest denominator to show. */
        score.textContent = perfect > 0 && count >= perfect
          ? `${count} ★ perfect`
          : `${count} ★`;

        jump.append(range, score);
        jump.addEventListener("click", () => showWeek(monday));   // Re-opens that week in the grid above.
        item.appendChild(jump);
        historyList.appendChild(item);
      });
  }

  function refresh(overrideMessage) {
    const total = countWeekStars(viewWeekStart);                  // Gold stars in the week currently on show.
    const perfect = totalStars();                                 // Denominator for the meter and the praise tiers.

    cellButtons.forEach(({ cell, date, row }) => {
      const starred = !row.locked && isStarred(date, row.id);     // Locked-row cells are never in the star map.
      cell.classList.toggle("is-starred", starred);               // Paints the star gold.
      cell.setAttribute("aria-pressed", String(starred));         // Keeps assistive tech in step with the visuals.
    });

    const percent = perfect > 0 ? Math.round((total / perfect) * 100) : 0; // Guards a chart with no starrable rows.
    progressFill.style.width = `${percent}%`;                     // Grows the gold bar.
    progressCount.textContent = `${total} / ${perfect}`;          // Plain numeric readout beside it.
    praiseLine.textContent = overrideMessage || praiseFor(total, perfect); // Row praise and refusals outrank tiers.

    const isCurrentWeek = dateKey(viewWeekStart) === dateKey(currentWeekStart); // Blocks navigating into the future.
    weekLabel.textContent = isCurrentWeek
      ? `This week · ${weekRangeLabel(viewWeekStart)}`        // Live week is named as well as dated.
      : `Week of ${weekRangeLabel(viewWeekStart)}`;
    weekNext.disabled = isCurrentWeek;                            // There is no chart for a week that has not begun.
    weekToday.disabled = isCurrentWeek;                           // Already home.

    addRowButton.disabled = state.rows.length >= MAX_ROWS;        // The cap is visible rather than a surprise.

    ledgerStamp.hidden = perfect === 0 || total < perfect;        // Orb 07 turns up only once a week is perfect.
    ledgerName.textContent = state.name.trim() || "[your name]";  // Drops the visitor into the accounts column.
    friendNote.hidden = !state.escaped;                           // Orb 09 turns up only for visitors who kept asking.

    renderHistory();                                              // Summary and week list follow the same state.
  }

  function showWeek(weekStart) {
    viewWeekStart = startOfWeek(weekStart);                       // Normalizes whatever date was handed in.
    if (viewWeekStart > currentWeekStart) viewWeekStart = currentWeekStart; // Never opens a future week.

    editingRowId = null;                                          // Changing week closes any open rename form.
    buildGrid();                                                  // Re-lays the seven columns for the new dates.
    refresh();                                                    // Repaints stars, meter, labels, and history.
  }

  /* -- Name field ----------------------------------------------------------- */

  nameField.value = state.name;                                   // Restores the name typed on a previous visit.

  nameField.addEventListener("input", () => {
    state.name = nameField.value.slice(0, 24);                    // Mirrors the maxlength in case of a paste.
    saveState();                                                  // Name persists like everything else.
    ledgerName.textContent = state.name.trim() || "[your name]";  // Keeps the ledger line current while typing.
  });

  /* -- Week navigation ------------------------------------------------------ */

  weekPrev.addEventListener("click", () => showWeek(addDays(viewWeekStart, -DAY_COUNT))); // One week back.
  weekNext.addEventListener("click", () => showWeek(addDays(viewWeekStart, DAY_COUNT)));  // One week forward.
  weekToday.addEventListener("click", () => showWeek(currentWeekStart));                  // Straight home.
  addRowButton.addEventListener("click", addRow);                                          // Appends a blank row.

  /* -- Footer controls ------------------------------------------------------ */

  resetButton.addEventListener("click", () => {
    const keptName = state.name;                                  // A fresh file keeps whoever it belongs to.
    const keptSync = state.sync;                                  // Clearing a linked chart must queue a central replacement rather than unlink it.
    state = blankState();
    state.name = keptName;
    state.sync = keptSync;
    saveState();
    showWeek(currentWeekStart);                                   // Returns to the live week on a wiped file.
    refresh("A fresh chart, all made up and waiting. We will not mention any of that again.");
  });

  shareButton.addEventListener("click", async () => {
    const total = countWeekStars(viewWeekStart);                  // Summary reflects the week on show.
    const lifetime = Object.keys(state.stars).length;             // Plus everything else on file.
    const who = state.name.trim() || "Our girl";                  // Falls back to the palace's preferred phrasing.
    const summary = `${who}, week of ${weekRangeLabel(viewWeekStart)}: `
      + `${total}/${totalStars()} gold stars (${lifetime} on file). `
      + `Stars for "${lockedRow().label.toLowerCase()}": 0. `
      + `Get your own growth chart in LiDOLL QUEST.`;             // The shareable, deliberately damning one-liner.

    try {
      await navigator.clipboard.writeText(summary);               // Modern clipboard path, permission-gated.
      finePrint.textContent = "Copied! Paste your week wherever you like.";
    } catch (error) {
      finePrint.textContent = summary;                            // Clipboard blocked, so show the text to copy by hand.
    }
  });

  /* -- CRT toggle, shared with the main site -------------------------------- */

  function setCrtEnabled(isEnabled, shouldSave = true) {
    document.documentElement.classList.toggle("crt-disabled", !isEnabled); // Switches scanlines and flicker together.
    crtToggle.setAttribute("aria-pressed", String(isEnabled));    // Exposes the state to assistive technology.
    crtToggle.textContent = `CRT FX // ${isEnabled ? "ON" : "OFF"}`; // Unambiguous label for sighted visitors.

    if (shouldSave) {
      try {
        localStorage.setItem(CRT_KEY, isEnabled ? "on" : "off");  // Same key the main page reads, so it carries over.
      } catch (error) {
        // Storage may be unavailable; the toggle still works for this visit.
      }
    }
  }

  if(!document.querySelector("#page-potty-chart")) { // Little Log owns the shared CRT control when the chart is embedded.
  setCrtEnabled(!document.documentElement.classList.contains("crt-disabled"), false); // Syncs with the early check.

  crtToggle.addEventListener("click", () => {
    setCrtEnabled(crtToggle.getAttribute("aria-pressed") !== "true"); // Flips the current accessible state.
  });

  }

  /* -- Start ---------------------------------------------------------------- */

  if (!state.since) state.since = todayKey;                       // Older saves without a start date adopt today.
  state.rows = sanitizeRows(state.rows);                          // Guarantees the locked row exists before first paint.
  saveState(false);                                               // Opens the local file without treating a page load as a new edit.
  showWeek(currentWeekStart);                                     // Builds and paints the live week.

  function replaceChart(next) { // Apply an explicitly selected or clean remote chart and repaint its editable rows.
    const draft=editingRowId?{id:editingRowId,label:grid.querySelector('.row-edit-label')?.value,note:grid.querySelector('.row-edit-note')?.value}:null;
    const focused=document.activeElement?.classList.contains('row-edit-label')?'row-edit-label':document.activeElement?.classList.contains('row-edit-note')?'row-edit-note':null;
    state = next;
    state.rows = sanitizeRows(state.rows);
    nameField.value = state.name;
    editingRowId = draft && state.rows.some(row=>row.id===draft.id)?draft.id:null;
    buildGrid(); refresh(); // Refresh the same week without closing its row editor.
    if(editingRowId) { // Background pulls must preserve an unfinished row editor and its focus.
      grid.querySelector('.row-edit-label').value=draft.label;
      grid.querySelector('.row-edit-note').value=draft.note;
      if(focused) grid.querySelector('.'+focused).focus({preventScroll:true});
    }
  }

  account = window.createGrowthChartAccount({
    get: () => state,
    embedded: Boolean(document.querySelector("#page-potty-chart")),
    blank: () => ({...blankState(),rows:sanitizeRows(cloneDefaultRows())}),
    isBlank: () => state.name.trim() === "" && Object.keys(state.stars).length === 0 && state.refusals === 0 && !state.escaped
      && JSON.stringify(state.rows) === JSON.stringify(sanitizeRows(cloneDefaultRows())), // Only untouched charts may be replaced automatically with the account's saved chart.
    persist: () => saveState(false),
    replace: replaceChart,
    clear: () => replaceChart(blankState()),
    reload() { // Read another tab's saved changes before acknowledging a network request.
      if (storageFailed) throw new Error("Browser saving is paused. Download a backup before reloading this chart.");
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== lastStored) { lastStored = saved; replaceChart(loadState()); }
    },
  });
  account.start();

  function refreshCalendar() { // An installed app may stay open across days; advance its live calendar without deleting history.
    const nextToday = startOfDay(new Date());
    if (dateKey(nextToday) === todayKey) return;
    const wasLive = dateKey(viewWeekStart) === dateKey(currentWeekStart);
    today = nextToday; todayKey = dateKey(today); currentWeekStart = startOfWeek(today);
    showWeek(wasLive ? currentWeekStart : viewWeekStart);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCalendar(); });
  window.addEventListener("little-log-chart-visible", refreshCalendar);
  setInterval(refreshCalendar, 30000);
})();
