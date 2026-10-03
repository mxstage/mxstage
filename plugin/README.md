# MX Stage plugin for Claude

Skills that help Claude correct IBM Maximo and Maximo Application Suite (Manage) data safely, and explain and set up [MX Stage](https://mxstage.tsunagi.app), the local workbench where an AI stages changes to Maximo data and a person reviews the diff and approves before anything is written.

## Skills

- **maximo-data-cleanup**: plan a bulk correction of Maximo records (assets, locations, work orders, job plans, PMs, classifications and specifications, items): pin down the records and the rule, look at the data first, prepare a reviewable before/after list, commit in small steps and verify.
- **mxstage**: what MX Stage is and when it fits, price and license, how to install it in Claude Desktop, ChatGPT desktop (Codex or Work mode), IBM Bob or Claude Code, and troubleshooting.

## Use it

Ask Claude, for example: "I need to fix the classification of 3,000 assets in Maximo, how should we do it?", "What is MX Stage and how much does it cost?", or "Show the MX Stage status".

## MCP server

In **Claude Code** and **Cowork** (sessions on your computer), the plugin also starts the MX Stage MCP server on your PC with `npx -y @mxstage/mxstage@<version>` (Node.js 20 or later). Open `http://127.0.0.1:8788/app` and enter your Maximo URL and API key in Settings; never paste the API key into the chat.

Chat in claude.ai and the Claude desktop app does not start local servers; there, install the MX Stage desktop extension (`.mcpb`) from the [latest release](https://github.com/mxstage/mxstage/releases/latest). If you already installed MX Stage with the extension or the installer, the tools may appear twice in Claude Code; turn one of them off.

## Data

- **Skills**: Markdown only. They store and send nothing.
- **MCP server**: npx downloads the pinned `@mxstage/mxstage` package from the npm registry (registry.npmjs.org) and runs it on your PC. It serves the work screen at `127.0.0.1:8788` and connects only to the Maximo URL you enter. Maximo data you load reaches Claude as tool results, like any MCP tool. Your Maximo API key and settings stay on your PC (the key encrypted with Windows DPAPI or the macOS Keychain, under `~/.config/mxstage`) and are never sent to us or to the browser. License keys are checked offline.
- **Updates**: only if you turn on Settings → Updates → Update automatically (off by default), it asks GitHub (api.github.com) once a day for the latest version number; nothing about you or your data is sent.
- There is no MX Stage cloud and no telemetry. Privacy policy: https://mxstage.tsunagi.app/privacy

## License

Business Source License 1.1 ([LICENSE](https://github.com/mxstage/mxstage/blob/main/LICENSE)). Contact: mxstage@tsunagi.app. IBM and Maximo are trademarks of International Business Machines Corporation; MX Stage is independent and not affiliated with or endorsed by IBM.
