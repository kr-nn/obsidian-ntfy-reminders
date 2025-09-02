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
  insert12h: true,
  dismissStatusChars: "x/-",


  senderHostnames: "",
  senderIPsCidrs: ""
};

/*** CONSTANTS (not user-facing) ***/
const RESCAN_INTERVAL_MIN = 10;
const SUGGEST_DAYS = 14;
const SUGGEST_MAX  = 5000;
const SCHEDULE_DEBOUNCE_MS = 2000;
const MAX_TIMEOUT_MS = 0x7fffffff;

module.exports = class NtfyReminders extends Plugin {
  async onload() {

    this.timerHandles = new Map();
    this.fileTimers = new Map();
    this.pendingRescans = new Map();

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

  /** Debounced re-schedule for one file after edits */
  queueReschedule(file) {
    if (!this.isSender) return;
    const key = file.path;
    const prev = this.pendingRescans.get(key);
    if (prev) window.clearTimeout(prev);
    const handle = window.setTimeout(async () => {
      this.pendingRescans.delete(key);
      await this.scheduleFileFresh(file);
    }, SCHEDULE_DEBOUNCE_MS);
    this.pendingRescans.set(key, handle);
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
      for (const f of files) await this.scheduleFileFresh(f);
      new Notice("NTFY: vault scanned");
    } catch (e) {
      console.error("[NTFY Reminders] scanVault error:", e);
    }
  }

  /** Clear all timers for a file, then parse & schedule fresh */
  async scheduleFileFresh(file) {
    try {
      if (!this.isSender) { this.clearTimersForFile(file.path); return; }
      this.clearTimersForFile(file.path);
      await this.scheduleFromFileNoClear(file);
    } catch (e) {
      console.error("[NTFY Reminders] scheduleFileFresh error:", file?.path, e);
    }
  }

  /** INTERNAL: parse/schedule without clearing first (only when sender) */
  async scheduleFromFileNoClear(file) {
    if (!this.isSender) return;
    const text = await this.app.vault.read(file);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];


      const status = getTaskStatusChar(line);
      if (status != null && shouldDismissStatus(status, this.settings.dismissStatusChars)) {
        console.log("[NTFY Reminders] skip (dismiss by task status)", { status, lineIndex: i, file: file.path });
        continue;
      }


      const matches = parseClockEmojiAll(line);
      if (!matches.length) continue;

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
      }
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
    const m = upto.match(/@(\d*)$/);
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
      const key = dt.format(use12h ? "YYYYMMDDhhmm" : "YYYYMMDDHHmm");
      if (digitSubsequence(key, q)) {
        out.push({ label: humanLabel(dt, use12h), insert: formatAt(dt, use12h) });
        if (out.length >= 40) break;
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


      const abs = parseAbsoluteUserInput(q, this.now);
      let items = [];
      if (abs) items.push(abs);


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
    const ins = formatAt(dt, !!this.plugin.settings.insert12h);
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
