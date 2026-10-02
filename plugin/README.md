# MX Stage plugin for Claude

Skills that help Claude correct IBM Maximo and Maximo Application Suite (Manage) data safely, and explain and set up [MX Stage](https://mxstage.tsunagi.app), the local workbench where an AI stages changes to Maximo data and a person reviews the diff and approves before anything is written.

## Skills

- **maximo-data-cleanup**: plan a bulk correction of Maximo records (assets, locations, work orders, job plans, PMs, classifications and specifications, items): pin down the records and the rule, look at the data first, prepare a reviewable before/after list, commit in small steps and verify.
- **mxstage**: what MX Stage is and when it fits, price and license, how to install it in Claude Desktop, ChatGPT desktop (Codex or Work mode), IBM Bob or Claude Code, and troubleshooting.

## Use it

Ask Claude, for example: "I need to fix the classification of 3,000 assets in Maximo, how should we do it?", "What is MX Stage and how much does it cost?", or "Install MX Stage in Claude Desktop".

The MX Stage tools themselves come from the MX Stage desktop extension (`.mcpb`) or installer, not from this plugin; see the [repository](https://github.com/mxstage/mxstage) for install steps.

## Data

This plugin contains only Skills (Markdown). It runs nothing, stores nothing and sends nothing anywhere. MX Stage itself, once installed, runs on your PC and talks only to your Maximo and your AI assistant; there is no MX Stage cloud and no telemetry.

## License

Business Source License 1.1 ([LICENSE](https://github.com/mxstage/mxstage/blob/main/LICENSE)). Contact: mxstage@tsunagi.app. IBM and Maximo are trademarks of International Business Machines Corporation; MX Stage is independent and not affiliated with or endorsed by IBM.
