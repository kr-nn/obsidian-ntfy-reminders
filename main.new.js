const {
  Plugin, Notice, requestUrl, moment, TFile,
  PluginSettingTab, Setting,
  EditorSuggest, MarkdownView, Modal
} = require("obsidian");
const os = require("os");

/*** DEFAULT SETTINGS ***/
const DEFAULTS = {
  serverUrl: "https://ntfy.sh",
  topic: "tasks",
  authHeader: "",
  title: "NTFY Reminders",
  tags: "",
  iconUrl: "",
  suggestStepMin: 5,
  dismissStatusChars: "x/-",


  senderHostnames: "",
  senderIPsCidrs: ""
};

/*** CONSTANTS (not user-facing) ***/
const RESCAN_INTERVAL_MIN = 10;
const SUGGEST_DAYS = 14;
const SUGGEST_MAX  = 5000;
const SCHEDULE_DEBOUNCE_MS = 3000;
const MAX_TIMEOUT_MS = 0x7fffffff;

module.exports = class NtfyReminders extends Plugin {
  async onload() {

    this.timerHandles = new Map();
    this.fileTimers = new Map();
    this.pendingRescans = new Map();
    this.recentInsert = null; // { time: number, filePath: string, lineIndex: number }
    this.recentInsertTimer = null;

    this.settings = Object.assign({}, DEFAULTS, await this.loadData());


    this.localIdentity = getLocalIdentity();

    this.isSender = computeIsSender(this.settings, this.localIdentity);

    console.log("[NTFY Reminders] onload with settings:", this.settings);
    console.log("[NTFY Reminders] local identity:", this.localIdentity);
    console.log("[NTFY Reminders] role:", this.isSender ? "SENDER" : "SILENT");

    this.addSettingTab(new NtfySettingsTab(this.app, this));


    this.addCommand({
      id: "ntfy-scan-vault-now",
      name: "NTFY: scan vault now",
      callback: () => this.scanVault()
    });
    this.addCommand({
      id: "ntfy-enter-reminder",
      name: "NTFY: enter reminder",
      callback: () => openReminderPicker(this.app, this),
      hotkeys: [{ modifiers: ["Ctrl"], key: "R" }]
    });


    this.registerEditorSuggest(new AtTimeDigitsSuggest(this.app, this));


    await this.scanVault();


    this.registerInterval(window.setInterval(() => this.scanVault(), RESCAN_INTERVAL_MIN * 60 * 1000));


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
    if (this.recentInsertTimer) window.clearTimeout(this.recentInsertTimer);
  }

  async saveSettings() { await this.saveData(this.settings); }

  /** Recompute sender role and act if it changed */
  async recomputeSenderRole() {
    const prev = this.isSender;
    this.localIdentity = getLocalIdentity();
    this.isSender = computeIsSender(this.settings, this.localIdentity);
    console.log("[NTFY Reminders] recompute role:", this.isSender ? "SENDER" : "SILENT", this.localIdentity);
    if (prev && !this.isSender) {

      this.clearAllTimers();
    } else if (!prev && this.isSender) {

      await this.scanVault();
    }
  }

  /** Cancel and forget all timers across all files */
  clearAllTimers() {
    for (const h of this.timerHandles.values()) window.clearTimeout(h);
    this.timerHandles.clear();
    this.fileTimers.clear();
    console.log("[NTFY Reminders] cleared ALL timers (role is SILENT)");
  }

  /** Mark a recent insert and start a timeout to show inactive if not scheduled */
  noteRecentInsert(filePath, lineIndex) {
    this.recentInsert = { time: Date.now(), filePath, lineIndex };
    if (this.recentInsertTimer) window.clearTimeout(this.recentInsertTimer);
    this.recentInsertTimer = window.setTimeout(async () => {
      try {
        const ri = this.recentInsert;
        if (!ri) return;
        const { filePath, lineIndex } = ri;
        const f = this.app.vault.getAbstractFileByPath(filePath);
        if (!(f instanceof TFile)) return;
        const text = await this.app.vault.read(f);
        const lines = text.split(/\r?\n/);
        const line = lines[lineIndex] ?? "";
        const now = moment();
        let active = false;
        const matches = parseClockEmojiAll(line);
        for (const p of matches) {
          let { when, recur } = p;
          if (!when.isValid()) continue;
          let firstWhen = when.clone();
          if (recur) {
            firstWhen = advanceToFuture(firstWhen, recur, now);
            if (!firstWhen || !firstWhen.isValid()) continue;
          }
          if (firstWhen.isAfter(now)) { active = true; break; }
        }
        if (!active) new Notice("Reminder inactive — time needed");
      } catch (e) {
        console.warn("[NTFY Reminders] recentInsert check failed", e);
      } finally {
        this.recentInsert = null;
      }
    }, 32000);
  }

  // Ghost placeholder removed in favor of selected inline placeholder

  /** Debounced re-schedule for one file after edits */
  queueReschedule(file) {
    if (!this.isSender) return;
    const key = file.path;
    const prev = this.pendingRescans.get(key);
    if (prev) window.clearTimeout(prev.handle ?? prev);

    // Capture the currently edited line if this file is active
    let editedLineIndex = undefined;
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.file && view.file.path === file.path) {
        editedLineIndex = view.editor.getCursor().line;
      }
    } catch (_) {}

    const handle = window.setTimeout(async () => {
      this.pendingRescans.delete(key);
      await this.scheduleFileFresh(file, editedLineIndex);
    }, SCHEDULE_DEBOUNCE_MS);
    this.pendingRescans.set(key, { handle, lineIndex: editedLineIndex });
  }

  /** Full vault rescan: if silent, just clear; else clear per-file timers first, then schedule */
  async scanVault() {
    try {
      const files = this.app.vault.getMarkdownFiles();
      console.log("[NTFY Reminders] scanning vault, md files:", files.length, "role:", this.isSender ? "SENDER" : "SILENT");
      if (!this.isSender) {

        this.clearAllTimers();
        new Notice("NTFY: silent (not sender) – no notifications from this device");
        return;
      }
      for (const f of files) await this.scheduleFileFresh(f, undefined);
      new Notice("NTFY: vault scanned");
    } catch (e) {
      console.error("[NTFY Reminders] scanVault error:", e);
    }
  }

  /** Clear all timers for a file, then parse & schedule fresh */
  async scheduleFileFresh(file, editedLineIndex) {
    try {
      if (!this.isSender) { this.clearTimersForFile(file.path); return; }
      this.clearTimersForFile(file.path);
      await this.scheduleFromFileNoClear(file, editedLineIndex);
    } catch (e) {
      console.error("[NTFY Reminders] scheduleFileFresh error:", file?.path, e);
    }
  }

  /** INTERNAL: parse/schedule without clearing first (only when sender) */
  async scheduleFromFileNoClear(file, editedLineIndex) {
    if (!this.isSender) return;
    const text = await this.app.vault.read(file);
    const lines = text.split(/\r?\n/);
    let scheduledEditedLine = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];


      const status = getTaskStatusChar(line);
      if (status != null && shouldDismissStatus(status, this.settings.dismissStatusChars)) {
        console.log("[NTFY Reminders] skip (dismiss by task status)", { status, lineIndex: i, file: file.path });
        continue;
      }


      const matches = parseClockEmojiAll(line);
      if (!matches.length) continue;

      // Clear any previously scheduled timers for this specific line before scheduling new ones
      this.clearTimersForLine(file.path, i);

      const prio = detectPriority(line);
      for (const p of matches) {
        const { when, context, raw, offset, recur } = p;
        if (!when.isValid()) continue;

        let firstWhen = when.clone();
        const now = moment();

        if (recur) {
          firstWhen = advanceToFuture(firstWhen, recur, now);
          if (!firstWhen || !firstWhen.isValid()) continue;
        } else {
          if (!firstWhen.isAfter(now)) {
            console.log("[NTFY Reminders] skip one-shot past ⏰", { raw, at: when.toISOString() });
            continue;
          }
        }

        this.scheduleOneReminder(file.path, i, firstWhen, prio, context || line, offset, recur);
        if (editedLineIndex != null && i === editedLineIndex && firstWhen.isAfter(now)) {
          scheduledEditedLine = true;
        }
      }
    }
    if (editedLineIndex != null && scheduledEditedLine) {
      // Avoid double-toast if this came from a fresh insert flow
      if (!this.recentInsert) new Notice("Reminder set");
    }
  }

  /** Schedule a single reminder occurrence and (optionally) its recurrence chain */
  scheduleOneReminder(filePath, lineIndex, when, prio, context, offset, recur) {
    const id = `${filePath}#${lineIndex}#${when.unix()}#${offset}`;
    if (this.timerHandles.has(id)) return;

    const ms = when.valueOf() - Date.now();
    if (ms <= 0) return;
    if (ms > MAX_TIMEOUT_MS) {

      console.log("[NTFY Reminders] skip scheduling far future (>~24.8d)", {
        filePath, lineIndex, targetISO: when.toISOString(), recur
      });
      return;
    }

    console.log("[NTFY Reminders] SCHEDULE", {
      file: filePath, line: lineIndex, targetISO: when.toISOString(), ms, prio, offset, recur
    });

    const handle = window.setTimeout(async () => {
      try {

        if (!this.isSender) {
          console.log("[NTFY Reminders] SKIP fire (role became SILENT)");
        } else {
          console.log("[NTFY Reminders] FIRING", {
            file: filePath, line: lineIndex, at: new Date().toISOString(), prio, offset, recur
          });
          await this.sendNtfy(context, prio);
        }
      } catch (err) {
        console.error("[NTFY Reminders] fire error:", err);
      } finally {

        this.timerHandles.delete(id);
        const set = this.fileTimers.get(filePath);
        if (set) {
          set.delete(id);
          if (set.size === 0) this.fileTimers.delete(filePath);
        }


        if (recur && this.isSender) {
          const now = moment();
          let next = when.clone().add(recur.every, recur.unit);
          while (!next.isAfter(now)) next.add(recur.every, recur.unit);
          this.scheduleOneReminder(filePath, lineIndex, next, prio, context, offset, recur);
        }
      }
    }, ms);

    this.timerHandles.set(id, handle);
    if (!this.fileTimers.has(filePath)) this.fileTimers.set(filePath, new Set());
    this.fileTimers.get(filePath).add(id);

    try {
      const ri = this.recentInsert;
      if (ri && ri.filePath === filePath && ri.lineIndex === lineIndex && (Date.now() - ri.time) < 30000) {
        new Notice("Reminder set");
        this.recentInsert = null;
      }
    } catch (_) { /* noop */ }
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

  /** Cancel timers only for a specific line within a file */
  clearTimersForLine(filePath, lineIndex) {
    const ids = this.fileTimers.get(filePath);
    if (!ids) return;
    const prefix = `${filePath}#${lineIndex}#`;
    for (const id of Array.from(ids)) {
      if (id.startsWith(prefix)) {
        const h = this.timerHandles.get(id);
        if (h) window.clearTimeout(h);
        this.timerHandles.delete(id);
        ids.delete(id);
      }
    }
    if (ids.size === 0) this.fileTimers.delete(filePath);
  }

  async sendNtfy(text, priority = 3) {
    const s = this.settings;
    const url = `${s.serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(s.topic)}`;
    const headers = {
      "X-Title": s.title || DEFAULTS.title,
      "X-Tags": s.tags || DEFAULTS.tags,
      "X-Priority": String(priority)
    };
    if (s.authHeader && s.authHeader.trim()) headers["Authorization"] = s.authHeader.trim();
    if (s.iconUrl && s.iconUrl.length) {
      headers["X-Icon"] = s.iconUrl;
      headers["Icon"]  = s.iconUrl;
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


    const id = this.plugin.localIdentity;
    const roleDiv = containerEl.createDiv({ cls: "ntfy-role" });
    roleDiv.setText(`This instance is: ${this.plugin.isSender ? "SENDER ✅" : "SILENT 🚫"}  (host: ${id.hostname}; IPs: ${id.ipv4.join(", ") || "none"})`);

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
      .setDesc("Interval for legacy @ time suggestions (1–60 minutes)")
      .addSlider(sl => sl
        .setLimits(1, 60, 1)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.suggestStepMin)
        .onChange(async v => { this.plugin.settings.suggestStepMin = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Dismiss task statuses")
      .setDesc("Chars that suppress reminders on task lines (e.g. x/-). Case-insensitive.")
      .addText(t => t
        .setPlaceholder("x-/")
        .setValue(this.plugin.settings.dismissStatusChars || "")
        .onChange(async v => { this.plugin.settings.dismissStatusChars = v; await this.plugin.saveSettings(); }));


    containerEl.createEl("h4", { text: "Sender (who sends notifications)" });

    new Setting(containerEl)
      .setName("Allowed hostnames")
      .setDesc("Comma-separated exact hostnames. If set, this device must match either host or IP/CIDR to send.")
      .addText(t => t
        .setPlaceholder("obsidian")
        .setValue(this.plugin.settings.senderHostnames || "")
        .onChange(async v => {
          this.plugin.settings.senderHostnames = v.trim();
          await this.plugin.saveSettings();
          await this.plugin.recomputeSenderRole();
          roleDiv.setText(`This instance is: ${this.plugin.isSender ? "SENDER ✅" : "SILENT 🚫"}  (host: ${this.plugin.localIdentity.hostname}; IPs: ${this.plugin.localIdentity.ipv4.join(", ") || "none"})`);
        }));

    new Setting(containerEl)
      .setName("Allowed IPs/CIDRs")
      .setDesc("Comma-separated IPv4 rules, e.g. 10.0.0.1, 10.0.0.1/24, or prefix like 10.0.0.")
      .addText(t => t
        .setPlaceholder("10.0.0.1")
        .setValue(this.plugin.settings.senderIPsCidrs || "")
        .onChange(async v => {
          this.plugin.settings.senderIPsCidrs = v.trim();
          await this.plugin.saveSettings();
          await this.plugin.recomputeSenderRole();
          roleDiv.setText(`This instance is: ${this.plugin.isSender ? "SENDER ✅" : "SILENT 🚫"}  (host: ${this.plugin.localIdentity.hostname}; IPs: ${this.plugin.localIdentity.ipv4.join(", ") || "none"})`);
        }));
  }
}

/** ===== Helpers: sender gating ===== **/

function getLocalIdentity() {
  const hostname = (os.hostname?.() || "").trim();
  const ifaces = os.networkInterfaces?.() || {};
  const ipv4 = [];
  for (const arr of Object.values(ifaces)) {
    for (const ni of arr || []) {
      if (ni && ni.family === "IPv4" && !ni.internal && ni.address) ipv4.push(ni.address);
    }
  }
  return { hostname, ipv4 };
}

function computeIsSender(settings, identity) {
  const hostList = parseList(settings.senderHostnames);
  const ipRules  = parseIPRules(settings.senderIPsCidrs);

  if (hostList.length === 0 && ipRules.length === 0) {

    return true;
  }

  const hn = (identity.hostname || "").toLowerCase();
  const hostMatch = hostList.some(h => h.toLowerCase() === hn);


  let ipMatch = false;
  for (const ip of identity.ipv4) {
    if (ipRules.some(rule => ipMatchesRule(ip, rule))) { ipMatch = true; break; }
  }

  return hostMatch || ipMatch;
}

function parseList(s) {
  if (!s) return [];
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

function parseIPRules(s) {
  const out = [];
  if (!s) return out;
  for (const raw of s.split(",").map(x => x.trim()).filter(Boolean)) {
    if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(raw)) {

      const [ip, bitsStr] = raw.split("/");
      const bits = clampInt(bitsStr, 0, 32);
      const ipInt = ipv4ToInt(ip);
      if (ipInt != null) {
        const mask = bits === 0 ? 0 : (~0 >>> (32 - bits)) << (32 - bits);
        out.push({ kind: "cidr", ipInt, mask, bits });
      }
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) {

      const ipInt = ipv4ToInt(raw);
      if (ipInt != null) out.push({ kind: "exact", ipInt, ip: raw });
    } else if (/^\d+\.\d+\.\d+\.$/.test(raw) || /^\d+\.\d+\.$/.test(raw) || /^\d+\.$/.test(raw)) {

      out.push({ kind: "prefix", prefix: raw });
    } else {

      if (/^\d+\.\d+\.\d+$/.test(raw)) out.push({ kind: "prefix", prefix: raw + "." });
      else if (/^\d+\.\d+$/.test(raw)) out.push({ kind: "prefix", prefix: raw + "." });
      else if (/^\d+$/.test(raw)) out.push({ kind: "prefix", prefix: raw + "." });

    }
  }
  return out;
}

function ipMatchesRule(ip, rule) {
  if (!ip) return false;
  if (rule.kind === "prefix") return ip.startsWith(rule.prefix);
  const int = ipv4ToInt(ip);
  if (int == null) return false;
  if (rule.kind === "exact") return int === rule.ipInt;
  if (rule.kind === "cidr") {
    return (int & rule.mask) === (rule.ipInt & rule.mask);
  }
  return false;
}

function ipv4ToInt(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const a = [+m[1], +m[2], +m[3], +m[4]];
  for (const n of a) if (n < 0 || n > 255) return null;
  return ((a[0] << 24) >>> 0) + (a[1] << 16) + (a[2] << 8) + a[4 - 1];
}

/** ===== Helpers: tasks status & parsing ===== **/


function getTaskStatusChar(line) {
  const m = line.match(/^\s*[-*]\s*\[([^\]])\]/);
  if (!m) return null;
  return m[1];
}


function shouldDismissStatus(statusChar, dismissCharsSetting) {
  if (!dismissCharsSetting) return false;
  const set = new Set(dismissCharsSetting.toLowerCase().split(""));
  return set.has(statusChar.toLowerCase());
}


function parseClockEmojiAll(line) {
  const tsRe = /⏰\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/ig;
  const all = [...line.matchAll(tsRe)];
  const out = [];
  for (let k = 0; k < all.length; k++) {
    const m = all[k];
    const start = m.index;
    const raw = m[0];
    const end = start + raw.length;
    const nextStart = (all[k + 1]?.index ?? line.length);


    const dateStr = m[1];
    let hh = parseInt(m[2], 10);
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    const ap = m[4] ? m[4].toLowerCase() : null;
    if (ap) { if (ap === "pm" && hh < 12) hh += 12; if (ap === "am" && hh === 12) hh = 0; }
    if (hh > 23 || mm > 59) continue;

    const when = moment(`${dateStr} ${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`, "YYYY-MM-DD HH:mm", true);
    if (!when.isValid()) continue;


    const tail = line.slice(end, nextStart);
    const rm = tail.match(/^\s*every\s+(\d+)\s*(minutes?|minute|min|m|hours?|hour|hr|h|days?|day|d|weeks?|week|w)\b/i);
    let recur = null;
    let end2 = end;
    if (rm) {
      const every = Math.max(1, parseInt(rm[1], 10) || 0);
      const unitTok = rm[2].toLowerCase();
      const unit = normalizeUnit(unitTok);
      if (every > 0 && unit) {
        recur = { every, unit };
        end2 = end + rm[0].length;
      }
    }


    const before = line.slice(0, start).trim();
    const after  = line.slice(end2).trim();
    const context = (before + (before && after ? " " : "") + after).trim();

    out.push({ when, context, raw, offset: start, recur });
  }
  return out;
}

function normalizeUnit(tok) {
  if (/(^m(in(ute)?s?)?$)|^mins?$|^m$/.test(tok)) return "minutes";
  if (/^h(ours?)?$|^hrs?$|^h$/.test(tok)) return "hours";
  if (/^d(ays?)?$|^d$/.test(tok)) return "days";
  if (/^w(eeks?)?$|^w$/.test(tok)) return "weeks";
  return null;
}


function advanceToFuture(when, recur, now) {
  const { every, unit } = recur;
  if (!every || !unit) return null;
  let next = when.clone();
  if (!next.isAfter(now)) {
    const diff = now.diff(next, unit);
    if (diff >= 0) {
      const steps = Math.floor(diff / every) + 1;
      next.add(steps * every, unit);
    }
  }
  return next;
}


function detectPriority(line) {
  if (line.includes("🔺")) return 5;
  if (line.includes("⏫")) return 4;
  if (line.includes("🔼")) return 3;
  if (line.includes("🔽")) return 2;
  if (line.includes("⏬")) return 1;
  return 3;
}


function formatDateInsert(m) {
  return `⏰ ${m.format("YYYY-MM-DD")} `;
}

function humanDateLabel(dt) {
  return `${dt.format("ddd YYYY-MM-DD")}  (${dt.fromNow()})`;
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
  pushFut(nextWeekday(base, 1, true).hour(9).minute(0));
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
    if (out.length > SUGGEST_MAX) break;
  }
  return out;
}

function digitSubsequence(hay, needle) {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

/** ===== Natural language dates (date-only) ===== **/
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};

const DOW = {
  sun: 7, sunday: 7,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function parseNaturalDateOrAbsolute(s, base) {
  if (!s) return null;
  const q = s.trim().toLowerCase();
  if (!q) return null;

  // Absolute YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    const dt = moment(q, "YYYY-MM-DD", true);
    return dt.isValid() ? dt : null;
  }

  // today / tomorrow / yesterday
  if (q === "today") return base.clone();
  if (q === "tomorrow") return base.clone().add(1, "day");
  if (q === "yesterday") return base.clone().subtract(1, "day");

  // next <weekday> or just <weekday>
  const dowMatch = q.match(/^(next\s+)?(sun(day)?|mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?)$/);
  if (dowMatch) {
    const forceNext = !!dowMatch[1];
    const tok = dowMatch[2];
    const iso = DOW[tok.startsWith("thu") ? "thu" : tok.substring(0,3)];
    return nextWeekday(base.clone().startOf("day"), iso, forceNext);
  }

  // in <n> <unit> | <n> <unit> | <word> <unit>
  const rel = q.match(/^(?:in\s+)?(\d+|[a-z-]+)\s*(days?|d|weeks?|w|months?|mo|mons?|mon(th)?s?)$/);
  if (rel) {
    const nTok = rel[1];
    const unitTok = rel[2];
    let n = parseInt(nTok, 10);
    if (Number.isNaN(n)) n = NUM_WORDS[nTok.replace(/-/g, "")] || null;
    if (n != null && n >= 0) {
      let unit = null;
      if (/^d(ays?)?$/.test(unitTok)) unit = "days";
      else if (/^w(eeks?)?$|^w$/.test(unitTok)) unit = "weeks";
      else if (/^mo(n(th)?s?)?$/.test(unitTok)) unit = "months";
      if (unit) return base.clone().add(n, unit);
    }
  }

  return null;
}

function datePresets(now) {
  const list = [];
  const base = now.clone().startOf("day");
  list.push(base.clone()); // today
  list.push(base.clone().add(1, "day")); // tomorrow
  list.push(nextWeekday(base, 1, true)); // next Monday
  list.push(nextWeekday(base, 5, true)); // next Friday
  list.push(base.clone().add(1, "week"));
  list.push(base.clone().add(2, "weeks"));
  return list;
}

function clampInt(n, lo, hi) {
  const x = parseInt(n, 10);
  if (Number.isNaN(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function safePosToOffset(editor, pos) {
  try { if (typeof editor.posToOffset === 'function') return editor.posToOffset(pos); } catch (_) {}
  const lines = editor.lineCount ? editor.lineCount() : (editor.lastLine ? editor.lastLine() + 1 : 0);
  let off = 0;
  const maxLine = Math.min(pos.line, lines - 1);
  for (let i = 0; i < maxLine; i++) {
    const s = editor.getLine(i) || "";
    off += s.length + 1; // assume \n
  }
  off += pos.ch;
  return off;
}

// Ghost typing helpers
// Editor decorations removed; using selected inline placeholder instead

/** ===== Digit-fuzzy @time suggest (inserts ⏰ …) ===== **/
class AtTimeDigitsSuggest extends EditorSuggest {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  onTrigger(cursor, editor) {
    const line = editor.getLine(cursor.line);
    const upto = line.slice(0, cursor.ch);
    const m = upto.match(/@([^@]*)$/);
    if (!m) return null;
    const start = cursor.ch - m[0].length;
    const end = cursor.ch;
    const digits = m[1] || "";
    return {
      start: { line: cursor.line, ch: start },
      end:   { line: cursor.line, ch: end },
      query: digits
    };
  }

  getSuggestions(ctx) {
    const now = moment();
    const q = ctx.query.trim();

    if (q === "") {
      return datePresets(now).map(dt => ({
        label: humanDateLabel(dt),
        insert: formatDateInsert(dt)
      }));
    }

    const dt = parseNaturalDateOrAbsolute(q, now);
    if (dt) {
      return [{ label: humanDateLabel(dt), insert: formatDateInsert(dt) }];
    }

    return datePresets(now).map(dt => ({ label: humanDateLabel(dt), insert: formatDateInsert(dt) }));
  }

  renderSuggestion(s, el) { el.setText(s.label); }

  selectSuggestion(s) {
    if (!s.insert) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const ctx = this.context; if (!ctx) return;
    const base = s.insert + "hh:mm AM";
    editor.replaceRange(base, ctx.start, ctx.end);
    const selStart = { line: ctx.start.line, ch: ctx.start.ch + s.insert.length };
    const selEnd   = { line: ctx.start.line, ch: ctx.start.ch + base.length };
    editor.setSelection(selStart, selEnd);
    try {
      const file = view.file;
      if (file) this.plugin.noteRecentInsert(file.path, ctx.start.line);
    } catch (_) {}
    new Notice("Entering reminder — time needed");
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
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Insert reminder time" });

    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = "Natural date (e.g. tomorrow, two weeks, 2025-08-12). Type time after.";
    input.classList.add("ntfy-time-input");

    const list = contentEl.createDiv();
    list.style.marginTop = "10px";
    list.classList.add("ntfy-picker-list");

    const chips = contentEl.createDiv();
    chips.style.marginTop = "8px";
    for (const c of [
      { label: "today", dt: this.now.clone() },
      { label: "tomorrow", dt: this.now.clone().add(1, "day") },
      { label: "next Monday", dt: nextWeekday(this.now.clone().startOf("day"), 1, true) },
      { label: "in 2 weeks", dt: this.now.clone().add(2, "weeks") },
    ]) {
      const b = chips.createEl("button", { text: c.label });
      b.style.marginRight = "6px";
      b.addEventListener("click", () => this.insertAndClose(c.dt));
    }

    let itemsState = [];
    let active = 0;

    const render = () => {
      const q = input.value.trim();
      let items = [];
      const parsed = parseNaturalDateOrAbsolute(q, this.now);
      if (parsed) items.push(parsed);
      if (items.length === 0) items = datePresets(this.now);
      itemsState = items;

      list.empty();
      if (items.length === 0) {
        list.setText("No matches (type a natural date like 'two weeks').");
      } else {
        active = Math.min(active, items.length - 1);
        items.slice(0, 40).forEach((dt, idx) => {
          const row = list.createDiv();
          row.classList.add("ntfy-row");
          row.style.padding = "6px 8px";
          row.style.cursor = "pointer";
          row.setText(`${humanDateLabel(dt)} → ${formatDateInsert(dt)}`);
          if (idx === active) {
            row.classList.add("active");
            row.style.background = "var(--background-modifier-hover)";
          }
          row.addEventListener("click", () => this.insertAndClose(dt));
          row.addEventListener("mouseenter", () => {
            active = idx; render();
          });
        });
      }
    };

    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const q = input.value.trim();
        const parsed = parseNaturalDateOrAbsolute(q, this.now);
        if (parsed) { this.insertAndClose(parsed); return; }
        const pick = itemsState[active] || itemsState[0];
        if (pick) this.insertAndClose(pick);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        active = Math.min(active + 1, itemsState.length - 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        active = Math.max(active - 1, 0);
        render();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });

    setTimeout(() => { input.focus(); render(); }, 0);
  }

  insertAndClose(dt) {
    const editor = this.view.editor;
    if (!editor) { this.close(); return; }
    const ins = formatDateInsert(dt);
    const cur = editor.getCursor();
    const line = editor.getLine(cur.line);
    const needsSpace = cur.ch > 0 && !/\s$/.test(line.slice(0, cur.ch));
    const base = (needsSpace ? " " : "") + ins + "hh:mm AM";
    editor.replaceRange(base, cur);
    const selStart = { line: cur.line, ch: cur.ch + (needsSpace ? 1 : 0) + ins.length };
    const selEnd   = { line: cur.line, ch: cur.ch + base.length };
    editor.setSelection(selStart, selEnd);
    try {
      const file = this.view.file;
      if (file) this.plugin.noteRecentInsert(file.path, cur.line);
    } catch (_) {}
    new Notice("Entering reminder — time needed");
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
