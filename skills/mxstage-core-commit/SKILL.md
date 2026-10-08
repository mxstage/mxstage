---
name: mxstage-core-commit
description: "MX Stage basic operation: check the diff, request the commit to Maximo, explain blockers (including production licenses), and report the commit result row by row."
metadata:
  version: "1.3.0"
  category: "core"
---

# Committing to Maximo

Only the user commits. Your part is to make the change easy to check and to report what happened.

## 1. Check

get_diff: the changed columns with counts and samples, and added and deleted rows.

- Compare it with what the user agreed: the rows, the columns, the values. If unintended columns or rows changed, undo them (undo_batch) before going on.
- Large commits are fine when the rule is simple; mixed changes are easier to check in separate commits (for example specifications first, then locations).

## 2. Request

request_commit with a note that gives the target (structure and environment), the count, the changed columns and values, and the reason.

- If blockers come back, read them and tell the user. Typical: read-only or key columns, deletes over the limit (the user confirms them in the panel), child rows without the attributes Maximo needs.
- **If a blocker says a license is needed to commit to a production environment**, tell the user what it says (where to buy and where to paste the key) and do not retry. Loading, analysing and editing stay free.

## 3. The user commits

The user reviews the diff in the commit panel and presses the commit button. Do not rush them or assume approval; wait until they tell you.

Above the button, the user chooses how many records one commit sends: all of them, or a number (200 by default). With a number, the first records are sent and the rest stay in the work screen; the user presses the button again for the next batch.

How MX Stage writes: each record is sent with a merge (child rows that were not changed stay as they are), with an ID that prevents duplicate writes. New records are created only after checking that no record with the same key exists. It writes one record first and waits for the user to check it before sending the rest. Records changed in Maximo after loading are not sent (conflict) and the rest continue; it stops on an error or an unknown result.

When the commit creates records, the panel shows how many. Say this count in your note; created records cannot be removed by MX Stage.

Status changes are counted in the panel by target status. Statuses that cannot be undone (CLOSE, CAN and similar) need the user's extra confirmation in the panel; the request result says needsIrreversibleConfirm. Name those records and statuses in your note.

## 4. Report

get_commit_result: the state and the result for each row. When the commit sent only part of the records, batch gives sent and total: say how many are left and that the user can commit again for the rest.

- Give the counts per status: verified (committed and read back), conflict (changed in Maximo since loading), error, unknown (check those records in Maximo), skipped (not sent).
- Skipped with a reason code: MXSTAGE_HISTORY (closed or cancelled record, Maximo does not allow changes), MXSTAGE_PO_REVISION (approved purchase order, revise it in Maximo first), MXSTAGE_STATUS_TRANSITION (Maximo does not allow that status move). List them for the user; do not try to work around them.
- For failed rows, give the Maximo message in short and the likely cause (status does not allow the change, value not in the domain, record changed in Maximo since loading, missing permission on the structure).
- **Never re-run failed rows automatically.** Propose what to fix, and let the user decide whether to change and commit again.
- Conflict rows need a fresh load before another try. Unknown rows may or may not have been written: ask the user to check them in Maximo before anything else.

## After the commit

Verified records are read back from Maximo and become the sheet's new Maximo values; changes of the other records stay pending in the work screen. If the user wants to check in Maximo itself, suggest a few records to open.
