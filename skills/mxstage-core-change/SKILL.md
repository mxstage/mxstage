---
name: mxstage-core-change
description: "MX Stage basic operation: change sheets in the work screen with apply_rule (dry run first), patch_cells, add_rows and delete_rows, with reasons, conflicts and undo. Maximo is not changed yet."
metadata:
  version: "1.6.0"
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
- A value chosen by the row's dates (for statuses, see Statuses below): `{"STATUS":{"phase":{"finish":"ACTFINISH","start":"ACTSTART","planned":"TARGSTARTDATE","inProgress":"INPRG","future":"WAPPR"}}}`

- A code decided from words in the text, with a words → codes dictionary of the customer (open_dictionary): `{"PROBLEM":{"classify":{"dictionary":"Failure words","textCol":"WORK","field":"PROBLEM","scopeCol":"FAILURECLASS"}}}`.
- A value made correct with a value replacement dictionary: `{"MANUFACTURER":{"replace":{"dictionary":"Maker names"}}}`.

Check dictionary (classify, replace) or lookup in the result: matched, unmatched, ambiguous. Unmatched rows (no entry, not in the lookup sheet, or an empty value there) and ambiguous rows (several codes, or candidates with different values) are **not changed**; candidates that agree on one value count as matched. Decide more rows by adding or narrowing dictionary entries (the work screen shows the rows each entry hit), never by writing values row by row or guessing. Report the counts. When one column cannot identify a match, use a composite key: arrays in the same order and count, for example `["SITEID","ASSETNUM"]` for both matchCol and targetMatchCol.

## Statuses

The right status depends on each record's phase, never on the kind of file or task. MX Stage sends a STATUS change with Maximo's own status action after the record is created or updated and verified, so Maximo applies its rules.

- **Past work** (the end date has passed): the status for past work set for the connection, COMP unless the user chose CLOSE. Existing completed records keep their status; their contents can still be corrected.
- **In progress** (started, not finished): existing records keep their status and only their contents change. New records get the in-progress status the user agrees (usually INPRG).
- **Future** (not started): the planning status the user agrees (usually WAPPR, or the customer's own).
- Use apply_rule with phase on new rows: give finish and start (actual date columns), planned (a planned date column, so rows not started yet count as future), inProgress and future; omit past to use the connection's setting, and tell the user which status past rows got (phaseNote). Rows without dates are not changed (noDate); report them. Existing rows are left alone unless the user asks (newRowsOnly: false).
- Agree on the values first: check the STATUS values in use with aggregate, and never guess status names (customers may have their own).
- Dates of past work go into ACTSTART and ACTFINISH; the status date is the time of the commit.
- Closed or cancelled records, and moves Maximo does not allow (for example COMP back to INPRG), are not sent: they come back as skipped with the reason.

## A few rows: patch_cells

- For values decided row by row (up to 500 edits). Give reason, and the reason of each edits item when they differ.
- Use the rowKey from query_rows.

## Child rows: add_rows and delete_rows

- add_rows adds rows to a sheet; for child rows (specifications, job plan tasks, PO lines, domain values) give parentRowKey of the parent row. Fill the attributes Maximo needs for the child (the object Skill lists them). Leave the child's own ID empty; Maximo assigns it.
- **Child rows from another sheet** (such as failure report lines from codes decided in an import): from with parent, `{"from":{"sheet":"Report May","parent":{"WONUM":"WONUM"},"columns":{"FAILUREREPORT.FAILURECODE":"PROBLEM"},"values":{"FAILUREREPORT.TYPE":"PROBLEM"},"onePerParent":true}}`. Same values make one row and rows already there are skipped; with onePerParent, parents whose rows disagree (split) or that have another value already (differs) are left out. Report the counts in from.
- A few child rows you decide yourself under many parents: children, a list of parentRowKey and rows (up to 200 rows, one undo batch).
- delete_rows marks child rows for deletion. Top-level records cannot be deleted.
- Deleting more than 10 child rows under one record, or more than 50 in a commit, needs the user's extra confirmation in the commit panel. Explain why the rows go before asking.

## New records

add_rows without parentRowKey adds a new record, which is created in Maximo when the user commits. A created record cannot be removed by MX Stage, so agree on the list first.

1. **Check they are new.** Load or match the records that may already exist (mxstage-core-match); those are changed, not created. Without a shared number (repairs in a daily report), compare by asset or location and date, searching Maximo around each date (mxstage-obj-workorder).
2. **Have a sheet of the structure** with every column you will fill (load_sheet).
3. **Fill the keys and required attributes.** Records listed in another sheet go with add_rows from (values for constants such as SITEID). Every key column is needed (for example SITEID and ASSETNUM); MX Stage does not use Maximo's automatic numbering, so if the customer numbers automatically, ask for the numbers or let the user create those records in Maximo. Find required attributes with describe_object_structure, and the rules of the object in its object Skill.
4. **Add children** with add_rows and parentRowKey set to the rowKey of the new row.
5. **Order**: records that others refer to come first, in an earlier commit (classifications before assets, parent locations before child locations, items before inventory).
6. **After the commit**, the sheet shows the record as Maximo created it, including defaults Maximo filled (status, child IDs, specification rows from the classification). Check them with the user.
7. **Status**: a new record starts in Maximo's initial status. If STATUS is filled, MX Stage changes it after creating the record (see Statuses). If only that change fails, the record stays created and the status change stays in the work screen for the next commit.

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
