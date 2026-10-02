# Changelog

All notable changes to MX Stage are listed here. Versions follow [Semantic Versioning](https://semver.org/). Each version becomes available under the Apache License 2.0 four years after its release (see [LICENSE](LICENSE)).

## 0.2.2 — 2026-10-02

### Added

- **Move the work to this window.** When the sheets are open in another window (for example, the installed app) and you open the work screen somewhere else (for example, the browser inside your AI assistant), the new window says so and offers **Move it to this window**. The sheets, changes and undo history move through the bridge's memory (nothing is written to disk), and the other window becomes empty.

### Fixed

- Clicking a work screen window that has no sheets no longer moves the AI assistant's tools away from the window that has the sheets.

## 0.2.1 — 2026-10-02

### Added

- **Saved Maximo connections.** Choose "Save on this PC" when you connect. The bridge saves the API key encrypted with Windows data protection (DPAPI) or the macOS Keychain, and never sends it to the browser. Every window of the work screen — the installed app, a browser tab, or the browser inside your AI assistant — then connects automatically, also after reloading the page, restarting the bridge or restarting the PC. If the bridge or Maximo is not reachable yet, the work screen retries.
- **Settings → Connection → Saved connections**: switch between Maximo environments, re-enter an API key, or delete a connection. The environment (production or test) is saved with the connection.
- A large development dataset for the fake Maximo: three waste incineration plants operated for 20, 13 and 5 years (`npm run dev:fake-maximo -- --dataset plants`).

### Changed

- On a narrow work screen (for example next to a chat), related tables (such as an asset and its specifications) are stacked vertically, two at a time, instead of showing only the first one.

## 0.2.0 — 2026-10-01

First public release.

### Added

- Production licenses. Choose for each Maximo whether it is a **production** or **test** environment. Committing to a production Maximo needs a license key for that environment; loading, analysing, editing and committing to test environments stay free. Keys are checked on your PC only. Paste keys in **Settings → License**; IT can also place key files in `~/.config/mxstage/licenses/`.
- Environment tag in the top bar (test, production with the licensed organization, production read-only, or a license about to expire).
- English user interface. The language follows the browser and can be changed in **Settings**.
- Claude Desktop extension (`mxstage-<version>.mcpb`): install MX Stage in Claude Desktop without Node.js or Git.
- The installer registers MX Stage with IBM Bob, supports Claude Desktop from the Microsoft Store, and does not register MX Stage twice when the Claude Desktop extension is installed (`--no-claude-desktop`, `--no-bob`, `--claude-code`).
- English tool descriptions, server instructions and built-in Skill (`mxstage-workbench` 1.0.0) for every AI assistant. The AI replies in the user's language.
- `get_status` reports the environment and license state.
- A fake Maximo and a development bridge for developing MX Stage (`npm run dev:fake-maximo`, `npm run dev:bridge`).

### Changed

- Renamed from mxstudio to **MX Stage** (`mxstage`). The installer moves an existing mxstudio installation: it unregisters the old server from each assistant, removes unchanged copies of the old Skill, and copies your Skills to `~/.config/mxstage/skills/`.
- The work screen uses the IBM Carbon Design System.
- The scope sheet created by `scope_options` is now named `Scope <structure>`.
- Licensed under the Business Source License 1.1 with the Apache License 2.0 as the change license.

### Removed

- The unimplemented tools `import_rows` and `export_sheet`.

## 0.1.0

Internal version (mxstudio), not published.
