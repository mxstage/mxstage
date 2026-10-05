---
name: mxstage-obj-asset
description: "MX Stage object Skill for Maximo assets and their meters (MXAPIASSET): bulk corrections of the asset register, specifications, meters, and the traps of classification changes, moves and status."
metadata:
  version: "1.1.0"
  category: "object"
---

# Assets (MXAPIASSET)

Key: SITEID and ASSETNUM (ASSETNUM is unique only within a site). Usual children: ASSETSPEC (specifications), ASSETMETER (meters). Read mxstage-obj-classification as well when specifications are involved.

## What MX Stage can do

| Task | How | Notes |
|---|---|---|
| Correct the register (description, manufacturer, vendor, serial number, priority, asset type, failure class, rotating item, installation date, owner fields) | apply_rule or patch_cells on the attributes | The most common task. Check variants with aggregate first (mxstage-core-analyze) |
| Fill or correct specifications | ASSETSPEC child rows: change values, add missing items with add_rows | See mxstage-obj-classification. Use the one-row-per-record view to see what is missing |
| Add a meter to assets | ASSETMETER child rows with add_rows (METERNAME, and the attributes the meter type needs) | The meter must exist and be active |
| Fix references (location, parent, GL account, calendar) | apply_rule with a lookup | Load the referenced master with load_master first. Changing LOCATION or PARENT is a move: read the traps |

## What it cannot do now

- **Change status** (operating, not ready, decommissioned). Maximo changes asset status through its own action, which propagates to child assets and stops when active PMs, routes or open work orders exist. Editing STATUS in the sheet does not run that action. Tell the user to use Change Status in the Assets application.
- **Swap assets, or read meter history.** Meter readings are entered through Maximo's reading actions (see below).

## Traps

1. **Changing the classification (CLASSSTRUCTUREID) rebuilds the specifications.** Maximo removes the existing ASSETSPEC rows and creates empty rows from the new classification's items, so existing values are lost. Before any classification change, tell the user, show how many assets have specification values, and get explicit agreement. Change the classification in one commit and fill the specifications in a later one (after loading again).
2. **Moving an asset is not an attribute edit.** Maximo moves assets through NEWLOCATION and NEWSITE (non-persistent attributes) to record the move history and to move child assets. Writing LOCATION directly may be ignored or skip the history. Only propose a move if describe_object_structure shows NEWLOCATION in the structure, and ask the user to try one record in a test environment first. Moving to another site is a Maximo move; do not attempt it here.
3. **Parent changes** (PARENT) are moves too: the child follows the parent's location, and settings that keep the hierarchy can block moving a child alone. Treat them like moves.
4. **Rotating assets** (with ITEMNUM) take their specifications from the item. A change on the asset can be overwritten from the item; fix the item when the item is wrong.
5. **Decommissioned assets** should not be changed. Exclude them in the range unless the task is about them.
6. **Site**: the same ASSETNUM can exist at several sites. Always match and look up with SITEID and ASSETNUM.

## New assets

New assets can be created (New records in mxstage-core-change). Keys: SITEID and ASSETNUM; MX Stage does not take Maximo's automatic numbers, so ASSETNUM must be known.

- Usually needed: DESCRIPTION, and the references (LOCATION, PARENT, CLASSSTRUCTUREID, ITEMNUM for rotating assets) must already exist; load them with load_master to check.
- Maximo sets the initial status (usually not ready) and, with a classification, adds the classification's specification rows. Fill specification values in a later commit, after the sheet shows those rows.
- Create parent assets before their children (an earlier commit).
- Rotating assets need the item in the site's inventory or an issue; if Maximo rejects them, report the message.

## Meters

- ASSETMETER rows connect a meter to an asset (METERNAME, active flag, average calculation settings).
- Readings are history, not attributes. Maximo takes a new reading through NEWREADING and NEWREADINGDATE (non-persistent), and the date must be later than the last reading; continuous meters roll down to child assets and can trigger meter-based PMs. Readings are hard to correct afterwards. Only enter readings if the structure has those attributes, after a test on one record, and with the user's explicit agreement for each batch.

## Checks before the commit

- get_diff shows only the agreed columns. No CLASSSTRUCTUREID change unless agreed with the warning above.
- No LOCATION, PARENT or SITEID changes unless the move was agreed.
- The count of assets equals the agreed range.
