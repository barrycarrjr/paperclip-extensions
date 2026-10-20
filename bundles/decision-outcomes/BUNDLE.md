---
name: decision-outcomes
displayName: Decision outcomes pack
description: Import the decision-outcomes convention and paused on-demand review routine without creating an agent or choosing a company source.
icon: clipboard-check
category: knowledge
includes:
  skills:
    - decision-outcomes
  routines:
    - decision-outcome-review
---

# Decision outcomes pack

This recipe imports one skill and one routine template. It creates no agent,
chooses no company or records location, grants no access and starts no run.
There are no plugin requirements.

Follow the setup steps in the decision-outcome-review routine: confirm the
single source and existing format, deploy the skill once, select it for chosen
existing agents, and inspect the routine's paused state. Set the approved source
and review time zone before deliberate activation. `requiresSkills` does not
automatically assign a procedure; verify that the existing deployed skill is
selected rather than creating another copy. A run consumes normal model usage.

The companion core stale/orphan checker change must be installed before use;
it is not merged by importing this pack. Published records remain immutable by
convention only. Existing access, approval and log-privacy limits still apply.
Stop future runs by pausing the deployed routine; preserve published records.
