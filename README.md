# NTFY Reminders (totally vibecoded)

I do **not** know JavaScript. I do **not** know how Obsidian plugins work. This plugin is held together with vibes, logs, and a stubborn need to get reminders out of my notes and into my phone via **ntfy**. Use at your own delight/risk 😄

bonus: included a non-vibecoded nixos module to make obsidian run in a webbrowser
---

## How to use

### 1) Install (manual)

1. Create a folder in your vault: `.obsidian/plugins/ntfy-reminders/`
2. Drop `manifest.json` and `main.js` in there (the ones you’re running now).
3. In Obsidian → **Settings → Community plugins → Installed plugins**, enable **NTFY Reminders**.
4. Open **Settings → NTFY Reminders** and fill in your ntfy server/topic (and optional auth).

### 2) Insert a reminder time

You can put reminders anywhere in your Markdown. The plugin looks for **clock stamps** you insert like this:

```
⏰ 2025-09-01 9:00 AM
```

* Minutes are optional while typing (we’ll still parse `HH:mm`).
* You can add recurrence by appending: `every 2 hours`, `every 1 days`, `every 3 weeks`, etc.

Examples:

```
Pay rent ⏰ 2025-09-01 9:00 AM
Drink water ⏰ 2025-08-16 14:00 every 2 hours
```

### 3) Fast entry with `@` or a hotkey

* Type `@` to open a **natural date suggest**.

  * Type phrases like `two weeks`, `tomorrow`, `next monday`, or an absolute date like `2025-08-12`.
* The picker inserts the date plus a selected placeholder `hh:mm AM`: `⏰ YYYY-MM-DD hh:mm AM` — type to replace it; you can use 12h or 24h.
* Press **Ctrl+R** (default) anywhere to open a small picker modal with the same natural-date suggestions.

### 4) Tasks lines (optional)

For lines like:

```
- [ ] Call the bank ⏰ 2025-08-20 11:15 AM
```

* If you later change the **Tasks** status to certain characters (defaults: `x` done, `/` in-progress, `-` cancelled), the plugin will **suppress** reminders from that line. You can customize which status chars dismiss reminders in settings.

### 5) Only one machine sends (optional)

If you have multiple Obsidian instances on the same vault, you can choose which machine actually sends notifications:

* Set **Allowed hostnames** and/or **Allowed IPs/CIDRs** in settings.
* Only a matching machine will schedule and send. Others go “silent”.
* A status banner in settings shows what this device thinks it is: **SENDER** or **SILENT**, plus detected host/IPs.

---

## Features

* **Simple, explicit reminder stamps**
  Reminders are defined by `⏰ YYYY-MM-DD HH:mm [AM/PM]` anywhere in the line. This avoids fighting the Tasks plugin’s own date parser and keeps things predictable.

* **Recurrence**
  Add `every N minutes|hours|days|weeks` right after a clock stamp to repeat it. Example:
  `⏰ 2025-08-16 09:00 every 2 hours`

* **Multi-reminder per line**
  You can put multiple `⏰ …` stamps on the same line; each is scheduled separately.

* **Priority mapping (emoji → ntfy)**
  If the line includes these, we set ntfy priority:

  * 🔺 → 5 (highest)
  * ⏫ → 4 (high)
  * 🔼 → 3
  * 🔽 → 2 (low)
  * ⏬ → 1 (lowest)
    Default is 3.

* **ntfy integration**
  Sends to your ntfy server/topic with optional **Authorization** header, custom **Title**, **Tags**, and an **Icon URL** (so notifications show a custom image).

* **Natural-date `@` suggest**
  Type phrases like `two weeks`, `tomorrow`, or `next monday`, and it will insert `⏰ YYYY-MM-DD ` so you can add the time you prefer.

* **Hotkey**
  Default **Ctrl+R** opens the reminder picker modal anywhere.

* **Sender gating (host/IP/CIDR)**
  Only the chosen machine schedules/sends so you won’t get duplicate notifications with multiple Obsidian instances on the same vault.

---

## Settings (and why they exist)

**NTFY**

* **Server URL**
  Your ntfy endpoint (e.g., `https://ntfy.example.com`).
  *Needed to actually send notifications.*
* **Topic**
  Topic to publish to (e.g., `tasks`).
  *Lets you separate different kinds of notifications.*
* **Authorization header** (optional)
  e.g., `Bearer XYZ`
  *For private ntfy topics / secured servers. Keep this secret.*
* **Notification title**
  The `X-Title` header (defaults to “NTFY Reminders”).
  *So you can brand your notifications.*
* **Tags** (optional)
  Comma-separated tags sent via `X-Tags`.
  *Handy for filtering or styling on the ntfy side.*
* **Icon URL** (optional)
  Sends `X-Icon`/`Icon` header with an image URL.
  *So your notifications have a nice icon.*

**Input & Formatting**

* **Fuzzy @ step (minutes)**
  Legacy time-grid step (default 5). Kept for compatibility; the new natural-date suggest inserts dates only.

**Tasks Integration**

* **Dismiss task statuses**
  Characters that suppress reminders on task lines (default `x/-`).
  *Stops reminders for tasks that are done/in-progress/cancelled based on your workflow.*

**Sender (who sends notifications)**

* **Allowed hostnames**
  Comma-separated list of exact hostnames that are allowed to send.
  *If set (and/or IPs/CIDRs set), only matching machines send. Others are silent.*
* **Allowed IPs/CIDRs**
  Comma-separated list like `10.0.0.2, 10.0.0.0/24, 10.0.0.`
  *Lets you pin sending to a specific machine or subnet. Useful with multiple Obsidian instances.*

---

### Notes, limits, and troubleshooting

* **This is desktop-only.** It runs in Obsidian Desktop where the plugin code executes.
* **Console logs:** the plugin logs *a lot*. If something doesn’t fire, open the DevTools console and skim messages starting with `[NTFY Reminders]`.
* **Duplicates:** if you run Obsidian in more than one place on the same vault, set **Sender** rules so only one instance sends. (We may add broker-level dedupe later as an option.)
