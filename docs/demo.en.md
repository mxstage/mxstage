# Try without Maximo (the built-in demo)

English | [日本語](demo.md)

MX Stage includes a demo that runs a fictional Maximo on your PC. People without a Maximo of their own (evaluators, partners, prospects)
can go through the same steps as with a real one: load data, find data quality problems, fix them, commit, and merge Excel files with Maximo.

## What is in it

Three waste incineration plants run by a fictional regional authority (ORGID `KANKYO`). All names, people and vendors are fictional.

| Site | Name | Opened | On Maximo since |
|---|---|---|---|
| `KITA` | North Clean Center | 2006-04 | 2018-04 (migrated from a legacy register) |
| `MINAMI` | South Clean Center | 2013-04 | 2018-04 (migrated from a legacy register) |
| `HIGASHI` | East Clean Center | 2021-04 | 2021-04 (from opening) |

- 25 object structures: locations (about 1,700, with the location hierarchy and an electrical system), assets (about 2,500, including rotating assets and spares),
  work orders (about 52,000, with status history and failure reports), service requests, PMs, job plans, meter readings, items, inventory and issues,
  classifications and specifications, failure codes, people, crafts and vendors.
- More than 40 kinds of data quality problems that migrations and daily entry leave behind are planted on purpose: missing specifications, mixed units,
  tags that break the naming rule, placeholder serial numbers, corrective work orders without failure codes, PMs still pointing at decommissioned assets,
  inventory that does not add up, and more.
- The data comes in Japanese and in English. Sites, IDs and counts are the same; the text and the currency (JPY / USD) differ. In the English data the
  problems take forms natural in English (O and 0 mixed up, inconsistent abbreviations and so on).
- The data is as of 2026-09-30.

## Connect

1. Install MX Stage ([README](../README.md)). In Claude Desktop, installing the extension (.mcpb) is all you need.
2. Open the Demo tab of the work screen settings (`http://127.0.0.1:8788/settings#demo`). You can also ask your AI assistant to open the MX Stage demo; it gives you the URL.
3. Choose the data language and press **Download data and connect**.
   - MX Stage downloads about 10 MB of fictional data (JSON and Excel only, no programs) once from `mxstage-demo.pages.dev`.
   - The files are checked against a SHA-256 built into this version of MX Stage before they are used. If the files on the site have changed, they are not used.
   - Nothing is sent (no user data, no usage data). After the download, the demo works offline.
4. Once connected, a purple **Demo** badge appears at the top. Open the work screen and ask your AI assistant.

The demo connection is always a **test environment** and needs no license. Commits change only the copy on your PC.

## What to try

### Find and fix data quality problems

- "Check the data quality of the operating assets at North Clean Center and list the problems with counts."
- "List the assets whose serial number is a placeholder (UNKNOWN, -, N/A and so on)."
- "Make the flow units in the pump specifications consistent (m3/h)."
- "Find PMs that still point at decommissioned assets."

### Merge Excel files with Maximo (five samples are in the Demo tab)

**Load into work screen** adds the file to the work screen, just like dropping it there. **Download** saves it so you can open it in Excel.

| Excel | What to do | Supported |
|---|---|---|
| Purchase orders (FY2026 H1) | Fill in order amounts, accepted amounts, dates and vendors on completed outsourced work orders. There are no work order numbers; match by subject, plant and period | Fully |
| Legacy equipment register (before Maximo) | Fill in serial numbers, install dates and manufacturers left blank or temporary by the 2018 migration | Fully |
| Repair log (North, FY2026 H1) | Add failure codes to corrective work orders from free-text repair notes | Fully |
| East equipment register (ahead of Maximo) | Merge equipment added, replaced, re-specified or removed in a register kept by the plant | Partly (status changes for removed equipment come in a later version) |
| Star chart (North / South, before Maximo) | Register maintenance history from before Maximo as closed work orders | Partly (reshaping the table comes in a later version) |

Examples:

- "Import the purchase order list and fill in the order amount, accepted amount and vendor on the completed outsourced work orders."
- "Import the legacy equipment register and fix the assets whose serial number is a placeholder."
- "Import the repair log and add failure codes to the corrective work orders that have none."

## Reset, close, remove

- **Reset to the initial state** undoes every commit made in the demo. Reload sheets in the work screen afterwards.
- **Close the demo** releases its memory. Commits made in the demo are gone.
- **Remove downloaded data** deletes the downloaded files from your PC. You can download them again.
- The files are in the state folder (`%USERPROFILE%\.config\mxstage\demo\`).

## Memory

While it is in use, the demo Maximo takes about 0.5 GB of memory (one language at a time; switching languages releases the other).
It is released when you close the demo, after an hour without use, or when MX Stage restarts. Using it again reloads the initial data (a few seconds).

## How it differs from a real Maximo

- The demo reproduces only the JSON API that MX Stage uses (`/maximo/api/os/...`). There are no Maximo screens, workflows or automation scripts.
- A few standard object structures (such as `MXAPIASSETATTRIBUTE` and `MXAPIMETERREADING`) use names and child objects not yet checked against a real Maximo.
- Responses are much faster than a real Maximo, so they say nothing about how long loading and committing take in practice.
- The order amount attributes on work orders (`EXT_*`) stand for attributes a customer added.

## Turn the demo off

To keep the demo off, for example on company PCs, start the bridge with `--no-demo`. The Demo tab then says it is turned off and nothing is downloaded.

## Building and publishing the data (developers)

The data is generated from `dev/datasets/plants/` in this repository. See [docs/demo-ops.md](demo-ops.md) (in Japanese) for building and publishing, and [dev/README.md](../dev/README.md) for the details of the data.
