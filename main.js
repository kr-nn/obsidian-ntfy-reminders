const {
  Plugin, Notice, requestUrl, moment, TFile,
  PluginSettingTab, Setting,
  EditorSuggest, MarkdownView, Modal
} = require("obsidian");

/*** DEFAULT SETTINGS ***/
const DEFAULTS = {
  serverUrl: "https://ntfy.sh/app",
  topic: "tasks",
  authHeader: "",                 // e.g. "Bearer XXX"
  title: "NTFY Reminders",
  tags: "",
  iconUrl: "",                    // optional: icon URL for notifications
  suggestStepMin: 5,              // minutes between @ suggestions (1–60)
  insert12h: true                 // picker inserts 12-hour times if true; 24h if false
};

/*** CONSTANTS (not user-facing) ***/
const RESCAN_INTERVAL_MIN = 10;
const SUGGEST_DAYS = 14;           // how far ahead @ suggestions scan
const SUGGEST_MAX  = 5000;         // soft cap for candidate grid
const SCHEDULE_DEBOUNCE_MS = 2000; // debounce after edits to avoid ghost timers

module.exports = class NtfyReminders extends Plugin {
  async onload() {
    // timer bookkeeping
    this.timerHandles = new Map();   // id -> setTimeout handle
    this.fileTimers = new Map();     // filePath -> Set(timerIds)
    this.pendingRescans = new Map(); // filePath -> debounce handle

    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    console.log("[NTFY Reminders] onload with settings:", this.settings);

    this.addSettingTab(new NtfySettingsTab(this.app, this));

    // Commands
    this.addCommand({
      id: "ntfy-scan-vault-now",
      name: "NTFY: scan vault now",
      callback: () => this.scanVault()
    });
    this.addCommand({
      id: "ntfy-enter-reminder",
      name: "NTFY: enter reminder",
      callback: () => openReminderPicker(this.app, this),
      hotkeys: [{ modifiers: ["Ctrl"], key: "R" }] // default hotkey
    });

    // Editor suggest: digit-fuzzy @time picker (inserts ⏰ …)
    this.registerEditorSuggest(new AtTimeDigitsSuggest(this.app, this));

    // Initial full rescan (clears + schedules)
    await this.scanVault();

    // Periodic rescan (clears + schedules cleanly)
    this.registerInterval(window.setInterval(() => this.scanVault(), RESCAN_INTERVAL_MIN * 60 * 1000));

    // Debounced rescan on modify
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "md") this.queueReschedule(f);
    }));
  }

  onunload() {
    console.log("[NTFY Reminders] onunload, clearing", this.timerHandles.size, "timers");
    for (const h of this.timerHandles.values()) window.clearTimeout(h);
    this.timerHandles.clear();
    for (const h of this.pendingRescans.values()) window.clearTimeout(h);
    this.pendingRescans.clear();
    this.fileTimers.clear();
  }

  async saveSettings() { await this.saveData(this.settings); }

  /** Debounced re-schedule for one file after edits */
  queueReschedule(file) {
    const key = file.path;
    const prev = this.pendingRescans.get(key);
    if (prev) window.clearTimeout(prev);
    const handle = window.setTimeout(async () => {
      this.pendingRescans.delete(key);
      await this.scheduleFileFresh(file);
    }, SCHEDULE_DEBOUNCE_MS);
    this.pendingRescans.set(key, handle);
  }

  /** Clear all timers for a file, then parse & schedule fresh */
  async scheduleFileFresh(file) {
    try {
      this.clearTimersForFile(file.path);
      await this.scheduleFromFileNoClear(file);
    } catch (e) {
      console.error("[NTFY Reminders] scheduleFileFresh error:", file?.path, e);
    }
  }

  /** Full vault rescan: clear per-file timers first, then schedule */
  async scanVault() {
    try {
      const files = this.app.vault.getMarkdownFiles();
      console.log("[NTFY Reminders] scanning vault, md files:", files.length);
      for (const f of files) await this.scheduleFileFresh(f);
      new Notice("NTFY: vault scanned");
    } catch (e) {
      console.error("[NTFY Reminders] scanVault error:", e);
    }
  }

  /** INTERNAL: parse/schedule without clearing first */
  async scheduleFromFileNoClear(file) {
    const text = await this.app.vault.read(file);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Only schedule when there is a ⏰ YYYY-MM-DD ...
      const parsed = parseClockEmoji(line);
      if (!parsed) continue;

      const { when, context, raw } = parsed;
      if (!when.isValid() || when.isBefore(moment())) {
        console.log("[NTFY Reminders] skip ⏰ (invalid or past)", { raw, targetISO: when.toISOString?.() });
        continue;
      }

      const prio = detectPriority(line); // 1..5 (ntfy)
      const id = `${file.path}#${i}#${when.unix()}`;
      if (this.timerHandles.has(id)) continue;

      const ms = when.valueOf() - Date.now();
      console.log("[NTFY Reminders] SCHEDULE", {
        file: file.path, line: i, targetISO: when.toISOString(), ms, prio, textSample: context.slice(0, 80)
      });

      if (ms <= 0 || ms > 0x7fffffff) continue;

      const handle = window.setTimeout(async () => {
        try {
          console.log("[NTFY Reminders] FIRING", { file: file.path, line: i, at: new Date().toISOString(), prio });
          await this.sendNtfy(context || line, prio);
        } catch (err) {
          console.error("[NTFY Reminders] fire error:", err);
        } finally {
          // remove this timer id from bookkeeping
          this.timerHandles.delete(id);
          const set = this.fileTimers.get(file.path);
          if (set) {
            set.delete(id);
            if (set.size === 0) this.fileTimers.delete(file.path);
          }
        }
      }, ms);

      // track handle + file mapping
      this.timerHandles.set(id, handle);
      if (!this.fileTimers.has(file.path)) this.fileTimers.set(file.path, new Set());
      this.fileTimers.get(file.path).add(id);
    }
  }

  /** Cancel and forget all timers tied to this file */
  clearTimersForFile(filePath) {
    const ids = this.fileTimers.get(filePath);
    if (!ids) return;
    for (const id of ids) {
      const h = this.timerHandles.get(id);
      if (h) window.clearTimeout(h);
      this.timerHandles.delete(id);
    }
    this.fileTimers.delete(filePath);
    console.log("[NTFY Reminders] cleared timers for file:", filePath);
  }

  async sendNtfy(text, priority = 3) {
    const s = this.settings;
    const url = `${s.serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(s.topic)}`;
    const headers = {
      "X-Title": s.title || DEFAULTS.title,
      "X-Tags": s.tags || DEFAULTS.tags,
      "X-Priority": String(priority)        // 1=min, 2=low, 3=default, 4=high, 5=max
    };
    if (s.authHeader && s.authHeader.trim()) headers["Authorization"] = s.authHeader.trim();
    if (s.iconUrl && s.iconUrl.length) {
      headers["X-Icon"] = s.iconUrl;       // primary
      headers["Icon"]  = s.iconUrl;        // alias
    }

    console.log("[NTFY Reminders] POST", {
      url, title: headers["X-Title"], tags: headers["X-Tags"], priority, icon: s.iconUrl || "(none)"
    });

    try {
      const res = await requestUrl({ url, method: "POST", headers, body: String(text).trim() });
      console.log("[NTFY Reminders] ntfy response", { status: res.status, text: (res.text || "").slice(0, 200) });
      if (res.status < 200 || res.status >= 300) new Notice(`ntfy HTTP ${res.status}`);
    } catch (e) {
      console.error("[NTFY Reminders] ntfy post failed:", e);
      new Notice("ntfy post failed (see console)");
    }
  }
};

/** ===== Settings Tab ===== **/
class NtfySettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "NTFY Reminders" });

    new Setting(containerEl).setName("Server URL").setDesc("e.g. https://ntfy.example.com")
      .addText(t => t.setValue(this.plugin.settings.serverUrl)
        .onChange(async v => { this.plugin.settings.serverUrl = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Topic").setDesc("ntfy topic name")
      .addText(t => t.setValue(this.plugin.settings.topic)
        .onChange(async v => { this.plugin.settings.topic = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Authorization header").setDesc('Optional, e.g. "Bearer XXXXX"')
      .addText(t => t.setPlaceholder("Bearer …")
        .setValue(this.plugin.settings.authHeader)
        .onChange(async v => { this.plugin.settings.authHeader = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Notification title")
      .addText(t => t.setValue(this.plugin.settings.title)
        .onChange(async v => { this.plugin.settings.title = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Tags").setDesc("Comma-separated (optional)")
      .addText(t => t.setValue(this.plugin.settings.tags)
        .onChange(async v => { this.plugin.settings.tags = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Icon URL")
      .setDesc("Optional: PNG/JPG URL shown in notifications")
      .addText(t => t
        .setPlaceholder("https://example.com/icon.png")
        .setValue(this.plugin.settings.iconUrl || "")
        .onChange(async v => { this.plugin.settings.iconUrl = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Fuzzy @ step (minutes)")
      .setDesc("Interval for @ time suggestions (1–60 minutes)")
      .addSlider(sl => sl
        .setLimits(1, 60, 1)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.suggestStepMin)
        .onChange(async v => { this.plugin.settings.suggestStepMin = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Picker inserts 12-hour times")
      .setDesc("If off, inserts 24-hour times like 17:00")
      .addToggle(tg => tg
        .setValue(!!this.plugin.settings.insert12h)
        .onChange(async v => { this.plugin.settings.insert12h = v; await this.plugin.saveSettings(); }));
  }
}

/** ===== Helpers ===== **/

// Parse: "… ⏰ YYYY-MM-DD HH:mm"  or  "… ⏰ YYYY-MM-DD h:mm AM/PM"
function parseClockEmoji(line) {
  const re = /⏰\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/i;
  const m = re.exec(line);
  if (!m) return null;

  const dateStr = m[1];
  let hh = parseInt(m[2], 10);
  const mm = m[3] ? parseInt(m[3], 10) : 0;
  const ap = m[4] ? m[4].toLowerCase() : null;

  if (ap) {                       // 12h → 24h
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
  }
  if (hh > 23 || mm > 59) return null;

  const when = moment(`${dateStr} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, "YYYY-MM-DD HH:mm", true);
  if (!when.isValid()) return null;

  // Context = the line with the ⏰ timestamp removed
  const start = m.index;
  const end = m.index + m[0].length;
  const before = line.slice(0, start).trim();
  const after = line.slice(end).trim();
  const context = (before + (before && after ? " " : "") + after).trim();

  console.log("[NTFY Reminders] ⏰ parsed:", { raw: m[0], date: dateStr, hh24: hh, mm, context });
  return { when, context, raw: m[0] };
}

// Emoji → ntfy priority 1..5
function detectPriority(line) {
  if (line.includes("🔺")) return 5;        // highest
  if (line.includes("⏫")) return 4;        // high
  if (line.includes("🔼")) return 3;
  if (line.includes("🔽")) return 2;        // low
  if (line.includes("⏬")) return 1;        // lowest
  return 3;
}

// Output formatter for insertion (respects 12/24 setting)
function formatAt(m, insert12h) {
  if (insert12h) {
    const h = m.hour();
    const ap = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : (h % 12);
    const mins = String(m.minute()).padStart(2, "0");
    return `⏰ ${m.format("YYYY-MM-DD")} ${h12}:${mins} ${ap}`;
  }
  return `⏰ ${m.format("YYYY-MM-DD HH:mm")}`;
}

// Human-readable suggestion label (respects 12/24 setting)
function humanLabel(dt, insert12h) {
  const left = insert12h
    ? dt.format("ddd YYYY-MM-DD h:mm A")
    : dt.format("ddd YYYY-MM-DD HH:mm");
  return `${left}  (${dt.fromNow()})`;
}

function smartPresets(now) {
  const list = [];
  const base = now.clone().second(0).millisecond(0);
  const pushFut = (dt) => { if (dt.isAfter(now)) list.push(dt); };
  pushFut(base.clone().add(30, "minutes"));
  pushFut(base.clone().add(1, "hour"));
  pushFut(todayAt(base, 17, 0));
  pushFut(todayAt(base, 21, 0));
  pushFut(base.clone().add(1, "day").hour(9).minute(0));
  pushFut(nextWeekday(base, 1, true).hour(9).minute(0)); // next Monday 09:00
  return list.slice(0, 8);
}

function todayAt(base, hh, mm) {
  const dt = base.clone().hour(hh).minute(mm).second(0).millisecond(0);
  return dt.isBefore(base) ? dt.add(1, "day") : dt;
}

function nextWeekday(base, isoWd, forceNext) {
  let dt = base.clone().second(0).millisecond(0);
  const todayIso = base.isoWeekday();
  let delta = isoWd - todayIso;
  if (delta < 0 || forceNext || delta === 0) delta += 7;
  return dt.add(delta, "days");
}

function gridCandidates(now, days, stepMinutes) {
  const out = [];
  let dt = now.clone().second(0).millisecond(0);
  const mod = (dt.minute() % stepMinutes);
  if (mod !== 0) dt.add(stepMinutes - mod, "minutes");
  const end = now.clone().add(days, "days");
  while (dt.isSameOrBefore(end)) {
    out.push(dt.clone());
    dt.add(stepMinutes, "minutes");
    if (out.length > SUGGEST_MAX) break;  // soft cap
  }
  return out;
}

function digitSubsequence(hay, needle) {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

function clampInt(n, lo, hi) {
  const x = parseInt(n, 10);
  if (Number.isNaN(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** ===== Digit-fuzzy @time suggest (inserts ⏰ …) ===== **/
class AtTimeDigitsSuggest extends EditorSuggest {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  onTrigger(cursor, editor) {
    const line = editor.getLine(cursor.line);
    const upto = line.slice(0, cursor.ch);
    // Match "@" followed by zero or more digits at the end
    const m = upto.match(/@(\d*)$/);
    if (!m) return null;
    const start = cursor.ch - m[0].length;
    const end = cursor.ch;
    const digits = m[1] || "";
    return { start: { line: cursor.line, ch: start }, end: { line: cursor.line, ch: end }, query: digits };
  }

  getSuggestions(ctx) {
    const now = moment();
    const q = ctx.query.trim();
    const step = clampInt(this.plugin.settings.suggestStepMin ?? 5, 1, 60);
    const use12h = !!this.plugin.settings.insert12h;

    if (q === "") {
      return smartPresets(now).map(dt => ({
        label: humanLabel(dt, use12h),
        insert: formatAt(dt, use12h)
      }));
    }

    const candidates = gridCandidates(now, SUGGEST_DAYS, step);
    const out = [];
    for (const dt of candidates) {
      const key = dt.format(use12h ? "YYYYMMDDhhmm" : "YYYYMMDDHHmm"); // match respects 12/24
      if (digitSubsequence(key, q)) {
        out.push({ label: humanLabel(dt, use12h), insert: formatAt(dt, use12h) });
        if (out.length >= 40) break; // show up to 40
      }
    }
    return out.length ? out : [{ label: "No matches (keep typing digits…)", insert: null }];
  }

  renderSuggestion(s, el) { el.setText(s.label); }

  selectSuggestion(s) {
    if (!s.insert) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const ctx = this.context; if (!ctx) return;
    editor.replaceRange(s.insert, ctx.start, ctx.end);
    editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + s.insert.length });
  }
}

/** ===== Hotkey-invoked Reminder Picker (modal) ===== **/
function openReminderPicker(app, plugin) {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) { new Notice("Open a Markdown note to insert a reminder"); return; }
  new ReminderPickerModal(app, plugin, view).open();
}

class ReminderPickerModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.now = moment();
    this.step = clampInt(plugin.settings.suggestStepMin ?? 5, 1, 60);
    this.candidates = gridCandidates(this.now, SUGGEST_DAYS, this.step);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Insert reminder time" });

    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = "Digits (e.g. 930) or absolute: 2025-08-12 9:30 pm";
    input.classList.add("ntfy-time-input");

    const list = contentEl.createDiv();
    list.style.marginTop = "10px";

    const chips = contentEl.createDiv();
    chips.style.marginTop = "8px";
    for (const c of [
      { label: "in 30m", dt: this.now.clone().add(30, "minutes") },
      { label: "in 1h",  dt: this.now.clone().add(1, "hour") },
      { label: "today 17:00", dt: todayAt(this.now, 17, 0) },
      { label: "tomorrow 09:00", dt: this.now.clone().add(1,"day").hour(9).minute(0).second(0).millisecond(0) },
    ]) {
      const b = chips.createEl("button", { text: c.label });
      b.style.marginRight = "6px";
      b.addEventListener("click", () => this.insertAndClose(c.dt));
    }

    const render = () => {
      const q = input.value.trim();
      const use12h = !!this.plugin.settings.insert12h;

      // Absolute typed?
      const abs = parseAbsoluteUserInput(q, this.now);
      let items = [];
      if (abs) items.push(abs);

      // Digit fuzzy over candidate grid
      const needle = (q.match(/\d+/)?.[0] ?? "");
      if (needle.length === 0) {
        items = items.concat(smartPresets(this.now));
      } else {
        for (const dt of this.candidates) {
          const key = dt.format(use12h ? "YYYYMMDDhhmm" : "YYYYMMDDHHmm");
          if (digitSubsequence(key, needle)) {
            items.push(dt);
            if (items.length >= 40) break;
          }
        }
      }

      list.empty();
      if (items.length === 0) {
        list.setText("No matches (type digits like 930 or an absolute date/time).");
      } else {
        for (const dt of items.slice(0, 40)) {
          const row = list.createDiv();
          row.classList.add("ntfy-row");
          row.style.padding = "6px 8px";
          row.style.cursor = "pointer";
          row.setText(`${humanLabel(dt, use12h)} → ${formatAt(dt, use12h)}`);
          row.addEventListener("click", () => this.insertAndClose(dt));
        }
      }
    };

    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const q = input.value.trim();
        const abs = parseAbsoluteUserInput(q, this.now);
        if (abs) { this.insertAndClose(abs); return; }
        // First fuzzy or first preset
        let first = smartPresets(this.now)[0];
        if (!first) first = this.candidates[0];
        this.insertAndClose(first);
      } else if (e.key === "Escape") {
        this.close();
      }
    });

    setTimeout(() => { input.focus(); render(); }, 0);
  }

  insertAndClose(dt) {
    const editor = this.view.editor;
    if (!editor) { this.close(); return; }
    const ins = formatAt(dt, !!this.plugin.settings.insert12h);  // ⏰ YYYY-MM-DD ...
    const cur = editor.getCursor();
    const line = editor.getLine(cur.line);
    const needsSpace = cur.ch > 0 && !/\s$/.test(line.slice(0, cur.ch));
    editor.replaceRange((needsSpace ? " " : "") + ins, cur);
    editor.setCursor({ line: cur.line, ch: cur.ch + ins.length + (needsSpace ? 1 : 0) });
    this.close();
  }

  onClose() { this.contentEl.empty(); }
}

/** Accepts "YYYY-MM-DD HH[:MM][ am/pm]" and returns a moment or null */
function parseAbsoluteUserInput(s, base) {
  if (!s) return null;
  let m = s.match(/^\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
  if (!m) return null;
  const [_, d, hhStr, mmStr, ap] = m;
  let hh = clampInt(parseInt(hhStr, 10), 0, 23);
  let mm = clampInt(mmStr ? parseInt(mmStr, 10) : 0, 0, 59);
  if (ap) {
    const low = ap.toLowerCase();
    if (low === "pm" && hh < 12) hh += 12;
    if (low === "am" && hh === 12) hh = 0;
  }
  const dt = moment(d, "YYYY-MM-DD", true);
  if (!dt.isValid()) return null;
  return dt.hour(hh).minute(mm).second(0).millisecond(0);
}
