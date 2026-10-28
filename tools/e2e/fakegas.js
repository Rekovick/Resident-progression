// A small stand-in for the Google Apps Script services Code.gs uses, so the real server runs in Node.
const vm = require("vm"), fs = require("fs"), crypto = require("crypto");
module.exports = function load(codePath) {
  const sheets = {}, props = {}, logs = [];
  let pending = 0; const lockViolations = [];
  function Range(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  Range.prototype.getValues = function () { const out = []; for (let i = 0; i < this.nr; i++) { const row = this.sh.rows[this.r - 1 + i] || []; const line = []; for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; line.push(v == null ? "" : v); } out.push(line); } return out; };
  Range.prototype.setValues = function (v) {
    if (v.length !== this.nr || v.some(r => r.length !== this.nc)) throw new Error("setValues: dimensions mismatch");
    if (this.r - 1 + this.nr > this.sh.maxRows || this.c - 1 + this.nc > this.sh.maxCols) throw new Error("Range out of bounds");
    v.forEach((row, i) => { const t = this.sh.rows[this.r - 1 + i] || (this.sh.rows[this.r - 1 + i] = []); row.forEach((x, j) => { if (String(x).length > 50000) throw new Error("cell over 50000 characters"); t[this.c - 1 + j] = x; }); });
    pending++; return this;
  };
  Range.prototype.setNumberFormat = function () { return this; };
  Range.prototype.setFontWeight = function () { return this; };
  Range.prototype.getRow = function () { return this.r; };
  Range.prototype.createTextFinder = function (text) { const rg = this; let whole = false; return { matchEntireCell(b) { whole = b; return this; }, findNext() { const v = rg.getValues(); for (let i = 0; i < v.length; i++) for (let j = 0; j < v[i].length; j++) { const s = String(v[i][j]); if (whole ? s === text : s.includes(text)) return new Range(rg.sh, rg.r + i, rg.c + j, 1, 1); } return null; } }; };
  function Sheet(d) { this.d = d; }
  Object.defineProperty(Sheet.prototype, "rows", { get() { return this.d.rows; } });
  Object.defineProperty(Sheet.prototype, "maxRows", { get() { return this.d.maxRows; } });
  Object.defineProperty(Sheet.prototype, "maxCols", { get() { return this.d.maxCols; } });
  Sheet.prototype.getRange = function (r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); };
  Sheet.prototype.getLastRow = function () { for (let i = this.d.rows.length - 1; i >= 0; i--) if ((this.d.rows[i] || []).some(v => v !== "" && v != null)) return i + 1; return 0; };
  Sheet.prototype.getLastColumn = function () { let m = 0; this.d.rows.forEach(r => (r || []).forEach((v, i) => { if (v !== "" && v != null) m = Math.max(m, i + 1); })); return m; };
  Sheet.prototype.getMaxRows = function () { return this.d.maxRows; };
  Sheet.prototype.getMaxColumns = function () { return this.d.maxCols; };
  Sheet.prototype.getDataRange = function () { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); };
  Sheet.prototype.insertRowsAfter = function (a, n) { this.d.maxRows += n; return this; };
  Sheet.prototype.insertColumnsAfter = function (a, n) { this.d.maxCols += n; return this; };
  Sheet.prototype.clearContents = function () { this.d.rows = []; pending++; return this; };
  Sheet.prototype.setName = function (n) { this.d.name = n; return this; };
  Sheet.prototype.setFrozenRows = function () { return this; };
  function SS(id) { this.id = id; }
  SS.prototype.getId = function () { return this.id; };
  SS.prototype.getUrl = function () { return "https://docs.google.com/spreadsheets/d/" + this.id; };
  SS.prototype.getSheets = function () { return sheets[this.id].map(d => new Sheet(d)); };
  SS.prototype.getSheetByName = function (n) { const d = sheets[this.id].find(x => x.name === n); return d ? new Sheet(d) : null; };
  const ctx = {
    console, JSON, Math, Date, Number, String, Object, Array, Error,
    SpreadsheetApp: {
      create(name) { const id = "ss" + crypto.randomBytes(4).toString("hex"); sheets[id] = [{ name: "Sheet1", rows: [], maxRows: 1000, maxCols: 26 }]; return new SS(id); },
      openById(id) { if (!sheets[id]) throw new Error("no sheet"); return new SS(id); },
      flush() { pending = 0; },
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty(k, v) { props[k] = String(v); return this; },
      setProperties(o) { Object.keys(o).forEach(k => { props[k] = String(o[k]); }); return this; }, deleteProperty(k) { delete props[k]; return this; },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() { if (pending) lockViolations.push(new Error("released lock with unsaved writes").stack); } }) },
    Utilities: { getUuid: () => crypto.randomUUID(), sleep() {} },
    Session: { getEffectiveUser: () => ({ getEmail: () => "ahmed.hadhood@example.com" }), getActiveUser: () => ({ getEmail: () => "" }) },
    Logger: { log: m => logs.push(String(m)) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: t => ({ t, setMimeType() { return this; }, getContent() { return this.t; } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, "utf8"), ctx, { filename: "Code.gs" });
  const post = body => { const out = ctx.doPost({ postData: { contents: body } }).getContent(); pending = 0; return out; };
  const api = (key, fn, ...args) => { const r = JSON.parse(post(JSON.stringify({ key, fn, args }))); if (!r.ok) throw new Error(r.error); return r.result; };
  return { ctx, post, api, logs, sheets, props, lockViolations };
};
