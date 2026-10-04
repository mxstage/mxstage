---
name: mxstage-obj-classification
description: "MX Stage object Skill for Maximo classifications, attributes and specifications (ASSETSPEC, LOCATIONSPEC, ITEMSPEC): read class definitions, fill missing specifications, check units and types."
metadata:
  version: "1.0.0"
  category: "object"
---

# Classifications and specifications

## The pieces

| Object | Holds | Key |
|---|---|---|
| Classification (CLASSSTRUCTURE) | the class tree: CLASSSTRUCTUREID, CLASSIFICATIONID, HIERARCHYPATH (for example PUMP \ CENTRIFUGAL), description, which objects use it | CLASSSTRUCTUREID |
| Classification items (CLASSSPEC, child of the classification) | the items of a class: ASSETATTRID, unit (MEASUREUNITID), table or domain, whether inherited | CLASSSTRUCTUREID and ASSETATTRID |
| Attributes (ASSETATTRIBUTE) | the item definitions: DATATYPE (ALN, NUMERIC, TABLE, DATE), domain, unit | ASSETATTRID |
| Specifications (ASSETSPEC, LOCATIONSPEC, ITEMSPEC) | values per record: ASSETATTRID with ALNVALUE, NUMVALUE, TABLEVALUE or the date value, MEASUREUNITID, CLASSSTRUCTUREID | the record's key and ASSETATTRID (plus SECTION if used) |

## Loading specifications so they can be checked

1. Load the records with the specification child, for example select ASSETNUM, SITEID, DESCRIPTION, CLASSSTRUCTUREID, `ASSETSPEC.ASSETATTRID`, `ASSETSPEC.ALNVALUE`, `ASSETSPEC.NUMVALUE`, `ASSETSPEC.MEASUREUNITID`.
2. Load the classifications as a sheet: the structure for classifications (find it with find_object_structures), with CLASSSTRUCTUREID, HIERARCHYPATH, DESCRIPTION and the CLASSSPEC child (ASSETATTRID, MEASUREUNITID), narrowed to the classes the records use (load_master from CLASSSTRUCTUREID, or a where on CLASSSTRUCTUREID). The screen then marks missing items in yellow and shows the hierarchy path.
3. Load the attribute definitions (ASSETATTRID with DATATYPE) the same way, so values go into the right column (NUMVALUE for numeric, ALNVALUE for text).
4. If the load_sheet result has a specificationNote, follow it.

## What MX Stage can do

- **Fill missing specifications**: in the one-row-per-record view, values entered in yellow cells add the specification row with the classification's unit and CLASSSTRUCTUREID. With add_rows, give parentRowKey, ASSETATTRID, the value in the right column, MEASUREUNITID and CLASSSTRUCTUREID.
- **Correct values**: unify spellings, convert units (and change MEASUREUNITID with the value), move numbers from ALNVALUE to NUMVALUE where the attribute is numeric.
- **Remove specification rows** that do not belong to the record's classification (delete_rows), after showing the list. Inherited rows come back if the classification has them.
- **Add an item to a classification**: CLASSSPEC child row of the classification. Maximo then adds the item to the records of that class (and its children if inherited); tell the user how many records are affected.

## What it cannot do now

- Create classifications or attributes (the class tree is created from the top, by HIERARCHYPATH).
- Read the hierarchy path in the same sheet as the records; load the classification as its own sheet (step 2).

## Traps

1. **Changing a record's classification rebuilds its specifications**: Maximo removes the existing rows and creates empty ones from the new class. Values are lost; even sending the same class again has removed values in some versions. Never mix a classification change and specification edits in one commit. Warn, agree, change the class, load again, then fill.
2. **Units**: the classification item's unit is the expected one. Rows with other units (⚠ mixed units in the wide view) need a decision: convert or keep. Never convert without the user's agreement on the factor.
3. **Types**: numeric items store in NUMVALUE, text in ALNVALUE, table items in TABLEVALUE, domain-controlled items only accept domain values. Check the domain with load_master or aggregate before filling.
4. **Rotating assets** take specifications from their item (ITEMSPEC). Fix the item for values that come from it.
5. **Sections**: if SECTION is used, the same ASSETATTRID can appear several times on one record; treat ASSETATTRID and SECTION as the key.

## Checks before the commit

- Added rows have ASSETATTRID, the value in the right column, the unit and CLASSSTRUCTUREID.
- No CLASSSTRUCTUREID change on the records in the same commit.
- The count of filled items per attribute matches what the user agreed.
