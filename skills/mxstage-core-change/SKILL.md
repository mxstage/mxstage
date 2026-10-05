---
name: mxstage-core-change
description: "MX Stage basic operation: change sheets in the work screen with apply_rule (dry run first), patch_cells, add_rows and delete_rows, with reasons, conflicts and undo. Maximo is not changed yet."
metadata:
  version: "1.1.0"
  category: "core"
---

# Changing sheets

Every change here stays in the work screen until the user commits. Each change carries a reason the user sees.

## Before changing

- Agree with the user on the rule: which rows (filter), which columns, which value or source, and what happens to rows the rule cannot decide.
- Check the object Skill for attributes that must not be changed or that trigger Maximo processing.
- Use baseRevision = the revision you last read (from get_status, query_rows or the previous change). Cells changed since then are not overwritten and come back in conflicts.

## Many rows: apply_rule

Runs inside the work screen, so row data never passes through you.

1. Run it with dryRun: true. Show the user the counts and sample values.
2. Run it for real with the same arguments and dryRun: false.

set values:

- A constant: `{"PRIORITY":{"const":2}}`
- Another column of the same row: `{"ALNVALUE":{"copyFrom":"NUMVALUE"}}`
- A value looked up in another sheet: `{"LOCATION":{"lookup":{"sheet":"Tag list","matchCol":"ASSETNUM","targetMatchCol":"ASSETNUM","sourceCol":"LOCATION"}}}`

For lookups, check lookup in the result. Rows that are unmatched (not in the lookup sheet) or ambiguous (several candidates) are **not changed**. Report the counts; never fill them by guessing. When one column cannot identify a match, use a composite key: arrays in the same order and count, for example `["SITEID","ASSETNUM"]` for both matchCol and targetMatchCol.

## A few rows: patch_cells

- For values decided row by row (up to 500 edits). Give reason, and put the reason for each row in the reason of each edits item (up to 500 characters) when they differ.
- Use the rowKey from query_rows.

## Child rows: add_rows and delete_rows

- add_rows adds rows to a sheet; for child rows (specifications, job plan tasks, PO lines, domain values) give parentRowKey of the parent row. Fill the attributes Maximo needs for the child (the object Skill lists them). Leave the child's own ID empty; Maximo assigns it.
- delete_rows marks child rows for deletion. Top-level records cannot be deleted.
- Deleting more than 10 child rows under one record, or more than 50 in a commit, needs the user's extra confirmation in the commit panel. Explain why the rows go before asking.

## New records

add_rows without parentRowKey adds a new record, which is created in Maximo when the user commits. A created record cannot be removed by MX Stage, so agree on the list first.

1. **Check they are new.** Load the records that may already exist (for example a where with in on the keys) or match the list against a loaded sheet (mxstage-core-match). Records that exist are changed, not created.
2. **Have a sheet of the structure** with every column you will fill: load_sheet with those columns (a where that matches the records you compare with, or none).
3. **Fill the keys and required attributes.** Every key column is needed (for example SITEID and ASSETNUM); MX Stage does not use Maximo's automatic numbering, so if the customer numbers automatically, ask for the numbers or let the user create those records in Maximo. Find required attributes with describe_object_structure, and the rules of the object in its object Skill.
4. **Add children** with add_rows and parentRowKey set to the rowKey of the new row.
5. **Order**: records that others refer to come first, in an earlier commit (classifications before assets, parent locations before child locations, items before inventory).
6. **After the commit**, the sheet shows the record as Maximo created it, including defaults Maximo filled (status, child IDs, specification rows from the classification). Check them with the user.

If a record with the same key already exists when the commit runs, it is not sent and comes back as a conflict.

## Conflicts

Rows in conflicts were not changed:

- changed_since_read: read again and redo.
- user_editing: the user is editing the cell; do not overwrite.
- read_only_column: the attribute is read-only in Maximo or a key column; it cannot be changed here.
- row_not_found, column_not_found: check the names; load the column if it is missing.
- invalid_value: the value does not fit the column type or length.
- lookup_ambiguous: show the candidates and let the user choose.

## Undo

Every change returns a batchId. undo_batch undoes the whole batch. Undo mistakes at once rather than patching over them, and tell the user what was undone.

## After changing

Check the result with get_diff (columns and counts) and read a sample with query_rows view diff. If unintended columns or rows changed, undo them before going on.
