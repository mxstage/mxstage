---
name: mxstage-obj-pm-jobplan
description: "MX Stage object Skill for Maximo PMs, job plans and routes (MXAPIPM, MXAPIJOBPLAN, routes): reviewing PM schedules, correcting draft job plans, and the traps of master PMs and job plan revisions."
metadata:
  version: "1.0.0"
  category: "object"
---

# Preventive maintenance, job plans and routes

PMs: MXAPIPM, key SITEID and PMNUM, children such as PMSEQUENCE (job plan sequence) and PMMETER (meter-based frequency). Job plans: MXAPIJOBPLAN, key JPNUM (and PLUSCREVNUM when revisions are on), children JOBTASK, JOBLABOR, JOBMATERIAL, JOBTOOL. Routes: ROUTE_STOP children.

## What MX Stage can do

| Task | How | Notes |
|---|---|---|
| Review PM schedules: frequency and unit, next due date, extended date, lead time, alerts, season, work type, priority | apply_rule or patch_cells | The most common task. Agree on the rule (for example align all monthly boiler PMs on the first Monday) |
| Change the job plan, asset or location of PMs | apply_rule with a lookup | Load the job plans or assets with load_master first |
| Correct job plans that are **draft or pending revision** (tasks, labor, materials, tools, duration) | attributes and child rows | Not active ones (see below) |
| Route stops (assets and locations of a route) | child rows | |

## What it cannot do now

- Activate or deactivate PMs, or change job plan status. These are Maximo status actions; tell the user to use the applications.
- Create PMs, job plans or routes (migration).
- **Revise an active job plan.** When job plan revisions are enabled, active job plans are read-only; Maximo creates a revision (a copy with a higher PLUSCREVNUM) that is edited and then activated. Ask the user to create the revisions in Maximo, then load and correct them here, then the user activates them.
- Generate work orders.

## Traps

1. **Master PMs overwrite their related PMs.** Changing a master PM pushes its values to the PMs created from it, except where a related PM allows overrides. Before changing a master PM, show how many related PMs follow it. Changing a related PM may be undone by the next master update; ask which one the user means.
2. **Next due date and frequency interact**: changing the frequency recalculates the next date in Maximo; changing NEXTDATE moves the schedule. Agree on which drives the change, and check a few records after the commit.
3. **Work orders already generated** keep their old values; only new ones follow the PM.
4. **Meter-based PMs** depend on meter readings and PMMETER rows; changing the frequency there changes when work is generated.
5. **Job plans used by many PMs**: a change affects every PM that uses it. Count the PMs with aggregate on JPNUM in a PM sheet first.
6. **Organisation or site level**: job plans can be defined for an organisation or a site; match on JPNUM with ORGID or SITEID as needed.

## Checks before the commit

- Only PMs in the agreed range change; master PMs only if agreed with the warning above.
- Job plan changes only on draft or pending-revision records.
- Show the user a sample of PMs with old and new next dates.
