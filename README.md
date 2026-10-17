# Neurosurgery Residency Tracker

A single-page app for tracking residents through the Neurosurgery Residency Progression System: seven duty levels, a monthly 100-point score, exam gates, behavior holds, requirement sign-offs, the surgical ladder and senior tiers.

- `index.html` is the whole app. It is published as a claude.ai artifact and stores records in the artifact's shared database (`residents` collection, one document per resident).
- Anyone the artifact is shared with can view. Only people with edit access can add residents or record scores.
- The program's numbers (thresholds, duty points, deductions) are constants at the top of the script, so they can be recalibrated after the trial month.
