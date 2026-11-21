const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const [codePath, docsDir, resDir, rotaFile, settingsFile] = process.argv.slice(2);
const gas = require("./fakegas.js")(codePath);
const SERVER = "https://script.google.com/macros/s/TEST/exec";
const log = (...a) => console.log(...a);
const assert = (c, m) => { if (!c) { console.log("FAIL:", m); process.exitCode = 1; } else console.log("ok  ", m); };

// 1. setup, then import a copy of the real records (residents, November rota, settings)
gas.ctx.setup();
const ownerKey = gas.logs.find(l => l.includes("ACCESS KEY")).split(": ").pop();
const docs = {};
for (const f of fs.readdirSync(resDir)) docs["residents/" + f.replace(".json", "")] = JSON.parse(fs.readFileSync(path.join(resDir, f)));
docs["rota/2026-11"] = JSON.parse(fs.readFileSync(rotaFile));
docs["settings/program"] = JSON.parse(fs.readFileSync(settingsFile));
log("import:", JSON.stringify(gas.api(ownerKey, "importDocs", docs)));
const trainer = gas.api(ownerKey, "addPerson", "د.علاء احمد", "trainer", "");
const resident = gas.api(ownerKey, "addPerson", "Ahmed Saleh", "resident", "ahmed-saleh");
assert(gas.api(ownerKey, "listPeople").length === 3, "owner sees three people");
try { gas.api(resident.key, "setDoc", "library/x", { name: "x" }); assert(false, "resident write refused"); } catch (e) { assert(e.message === "VIEW_ONLY", "resident write refused (" + e.message + ")"); }
try { gas.api("nope".repeat(10), "bootstrap"); assert(false, "bad key refused"); } catch (e) { assert(e.message === "ACCESS_DENIED", "bad key refused"); }

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/Resident-progression\/?/, "") || "index.html";
  const f = path.join(docsDir, rel);
  if (!f.startsWith(docsDir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(f)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type }); fs.createReadStream(f).pipe(res);
}).listen(8123);
const enc = o => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const BASE = "http://localhost:8123/Resident-progression/";

(async () => {
  const browser = await chromium.launch();
  const open = async (key, width, label) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", e => errs.push(e.message)); page._errs = errs;
    await page.route(SERVER, async route => route.fulfill({ status: 200, contentType: "application/json", body: gas.post(route.request().postData()) }));
    await page.goto(BASE + "?c=" + enc({ s: SERVER, k: key, n: label }));
    await page.waitForFunction(() => S.mode === "live" && S.me, null, { timeout: 15000 });
    return page;
  };

  // 2. owner
  const owner = await open(ownerKey, 1280, "owner");
  assert(await owner.evaluate(() => location.search === ""), "link removed from the address bar after connecting");
  assert(await owner.evaluate(() => Object.keys(S.residents).length === 20 && rotaDay("2026-11-01").length === 7), "owner sees 20 residents and the November rota");
  await owner.evaluate(() => { S.view = "settings"; render(); });
  await owner.waitForFunction(() => S.people && document.body.innerText.includes("People with access"), null, { timeout: 10000 });
  await owner.click('[data-act="pp-res"][data-id="amr-el-sabbagh"]');
  await owner.waitForFunction(() => S.modal && S.modal.type === "plink" && S.modal.draft.qr && S.modal.draft.qr !== "", null, { timeout: 15000 }).catch(() => {});
  const qr = await owner.evaluate(() => !!(S.modal && S.modal.draft.qr));
  log("QR code:", qr ? "drawn" : "library blocked in this sandbox");
  await owner.screenshot({ path: "owner-link.png" });
  const amrUrl = await owner.evaluate(() => S.modal.draft.url);
  assert(amrUrl.startsWith(BASE + "?c="), "resident link points at the app");
  await owner.evaluate(() => closeModal());

  // 3. trainer plans an emergency case from the rota and reviews it: Ahmed Saleh no-show, Amr covers
  const tr = await open(trainer.key, 1280, "trainer");
  assert(await tr.evaluate(() => S.canEdit && S.me.role === "trainer"), "trainer can edit");
  const oldServer = await tr.evaluate(async () => { try { await call("noSuchAction"); return "no error"; } catch (e) { return dbErr(e); } });
  assert(/older version/.test(oldServer), "an action the server doesn't know says the server needs updating");
  assert(await tr.evaluate(() => S.serverVersion === 4 && !document.body.innerText.includes("older version")), "no update warning on a current server");
  await tr.evaluate(async () => {
    const date = "2026-11-01", c = newCase("em"); applyLib(c, libFind("trauma craniotomy")); c.title = "Trauma craniotomy";
    const rids = rotaDay(date).filter(id => run(S.residents[id]).level >= 1);
    const plan = planEmergency(c, rids, "2026-11", privOfCase(c));
    window.__plan1 = { plan, priv: privOfCase(c).key };
    await saveCases({ c1: caseFromPlan({ date, time: "21:30", kind: "emergency", title: c.title, lib: c.libId, cat: "em", ladder: "cranio", steps: orderedSteps(c), specialist: "د.عبد الرحمن صالح", consultant: "د.علاء احمد", priv: privOfCase(c).key }, plan) });
    openReview(allCases().find(x => x.id === "c1"));
    const d = S.modal.draft, jr = d.team.find(t => t.rid === "ahmed-saleh");
    jr.att = "unx"; d.allSteps.forEach(k => { if (d.out[k].who === "ahmed-saleh") d.out[k] = { who: "" }; });
    d.xids = ["amr-el-sabbagh"]; d.xfor = { "amr-el-sabbagh": "ahmed-saleh" };
    d.allSteps.forEach(k => { const o = d.out[k]; if (!o.who) o.who = "amr-el-sabbagh"; if (o.who !== "spec") o.o = "sat"; });
    await saveReview();
  });
  assert(await tr.evaluate(() => caseStatus(allCases().find(x => x.id === "c1")) === "done"), "trainer saved the review to the server");
  const lim = await tr.evaluate(() => {
    const { plan, priv } = window.__plan1, p = PRIV_BY[priv], bad = [], wide = [];
    plan.team.forEach(t => { const r = S.residents[t.id], st = surg(r); (t.steps || []).forEach(k => { if (!(t.stretch || []).includes(k) && !withinLimit(p, k, st.grade, st.E.level)) bad.push(t.id + ":" + k); }); if ((t.stretch || []).length > 1) wide.push(t.id); });
    return { bad, wide, priv };
  });
  assert(lim.priv === "edh" && !lim.bad.length, "every assigned step is within the privilege limit or marked stretch " + lim.bad.join(", "));
  assert(!lim.wide.length, "at most one stretch step per resident on a case");
  const r1 = await tr.evaluate(() => {
    const id = Object.keys(S.residents).find(x => gradeOf(S.residents[x]) === 1);
    if (!id) return "none";
    const p = PRIV_BY.edh;
    return withinLimit(p, "em.burr", 1, 3) && withinLimit(p, "em.closure", 1, 3) && !withinLimit(p, "cr.path", 1, 3) ? "ok" : "wrong";
  });
  assert(r1 !== "wrong", "R1 may do burr holes and closure, not the critical step");
  assert(gas.api(ownerKey, "exportDocs")["cases/2026-11"].items.c1.consultant === "د.علاء احمد", "the server keeps the case's consultant");
  const list = await tr.evaluate(() => {
    const mk = id => { const c = newCase("el"); applyLib(c, libById(id)); c.title = libById(id).name; return c; };
    const cases = [mk("b-lfix25"), mk("b-tfed"), mk("b-acdf2")];
    const plans = planList(cases, [], "2026-11"), bad = [], wide = [];
    plans.forEach((plan, i) => { const p = privOfCase(cases[i]); plan.team.forEach(t => { const st = surg(S.residents[t.id]); (t.steps || []).forEach(k => { if (!(t.stretch || []).includes(k) && !withinLimit(p, k, st.grade, st.E.level)) bad.push(cases[i].title + " " + t.id + ":" + k); }); if (new Set((t.stretch || []).map(baseKey)).size > 1 || (t.stretch || []).length > 1) wide.push(t.id); }); });
    return { bad, wide, privs: cases.map(c => privOfCase(c).key), sizes: plans.map(p => p.team.length) };
  });
  const curve = await tr.evaluate(() => {
    const mk = id => { const c = newCase("el"); applyLib(c, libById(id)); c.title = libById(id).name; return c; };
    const cases = [mk("b-tfed"), mk("b-acdf2"), mk("b-cea"), mk("b-ogm")], out = [];
    planList(cases, [], "2026-11").forEach((plan, i) => {
      const p = privOfCase(cases[i]), team = plan.team, ok = (m, k) => { const st = surg(S.residents[m.id]); return withinLimit(p, k, st.grade, st.E.level); };
      const all = orderedSteps(cases[i]), share = Math.ceil(all.filter(k => team.some(m => ok(m, k))).length / team.length);
      team.forEach(m => { const shared = (m.steps || []).filter(k => team.some(o => o !== m && ok(o, k))); if (shared.length > share) out.push(cases[i].title + ": " + m.id + " has " + shared.length + " steps others could do (fair share " + share + ")"); });
    });
    return out;
  });
  assert(!curve.length, "no resident takes more than a fair share of the steps a teammate could do " + curve.join("; "));
  assert(await tr.evaluate(() => gradeOf(S.residents["ahmed-rehan"]) === 4 && gradeOf(S.residents["ahmed-saleh"]) === 1), "a Senior (Rehan) counts as R4; an R1 stays R1");
  assert(list.privs.join() === "plif,mis,acdf", "library cases from the other session carry their privilege list procedure " + list.privs.join());
  assert(!list.bad.length && !list.wide.length, "an elective list (L2–S1 fixation, TFED, two-level ACDF) keeps every step within limits, one stretch at most " + list.bad.concat(list.wide).join(", "));
  const auto = await tr.evaluate(() => { const d = { case: newCase("em"), date: "2026-11-02", time: "10:00", specialist: "", consultant: "" }; emSurgeons(d); const a = [d.consultant, d.specialist]; d.consultant = "د.محمود كمال"; d.date = "2026-11-01"; emSurgeons(d); return a.concat([d.consultant, d.specialist]); });
  assert(auto[0] === "د.سلامة قريطم" && auto[1] === "د.احمد العشرى" && auto[2] === "د.محمود كمال" && auto[3] === "د.عبد الرحمن صالح", "emergency cases take the on-call consultant and specialist from the rota, keeping one changed by hand " + auto.join(" / "));
  const stored = gas.api(ownerKey, "exportDocs")["cases/2026-11"];
  assert(stored && stored.items.c1.team.find(t => t.rid === "ahmed-saleh").att === "unx", "server keeps the no-show");

  // 3b. a review link for a second case, answered on a phone without signing in
  const linkUrl = await tr.evaluate(async () => {
    const date = "2026-11-02", c = newCase("em"); applyLib(c, libFind("chronic subdural hematoma")); c.title = "Chronic subdural hematoma";
    const rids = rotaDay(date).filter(id => run(S.residents[id]).level >= 1);
    await saveCases({ c2: caseFromPlan({ date, time: "10:00", kind: "emergency", title: c.title, lib: c.libId, cat: "em", ladder: "csdh", steps: orderedSteps(c), specialist: "د.احمد العشرى", consultant: "د.سلامة قريطم" }, planEmergency(c, rids, "2026-11")) });
    await sendReviewLink(allCases().find(x => x.id === "c2"));
    return S.modal && S.modal.type === "qr" ? S.modal.draft.url : null;
  });
  assert(linkUrl && linkUrl.startsWith(BASE + "?r="), "trainer gets a review link for the case");
  const token = JSON.parse(Buffer.from(linkUrl.split("?r=")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).t;
  const svCtx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const sv = await svCtx.newPage(); const svErrs = []; sv.on("pageerror", e => svErrs.push(e.message));
  await sv.route(SERVER, async route => route.fulfill({ status: 200, contentType: "application/json", body: gas.post(route.request().postData()) }));
  await sv.goto(linkUrl);
  await sv.waitForFunction(() => S.sv && S.sv.info, null, { timeout: 15000 });
  await sv.screenshot({ path: "survey-start.png", fullPage: true });
  const plan2 = await sv.evaluate(() => ({ team: S.sv.info.case.team.map(t => ({ rid: t.rid, steps: t.steps })), steps: svSteps(S.sv.info.case) }));
  const noShow = plan2.team.find(t => t.steps.includes("em.closure")).rid;
  await sv.click(`[data-act="sv-att"][data-r="${noShow}"][data-v="unx"]`);
  assert(await sv.evaluate(() => document.body.innerText.includes("Surgeon of record: د.سلامة قريطم")), "the review link names the consultant");
  let alone = 0;
  for (const k of plan2.steps) {
    await sv.locator(`[data-act="sv-who"][data-k="${k}"]`).first().click();
    const good = sv.locator(`[data-act="sv-o"][data-k="${k}"][data-v="${alone ? "sat" : "ind"}"]`);
    if (await good.count()) { await good.click(); alone++; }
  }
  await sv.fill("#sv-name", "د.احمد العشرى");
  await sv.click('[data-act="sv-send"]');
  await sv.waitForFunction(() => S.sv.sent, null, { timeout: 15000 });
  await sv.screenshot({ path: "survey-sent.png" });
  const c2 = gas.api(ownerKey, "exportDocs")["cases/2026-11"].items.c2;
  assert(c2.status === "done" && c2.reviewedVia === "link" && c2.reviewedBy === "د.احمد العشرى", "the review link records the case as reviewed by the specialist");
  assert(c2.team.find(t => t.rid === noShow).att === "unx", "the no-show tapped on the link is recorded");
  assert(Object.keys(c2.out).length === plan2.steps.length && Object.values(c2.out).every(o => o.who === "spec" || o.o === "sat" || o.o === "ind"), "every step has who did it and how it went");
  assert(!alone || Object.values(c2.out).some(o => o.o === "ind"), "the server takes the \"did it alone\" rating");
  assert(await sv.evaluate(() => { try { return !localStorage.getItem("residency-tracker-connections"); } catch (e) { return true; } }), "the review link saves nothing on the specialist's phone");
  assert(JSON.parse(gas.post(JSON.stringify({ t: token, fn: "bootstrap" }))).ok === false, "a review link can't read the rest of the tracker");
  assert(JSON.parse(gas.post(JSON.stringify({ t: "0".repeat(32), fn: "caseSurvey" }))).error === "LINK_EXPIRED", "a made-up review link is refused");
  assert(!svErrs.length, "review page has no script errors " + svErrs.join("; "));
  await tr.evaluate(() => S.db.reload());
  await tr.evaluate(() => openReview(allCases().find(x => x.id === "c2")));
  assert(await tr.evaluate(() => document.querySelector(".modal").innerText.includes("through the review link")), "the trainer's review shows it came from the link");
  await tr.evaluate(() => closeModal());

  // 4. the owner's open app picks the case up by polling
  await owner.evaluate(() => S.db.reload());
  assert(await owner.evaluate(() => !!allCases().find(x => x.id === "c1")), "owner sees the trainer's case");

  // 5. resident Amr: own record full, others stripped, cases without others' attendance
  const res = await open(JSON.parse(Buffer.from(amrUrl.split("?c=")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).k, 400, "resident");
  const r = await res.evaluate(() => {
    const c = allCases().find(x => x.id === "c1");
    return {
      role: S.me.role, canEdit: S.canEdit, view: S.view, rid: S.rid,
      othersPublic: Object.keys(S.residents).filter(id => id !== "amr-el-sabbagh").every(id => S.residents[id].public === true),
      ownFull: !S.residents["amr-el-sabbagh"].public,
      saleh: c.team.find(t => t.rid === "ahmed-saleh"),
      otherOutcomes: Object.values(c.out || {}).filter(o => o.who !== "amr-el-sabbagh" && o.who !== "spec" && o.o).length,
      myCover: (c.extra || []).find(x => x.rid === "amr-el-sabbagh"),
      tabs: [...document.querySelectorAll(".tabbar .tabbtn")].map(b => b.innerText.trim()),
    };
  });
  log(JSON.stringify(r));
  assert(r.role === "resident" && !r.canEdit && r.view === "resident" && r.rid === "amr-el-sabbagh", "resident opens on their own record, view only");
  assert(r.othersPublic && r.ownFull, "other residents arrive without scores; own record is full");
  assert(r.saleh && r.saleh.att === undefined && r.saleh.why === undefined, "another resident's no-show is hidden");
  assert(r.otherOutcomes === 0, "other residents' step outcomes are hidden");
  assert(r.myCover && r.myCover.for === "ahmed-saleh", "own cover is visible");
  assert(r.tabs.join(",") === "Me,Theatre,Rota,Rules", "resident tab bar: Me, Theatre, Rota, Rules");
  await res.evaluate(() => { S.view = "fair"; render(); });
  assert(await res.evaluate(() => S.view === "resident"), "resident can't open Fairness");
  await res.evaluate(() => { S.view = "resident"; S.tab = "theatre"; render(); });
  await res.screenshot({ path: "resident-theatre.png" });
  log("resident theatre:", await res.evaluate(() => { S.view = "theatre"; S.theatreYM = "2026-11"; render(); return S.view + " / " + document.querySelector("main").innerText.slice(0, 300).replace(/\n/g, " · "); }));
  await res.evaluate(() => { document.querySelector('[data-act="case-open"]').click(); });
  assert(await res.evaluate(() => S.modal && S.modal.type === "caseview"), "resident opens a case read-only");
  await res.screenshot({ path: "resident-case.png" });
  const w = await res.evaluate(async () => { try { await S.db.doc("library/x").set({ name: "x" }); return "written"; } catch (e) { return e.code; } });
  assert(w === "VIEW_ONLY", "resident's app can't write");

  // 5b. the owner opens a resident's link on the same device, then switches back
  await owner.goto(amrUrl);
  await owner.waitForFunction(() => S.mode === "live" && S.me && S.me.role === "resident", null, { timeout: 15000 });
  assert(await owner.evaluate(() => readConns().list.length === 2), "the device keeps both links");
  await owner.click('[data-act="me-menu"]');
  assert(await owner.evaluate(() => document.querySelectorAll('[data-act="switch"]').length === 1), "the owner link is offered under Also on this device");
  await owner.screenshot({ path: "switch.png" });
  await Promise.all([owner.waitForNavigation(), owner.click('[data-act="switch"]')]);
  await owner.waitForFunction(() => S.mode === "live" && S.me, null, { timeout: 15000 });
  assert(await owner.evaluate(() => S.me.role === "owner" && S.canEdit), "switching back gives the owner view");
  await owner.click('[data-act="me-menu"]');
  await Promise.all([owner.waitForNavigation(), owner.click('[data-act="disconnect"]')]);
  await owner.waitForFunction(() => S.mode === "live" && S.me, null, { timeout: 15000 });
  assert(await owner.evaluate(() => S.me.role === "resident" && readConns().list.length === 1), "removing the owner link falls back to the resident link");

  // 6. switching a link off disconnects that phone at the next request
  gas.api(ownerKey, "removePerson", resident.id);
  try { gas.api(resident.key, "bootstrap"); assert(false, "switched-off link refused"); } catch (e) { assert(e.message === "ACCESS_DENIED", "switched-off link refused"); }

  // 7. connect screen without a link
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
  const blank = await ctx.newPage(); await blank.goto(BASE);
  await blank.waitForFunction(() => S.mode === "connect");
  await blank.screenshot({ path: "connect.png" });
  assert(true, "connect screen shows without a link");

  for (const [n, p] of [["owner", owner], ["trainer", tr], ["resident", res]]) assert(!p._errs.length, n + " page has no script errors " + p._errs.join("; "));
  assert(!gas.lockViolations.length, "no lock released with unsaved writes");
  const big = Object.values(gas.sheets)[0][0].rows.some(r => (r || []).some(v => String(v).length > 45000));
  log("largest cell under limit:", !big);
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
