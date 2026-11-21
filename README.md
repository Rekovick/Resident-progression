# Neurosurgery Residency Tracker

A single-page app for the Neurosurgery Residency Progression System. It covers the seven duty levels, the monthly 100-point score, exam gates, behavior holds, requirement sign-offs, procedure step ladders under the department's clinical privilege list, senior tiers and the launch transition rules, plus theatre case distribution:

- **Case library.** Every case name typed in theatre is remembered with its category, ladder and ordered steps, so the next case of that name fills itself in. Categories and program steps can be added; a step shared by several cases keeps one count.
- **On-call rota.** Paste the month's rota (Arabic or English, a table or one line per day). Each name is linked to a resident once and remembered. Emergency cases take their team from the rota (a case before the on-call day starts belongs to the previous day's shift); elective lists skip whoever is post-call.
- **Fair distribution.** Steps are shared along a learning curve: each resident first takes the step they are learning on the ladder; the other steps go hardest first, a step someone is still learning to the most senior resident allowed it who is under a fair share, a completed step to whoever has the fewest. So the hard steps sit with the seniors, the easier ones are left for the juniors, and no one resident takes every step. Between residents learning the same step, fewer turns goes first, unless that resident has 2+ unexcused absences in 90 days.
- **Clinical privileges.** The department's privilege list (four categories, a level from 0 to 5 for each year of residency) sets what each resident may do in a procedure: level 1 the assistant's steps (positioning, exposure, closure), level 2 the key steps a per-step table allows, level 3 and above the whole case with the surgeon scrubbed. The year comes from the start month, but a Senior counts at least R4 and a 1-day midsenior at least R3; a grade set on the profile overrides both. Burr holes are allowed from R1. Steps are still earned on the ladder, lowest first.
- **Consultant on every case.** Each case names a consultant as surgeon of record; emergency cases take the on-call consultant and specialist from the rota. Procedures marked † need a consultant credentialed for them (Settings, Consultants).
- **Room to grow.** One stretch step just above a resident's limit can be offered with the surgeon of record scrubbed, once everything before it is done (straight away with the boost). Never on Category 4 or † procedures, or on the critical step of a Category 3 case.
- **Post-case review.** Done, postponed or cancelled; attendance (on time, late, excused with a reason, no-show); replacements and covers; who actually did each step, how it went (did it alone, helped only when needed, helped actively, taken over; the first two count toward the step), and why a step was not given. Postponed cases and steps the specialist kept use nobody's turn.
- **Rewards and penalties.** An unexcused absence is a minor behavior event in that month's score; a cover earns the cover bonus; reliable residents get +5 priority for spare places, repeated no-shows get none.
- **Surgical starting levels.** A tap-to-set grid of residents by ladder, with a row to set a whole level. Starting levels are provisional until confirmed or performed; steps above a resident's limit are recorded and count, but are only assigned as a stretch step.

`index.html` is the whole app. It is published as a claude.ai artifact and keeps its records in the artifact's shared database:

- `residents/<id>`: one document per resident (profile, launch baseline, monthly scores, requirements, exams, surgical starting levels in `stepBase`)
- `cases/<YYYY-MM>`: the month's theatre cases, keyed by case id (team and step assignment with reasons, status, attendance, replacements, step outcomes in `out`)
- `rota/<YYYY-MM>`: on-call residents per day
- `library/<id>`: remembered cases (name, other names, category, ladder, steps, privilege list procedure)
- `settings/program`: launch month, specialists, consultants and their † credentials, custom categories and steps, name links for the rota, on-call day start

Anyone the artifact is shared with can view it. Only people with edit access can change records. The program's numbers (thresholds, duty points, deductions, step counts, the privilege list and per-step table, priority weights, fairness and reliability limits) are constants at the top of the script, so they can be recalibrated.

## The installable app

The same code also runs as an installable phone app, set up like Surgery Follow-ups:

- `docs/` is the app, served by GitHub Pages from this branch (`rekovick.github.io/Resident-progression/`). `docs/index.html` is built from `index.html` with `APP_BUILD = true`, and is rebuilt only when a change is released to the real tracker (changes go to the test copy first); `manifest.webmanifest`, `sw.js` and the icons make it installable.
- `server/Code.gs` is the data server, a Google Apps Script web app. It keeps every record in one Google Sheet in the owner's Drive (the "Docs" tab, one row per record, the same paths as above) and checks a personal access key on every request.
- Access is by personal link (`?c=` carries the server address and one key):
  - **owner**: everything, and manages links under Settings, People with access
  - **trainer** (specialists): reads and changes every record
  - **resident**: their own record in full, plus the rota, the case library and the theatre cases. The server removes other residents' scores, attendance, step outcomes and reasons before sending.
- A trainer can send a **case review link** (Theatre, open a case, Send review link). It carries a token for that one case instead of a key: the supervising specialist taps whether the case happened, who came, and who did each step and how, and the case is recorded as reviewed. "Did it alone" and the consultant's name on the link need server version 3; the app shows a banner while the server is older. Links last 14 days and can't read anything else.
- Records move from the claude.ai tracker with Settings, Copy all records, then in the app Settings, Replace all records (owner).
- Setup steps for the owner are in the launch kit artifact.

Build and check:

```sh
python3 tools/build.py [test-copy.html]   # docs/index.html (a release), and optionally the test copy
python3 tools/build.py --no-app test-copy.html   # the test copy alone
node tools/make-icons.js                  # redraw the app icons (Playwright)
node tools/e2e/run.js server/Code.gs docs <residents dir> <rota json> <settings json>
```

`tools/e2e` runs the real `Code.gs` against a stand-in for the Apps Script services and drives the built app as owner, trainer and resident, checking what each one can see and change.

## Test copy

A separate artifact runs the same code with `TEST_COPY = true` and its own database, so changes can be tried before the real tracker gets them. It is built from `index.html` by changing only the title and that flag: `python3 tools/build.py --no-app test-copy.html`. To run the end-to-end test on a change that isn't released yet, build the app, run the test, then put `docs/index.html` back with `git checkout docs/index.html`.

