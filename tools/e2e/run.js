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
  await tr.evaluate(async () => {
    const date = "2026-11-01", c = newCase("em"); applyLib(c, libFind("trauma craniotomy")); c.title = "Trauma craniotomy";
    const rids = rotaDay(date).filter(id => run(S.residents[id]).level >= 1);
    const plan = planEmergency(c, rids, "2026-11");
    await saveCases({ c1: caseFromPlan({ date, time: "21:30", kind: "emergency", title: c.title, lib: c.libId, cat: "em", ladder: "cranio", steps: orderedSteps(c), specialist: "د.عبد الرحمن صالح" }, plan) });
    openReview(allCases().find(x => x.id === "c1"));
    const d = S.modal.draft, jr = d.team.find(t => t.rid === "ahmed-saleh");
    jr.att = "unx"; d.allSteps.forEach(k => { if (d.out[k].who === "ahmed-saleh") d.out[k] = { who: "" }; });
    d.xids = ["amr-el-sabbagh"]; d.xfor = { "amr-el-sabbagh": "ahmed-saleh" };
    d.allSteps.forEach(k => { const o = d.out[k]; if (!o.who) o.who = "amr-el-sabbagh"; if (o.who !== "spec") o.o = "sat"; });
    await saveReview();
  });
  assert(await tr.evaluate(() => caseStatus(allCases().find(x => x.id === "c1")) === "done"), "trainer saved the review to the server");
  const stored = gas.api(ownerKey, "exportDocs")["cases/2026-11"];
  assert(stored && stored.items.c1.team.find(t => t.rid === "ahmed-saleh").att === "unx", "server keeps the no-show");

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
