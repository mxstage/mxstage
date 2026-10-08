# MX Stage

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.mxstage%2Fmxstage-0a7bbb)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.mxstage/mxstage)
[![Latest release](https://img.shields.io/github/v/release/mxstage/mxstage?label=release)](https://github.com/mxstage/mxstage/releases/latest)
[![Claude Desktop extension](https://img.shields.io/badge/Claude_Desktop-.mcpb_extension-d97757)](https://github.com/mxstage/mxstage/releases/latest)
[![ChatGPT desktop](https://img.shields.io/badge/ChatGPT_desktop-Codex_%7C_Work-10a37f)](#supported-ai-assistants)
[![IBM Maximo / MAS Manage](https://img.shields.io/badge/IBM_Maximo-MAS_Manage-0f62fe)](#requirements)
[![EAM / CMMS](https://img.shields.io/badge/category-EAM_%7C_CMMS-6f42c1)](#requirements)
[![MCP server](https://img.shields.io/badge/MCP-server-555555)](https://modelcontextprotocol.io)
[![Free for test environments](https://img.shields.io/badge/free-test_environments-2ea44f)](https://mxstage.tsunagi.app/pricing)
[![License: BSL 1.1](https://img.shields.io/badge/license-BSL_1.1_%E2%86%92_Apache_2.0-blue)](LICENSE)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4)](#requirements)

English | [日本語](README.ja.md)

**MX Stage is a local-only AI workbench for correcting IBM Maximo data with your own AI assistant (Claude Desktop, ChatGPT, Antigravity, IBM Bob): every change is staged, diffed and approved by a human before it is written to Maximo.**

Website: https://mxstage.tsunagi.app · Contact: mxstage@tsunagi.app

- **Your AI works on a staging sheet, not on Maximo.** The AI assistant loads Maximo data into a sheet in the *work screen* (a browser tab), analyses it and proposes changes with reasons. You see every changed cell.
- **Only a person can commit.** The AI's tools cannot write to Maximo. Changes are written only when you press **Commit to Maximo** in the work screen. MX Stage writes one record first and lets you check it before it sends the rest. Records that someone else changed after you loaded them are skipped and listed; it stops on an error or a result it cannot confirm. Any batch of changes can be undone before you commit.
- **Keep a record of what was approved.** The commit panel saves a diff report (Excel): one row per changed cell with the old value, the new value, who changed it (the AI assistant or a person) and why. After a commit, it also holds the write log of that commit.
- **Nothing leaves your PC except calls to your Maximo and your AI assistant.** There is no MX Stage cloud and no telemetry. There are two optional exceptions: if you turn on **Settings → Updates → Update automatically** (off by default), the bridge asks GitHub once a day for the latest version number; and if you choose **Settings → Demo → Download data and connect**, it downloads fictional sample data once from `mxstage-demo.pages.dev` (nothing is sent). Installs made with the setup script then update themselves while no work is open (the new version from GitHub, its packages from the npm registry); the Claude Desktop extension downloads the new file from GitHub and checks it for you to install. A small local process (the *bridge*) serves the work screen, talks MCP to your AI assistant and relays requests to Maximo, so Maximo needs no CORS settings. Your Maximo API key is saved on this PC by the bridge, encrypted with Windows data protection (DPAPI), and is not sent to the browser (on macOS, untested, the Keychain protects it; on Linux, a file only your user can read). Every window of the work screen — the installed app, a browser tab, or the browser inside your AI assistant — connects automatically, even after a restart, and you can switch between saved Maximo environments in Settings. (You can also connect without saving; the key then stays only in the tab's memory.)
- **Teach it your procedures.** Save a procedure worked out in a conversation as a *Skill*; the AI follows it next time.

## Why not call the Maximo REST API from the AI directly?

Several Maximo MCP servers let the AI call the REST API. That is fine for reading, but risky for bulk changes: you cannot see what the AI is about to write, and a wrong guess goes straight into production. MX Stage puts a staging sheet, a diff, an undo and a human approval in between.

## Supported AI assistants

| Assistant | Status |
|---|---|
| Claude Desktop (chat and Code tab) | Supported |
| ChatGPT desktop — **Codex** or **Work** mode (Chat mode cannot use local MCP servers) | Supported |
| Antigravity (2.0, IDE) | Supported (registered by the installer) |
| IBM Bob | Supported (registered by the installer) |
| Claude Code, Codex CLI and IDE extension | Work, not officially supported |

## Requirements

- Windows (macOS and Linux are untested)
- For the installer: Node.js 22.6 or later and Git (the installer offers to install them). The Claude Desktop extension needs neither; the npm package (`npx @mxstage/mxstage`) needs Node.js 20 or later.
- Chrome or Edge
- IBM Maximo or Maximo Application Suite (Manage) with the JSON API at `/maximo/api` and an API key

## Install

### Claude Desktop (simplest)

1. Download `mxstage-<version>.mcpb` from the [latest release](https://github.com/mxstage/mxstage/releases/latest).
2. In Claude Desktop, open **Settings → Extensions**, then **Advanced settings → Install Extension…** and choose the file (or double-click the file, or drag it onto the Extensions page). Choose **Install**.
3. Open `http://127.0.0.1:8788/app` in Chrome or Edge and **enter your Maximo URL and API key in Settings.** Never paste the API key into the chat.
4. In a new chat, ask "show the MX Stage status".

The extension needs no Node.js or Git: Claude Desktop runs it. To use MX Stage from other assistants as well (ChatGPT desktop, IBM Bob, Claude Code in the terminal, Antigravity), use the installer below; it detects the extension and does not register MX Stage twice.

### Try without Maximo

No Maximo at hand? MX Stage includes a demo: a fictional Maximo with three waste incineration plants (assets, locations, about 52,000 work orders, inventory and the data quality problems migrations leave behind), in Japanese or English, running inside the bridge on your PC.

1. Install MX Stage (above), then open `http://127.0.0.1:8788/settings#demo`.
2. Choose **Download data and connect**. MX Stage downloads about 10 MB of fictional data (no programs) once from `mxstage-demo.pages.dev` and checks it against a SHA-256 built into this version.
3. Ask your AI assistant, for example "Check the data quality of the operating assets at North Clean Center and list the problems with counts."

Commits change only the copy on your PC (**Reset to the initial state** puts it back), and no license is needed. The demo takes about 0.5 GB of memory while in use. Five sample Excel files to merge with Maximo (purchase orders without work order numbers, a legacy equipment register, daily work reports printed as A4 forms (a repair log table in the English data), an equipment register ahead of Maximo, a star chart) are in the same tab. See [docs/demo.en.md](docs/demo.en.md).

### Claude plugin (Skills)

The `mxstage` plugin in [`plugin/`](plugin) adds two Skills to Claude (planning a safe bulk correction of Maximo data; explaining, installing and troubleshooting MX Stage) and, in Claude Code and Cowork, starts the MX Stage server with `npx @mxstage/mxstage` (Node.js 20 or later). Chat does not start local servers, so use the extension there. In Claude Code: `/plugin marketplace add mxstage/mxstage`, then `/plugin install mxstage@mxstage`.

### Other assistants (installer)

**Ask Claude Code (or the Code tab of Claude Desktop) to install it:** give it this repository's URL and say "install this". It follows [Installation steps for Claude Code](#installation-steps-for-claude-code) below and asks before running each command.

To install by hand, clone this repository to `%USERPROFILE%\mxstage` and run `node scripts/setup-local.mjs` in it.

**One install registers MX Stage with every supported assistant found on this PC.** Then restart the assistant you use, open `mxstage` on the desktop (or `http://127.0.0.1:8788/app`), and **enter your Maximo URL and API key in Settings.** Never paste the API key into the chat.

In Settings, also choose for each Maximo whether it is **production** or **test**. Committing to production needs a license (see [License](#license)); everything else is free.

MCP clients that start servers with npm can also run the server alone with `npx -y @mxstage/mxstage` (Node.js 20 or later; the Skills and shortcuts come only with the installer).

To update, say "update MX Stage"; to remove it, say "uninstall MX Stage" (see [Uninstall](#uninstall)).

## Where it is registered

`~` is `%USERPROFILE%`. The installer only touches assistants that are installed (Claude Desktop: its settings folder exists; Antigravity: `~\.gemini`; Codex: `~\.codex`; IBM Bob: `~\.bob`), backs up every file before changing it (to `~\.config\mxstage\backup\`), and never changes other servers' settings. `node scripts/setup-local.mjs --status` shows what is registered without changing anything. To leave an assistant out, add `--no-claude-desktop`, `--no-antigravity`, `--no-codex` or `--no-bob` (`--no-skills` copies no Skills). `--claude-code` registers Claude Code even when the extension is enabled.

| Assistant | MCP server | Skills | After installing or updating |
|---|---|---|---|
| Claude Code (CLI) | `mcpServers.mxstage` in `~\.claude.json`. **Not registered** when the MX Stage extension (`.mcpb`) is enabled in Claude Desktop, because the Code tab already gets MX Stage from the extension and would show every tool twice (an entry the installer added earlier is removed). Add `--claude-code` to register anyway for Claude Code in a terminal (remembered for later runs) | `~\.claude\skills\<name>\SKILL.md` | Restart Claude Code |
| Claude Desktop (Code tab) | Same as Claude Code, or the extension (`.mcpb`) when it is enabled | Same as Claude Code | Quit Claude Desktop from the system tray and open it again |
| Claude Desktop (chat) | `mcpServers.mxstage` in `%APPDATA%\Claude\claude_desktop_config.json`. Microsoft Store version: also in `%LOCALAPPDATA%\Packages\Claude_<publisher ID>\LocalCache\Roaming\Claude\claude_desktop_config.json` when that folder exists. **Not registered** when the MX Stage extension (`.mcpb`) is installed and enabled in Claude Desktop (an entry the installer added earlier is removed) | Not copied (see [Skills](#skills)) | Quit from the system tray (closing the window is not enough) and open again |
| Antigravity | `mcpServers.mxstage` in `~\.gemini\config\mcp_config.json` | `~\.gemini\config\skills\<name>\SKILL.md` | Start a new conversation |
| Codex (ChatGPT desktop, CLI, IDE extension) | `[mcp_servers.mxstage]` in `~\.codex\config.toml` | `~\.agents\skills\<name>\SKILL.md` | Restart Codex |
| IBM Bob | `mcpServers.mxstage` in `~\.bob\settings\mcp.json` | `~\.bob\skills\<name>\SKILL.md` | Restart IBM Bob |

## Uninstall

Say "uninstall MX Stage" to Claude Code, or run in `%USERPROFILE%\mxstage`:

```bash
node scripts/setup-local.mjs --uninstall
```

This removes the `mxstage` entries from every assistant (restoring any setting the installer replaced), the Skills it copied (unless you edited them), the sign-in shortcut and desktop shortcut, and the bridge it started. It keeps your own Skills (`~\.config\mxstage\skills\`) and the backups. To remove everything, also delete `%USERPROFILE%\mxstage` and `~\.config\mxstage` (the backups are full copies of the original settings files, including any tokens in them), and clear the site data for `127.0.0.1:8788` in your browser.

## Installation steps for Claude Code

When the user asks to install MX Stage, follow these steps and get the user's approval before each command.

1. **Check prerequisites**: `node --version` (22.6 or later) and `git --version`. If missing, with the user's agreement install them with `winget install OpenJS.NodeJS.LTS` / `winget install Git.Git`, then confirm `node` and `git` work in a new shell.
2. **Get the code** into `%USERPROFILE%\mxstage` (`~/mxstage` on macOS and Linux):
   - if it does not exist: `git clone <this repository URL> "%USERPROFILE%\mxstage"`
   - if it exists: `git pull --ff-only` in it (if local changes block it, stop and tell the user)
3. **Install**: in that folder run `node scripts/setup-local.mjs --json`. This also runs `npm install` and builds the work screen. Do not use `mxstage.cmd` (it waits for a key press at the end).
4. **Read the result**: success if no item in `steps` has `"level": "error"`. For `error` or `warn`, tell the user its `message` and `hint` and follow the `hint`. Do not edit settings files by guesswork.
5. **Tell the user** to restart the assistant they use, to enter the Maximo URL and API key in the work screen settings (`http://127.0.0.1:8788/app`), and never to paste the API key into the chat.

**Update**: steps 2 to 4. Ask the user to restart their assistant afterwards so the new bridge is used. **Uninstall**: `node scripts/setup-local.mjs --uninstall --json`. **Status**: `node scripts/setup-local.mjs --status --json` (changes nothing).

## Skills

A Skill is a procedure the AI assistant follows.

| | Location | Contents | Updates |
|---|---|---|---|
| Built-in: index | `skills/mxstage-workbench` | The rules for every task and which Skill to read when | Replaced with MX Stage updates; do not edit |
| Built-in: basic operations | `skills/mxstage-core-*` (8) | Loading, analysing, changing, matching, importing, committing, the work screen, writing Skills | Same |
| Built-in: standard Maximo objects | `skills/mxstage-obj-*` (8) | Assets and meters, locations, classifications and specifications, work orders, PMs and job plans, items and inventory, purchasing, reference data: what Maximo does with them, what MX Stage can change and the traps | Same |
| Yours | `~/.config/mxstage/skills/<name>/SKILL.md` | Each customer's environment (custom objects, attributes, rules) and your repeated tasks | Yours; kept across updates and never sent anywhere. Names starting with `mxstage` are reserved |

- **Every assistant gets the index**: it is attached, with the list of all Skills, to the result of the first tool call in each conversation, so assistants that cannot load Skill files (Claude Desktop chat, for example) follow the same rules. Tool results name the Skills for each step (for example the asset and classification Skills when asset specifications are loaded), and the AI reads them with `get_skill`.
- **Your Skills come first for their customer**: they may replace steps of the built-in Skills, never the rules of the index.
- **Create Skills from the chat**: say "save this procedure as a Skill". The AI shows the name, description and body, and saves it after you agree.
- Run the installer again to copy new or changed Skills to each assistant.

## Documentation

The detailed guides are in Japanese for now:

- [docs/demo.en.md](docs/demo.en.md) — trying MX Stage without Maximo (the built-in demo; in English)
- [docs/local.md](docs/local.md) — daily use, updates, troubleshooting
- [docs/status.md](docs/status.md) — what works today
- [docs/publish.md](docs/publish.md) — checks before publishing

## Development

```bash
npm run typecheck      # tsc (app and bridge)
npx vitest run         # tests (app and bridge)
npm run test:setup     # installer tests (write only to temporary folders)
npm run build          # build the built-in Skills and the work screen (dist/app)
npm run dev:app        # dev server for the work screen (http://localhost:5173/app?samples=1 shows sample data; relays to the dev bridge on 8790)
npm run dev:fake-maximo  # a fake Maximo at https://127.0.0.1:9797 (API key: test-api-key)
npm run dev:bridge     # a bridge on port 8790 that accepts the development license for the fake Maximo
```

Disable IBM telemetry when installing dependencies (`$env:IBM_TELEMETRY_DISABLED='true'; npm install` in PowerShell); the installer does this itself. See [dev/README.md](dev/README.md) for developing and testing license checks.

**Only test commits against a development Maximo with dummy data.** There is no automatic rollback of changes written to Maximo.

## License

MX Stage is licensed under the [Business Source License 1.1](LICENSE). The source is available, but it is not open source. The [LICENSE](LICENSE) file is authoritative; this is a summary.

- **Free**: everything except committing to a production Maximo — loading, analysing and editing production data, building Skills, and committing to test environments. You may read, modify and redistribute the source under the same license.
- **License needed**: using MX Stage to create, change or delete data in a **production Maximo environment** — US$4,800 per production environment per year, for any number of users and PCs. The license key names the environment's URLs (up to three aliases). [License and purchase](https://mxstage.tsunagi.app/license).
- **Production environment**: the Maximo your organization uses to record day-to-day operations, and an environment being prepared to replace it (for example, a migration target before go-live). **Test environment**: everything else (development, test, training, demonstration, migration rehearsal), even if it holds a copy of production data.
- **Each version becomes Apache License 2.0 four years after its release.**
- Third-party packages and fonts (IBM Carbon Design System, IBM Plex and others) keep their own licenses ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

IBM and Maximo are trademarks of International Business Machines Corporation. MX Stage is an independent product and is not affiliated with or endorsed by IBM.
