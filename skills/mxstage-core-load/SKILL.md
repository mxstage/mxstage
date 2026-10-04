---
name: mxstage-core-load
description: "MX Stage basic operation: find the Maximo object structure and attributes, agree on the range with the user, and load sheets and referenced master data into the work screen."
metadata:
  version: "1.0.0"
  category: "core"
---

# Loading Maximo data

## 1. Check the state

get_status, always before starting and after any error.

- No tab: ask the user to open the URL from open_grid and wait for their reply (do not keep calling tools meanwhile).
- Not connected to Maximo: ask the user to connect in the work screen settings (saved connections connect by themselves).
- Note the environment (production or test) and say it when you summarise the plan.

## 2. Find the object structure

The work screen saves the structure definitions from Maximo automatically.

- Even if the user names no structure, call find_object_structures with their business terms (for example asset specification or permit date). Show the candidates and the matching attributes, and agree on the structure. Several sheets may already use it (usedBySheets).
- Read attributes with describe_object_structure narrowed by query, child or columns. Structures have hundreds of attributes; never read them all.
- If objectStructures.sync is running, wait and search again. If nothing matches, tell the user instead of guessing.
- Then read the object Skill for that structure (see the index).
- Prefer the standard MXAPI structures (MXAPIASSET, MXAPIOPERLOC, MXAPIWODETAIL and so on). A customer structure may hide or add attributes; check it with describe_object_structure.

## 3. Agree on the range

scope_options. **Do not call load_sheet until the range is agreed** (tens of thousands of rows are common).

- The key and axis columns go into the sheet "Scope structure-name", and candidate values with counts come back per axis (status, classification, owner, type, location, period, numbering).
- Show the axes and counts and let the user decide how to narrow. If a column the user mentioned is missing, find it with describe_object_structure and pass it in axes.
- Call again with the agreed conditions in where to get the distribution inside them. **Narrow until a few thousand rows remain.** Counts with truncatedNote come from a sample of the first rows.
- Typical narrowing: site, status (exclude closed, cancelled or decommissioned records unless the task is about them), classification, location branch, period.

## 4. Load

load_sheet with the conditions from step 3 in where.

- Put only the columns needed for the work and the key columns in select. Child columns look like `ASSETSPEC.ALNVALUE`.
- where is an array of TypedFilter (no condition strings). op is one of eq ne gt gte lt lte in notin like isnull notnull (value is an array for in and notin). Examples: `{"attr":"SITEID","op":"eq","value":"BEDFORD"}` and `{"attr":"STATUS","op":"in","value":["OPERATING","ACTIVE"]}`
- Long loads return a jobId; wait with get_job. In sheets with children, parent values repeat on each child row.
- Conditions on child attributes cannot be sent to Maximo; they are applied on screen after loading. maxRows limits parent rows before that.
- **Every attribute you use for the work must be in the sheet and on screen.** If you find you need another attribute (the long description, the site, the classification), add it to select and load again. Do not reason about values the user cannot see.
- Refer to columns by their display names (labels; columnTitles in the result) when you talk to the user.
- Name the sheet after what it holds (for example "Pumps BEDFORD operating"). Loading with the same name replaces the sheet and its pending changes; ask first if it has changes.
- Read the notes in the result (for example specificationNote) and act on them; they say which related sheet is missing.

## 5. Load the referenced master data

**If a column you are fixing or deciding with refers to another table, load that table with load_master** (fromSheet, from, to). Only the values that appear in the source sheet are loaded, and the screen shows the sheets side by side and follows the selected row.

- Examples: LOCATION of assets → locations; ASSETNUM of work orders → assets; CLASSSTRUCTUREID → the classification structure with HIERARCHYPATH and CLASSSPEC; ITEMNUM → items.
- If there are too many distinct values, narrow the source sheet first.

## Limits

- Attributes of related objects (for example the hierarchy path of an asset's classification) cannot be selected in the same sheet. Load the related object as its own sheet with load_master.
- Non-persistent attributes (those that trigger Maximo processing, such as a new location for a move) are only meaningful if the object Skill says so.
- Loading is free in every environment; it never changes Maximo.
