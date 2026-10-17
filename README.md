# Neurosurgery Residency Tracker

A single-page app for the Neurosurgery Residency Progression System. It covers the seven duty levels, the monthly 100-point score, exam gates, behavior holds, requirement sign-offs, procedure step ladders with level ceilings, theatre case assignment, senior tiers and the launch transition rules.

- `index.html` is the whole app. It is published as a claude.ai artifact and keeps its records in the artifact's shared database:
  - `residents/<id>`: one document per resident (profile, launch baseline, monthly scores, requirements, exams, transition step sign-offs)
  - `cases/<YYYY-MM>`: the month's theatre cases, keyed by case id (team, step assignment with reasons, recorded outcomes)
  - `settings/program`: launch month and specialist names
- Anyone the artifact is shared with can view it. Only people with edit access can change records.
- The program's numbers (thresholds, duty points, deductions, step counts, ceilings, priority weights) are constants at the top of the script, so they can be recalibrated.
