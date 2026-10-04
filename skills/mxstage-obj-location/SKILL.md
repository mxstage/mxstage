---
name: mxstage-obj-location
description: "MX Stage object Skill for Maximo locations and systems (MXAPIOPERLOC): correcting attributes and specifications, and the rules for hierarchy, systems and status."
metadata:
  version: "1.0.0"
  category: "object"
---

# Locations (MXAPIOPERLOC)

Key: SITEID and LOCATION. Usual children: LOCATIONSPEC (specifications), LOCHIERARCHY (place in a system hierarchy), LOCOPER. Locations have types (operating, storeroom, repair, salvage, vendor, courier, labor); this Skill is about operating locations. Storerooms are in mxstage-obj-item-inventory.

## What MX Stage can do

| Task | How | Notes |
|---|---|---|
| Correct attributes (description, type, GL account, failure class, calendar, priority, owner fields) | apply_rule or patch_cells | Check variants with aggregate first |
| Fill or correct specifications | LOCATIONSPEC child rows | Same rules as asset specifications (mxstage-obj-classification) |
| Fix references | apply_rule with a lookup | Load the referenced master with load_master |

## What it cannot do now

- **Create locations or hierarchies** (registration, migration). Maximo creates hierarchies from the top down; list the records for the user to create.
- **Change status** (operating, not ready, decommissioned). Maximo's action checks open work orders, purchase orders, reservations and active PMs and propagates to child locations. Tell the user to use Change Status in the Locations application.
- **Move a location to another parent or system.** Maximo changes the hierarchy through PARENT and SYSTEMID handling; changing existing locations this way has known problems. Do not change LOCHIERARCHY rows; tell the user to use the Locations application, or verify on a test environment first if the user insists.

## Traps

1. **Changing the classification rebuilds the specifications** (the existing values are lost), as for assets. Warn and agree first; fill specifications in a later commit.
2. **Several systems**: a location can be in more than one system (one primary). The parent depends on the system. Read LOCHIERARCHY with SYSTEMID before talking about the hierarchy.
3. **Site**: always match with SITEID and LOCATION.
4. **Assets at the location** keep their own attributes. Changing a location does not change its assets; if the task is about both, load the assets with load_master (from LOCATION to LOCATION) and handle them in their own sheet (mxstage-obj-asset).

## Checks before the commit

- Only the agreed attributes and specification rows change.
- No LOCHIERARCHY, STATUS or TYPE changes unless agreed.
