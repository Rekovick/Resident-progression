/**
 * Neurosurgery Residency Tracker — data server (Google Apps Script).
 *
 * The app itself is a separate installable web app (the docs/ folder, hosted on GitHub Pages).
 * It talks to this script over HTTPS; every request must carry a valid access key, and the key
 * decides what the request may see and do:
 *
 *   owner    — everything, and manages who has access
 *   trainer  — reads and edits every record (specialists)
 *   resident — reads only their own record in full, plus the rota, the case library and the
 *              theatre cases with other residents' attendance and step outcomes removed
 *
 * Everything is stored in the Google Drive of the account that deploys this script, in one
 * Google Sheet created by setup(). Its "Docs" tab holds one row per record:
 *
 *   path | rev | updatedAt | updatedBy | chunks | json part 1 | json part 2 | ...
 *
 * A record's JSON is split across cells because a Sheets cell holds at most 50,000 characters.
 */

const APP_TITLE = 'Residency Tracker';
const APP_URL = 'https://rekovick.github.io/Resident-progression/';
const SHEET_DOCS = 'Docs';
const HEAD = ['path', 'rev', 'updatedAt', 'updatedBy', 'chunks'];
const CHUNK = 45000;
const COLLECTIONS = ['residents', 'cases', 'rota', 'library', 'settings'];
const ROLES = ['owner', 'trainer', 'resident'];
/** Bumped when the app needs to know what this server supports. */
const SERVER_VERSION = 1;

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/** The app sends POST requests: {key, fn, args}. The reply is JSON: {ok, result} or {ok: false, error}. */
const API = {
  bootstrap: bootstrap_,
  sync: sync_,
  setDoc: setDoc_,
  updateDoc: updateDoc_,
  deleteDoc: deleteDoc_,
  exportDocs: exportDocs_,
  importDocs: importDocs_,
  listPeople: listPeople_,
  addPerson: addPerson_,
  removePerson: removePerson_,
};

/** The person whose access key signed the current request. */
let REQUEST_PERSON_ = null;

function doPost(e) {
  let reply;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const person = findPersonByKey_(req.key);
    if (!person) {
      Utilities.sleep(400); // slows down anyone guessing keys
      throw new Error('ACCESS_DENIED');
    }
    if (!Object.prototype.hasOwnProperty.call(API, req.fn)) throw new Error('Unknown action: ' + req.fn);
    REQUEST_PERSON_ = person;
    reply = { ok: true, result: API[req.fn].apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    reply = { ok: false, error: String((err && err.message) || err) };
  } finally {
    REQUEST_PERSON_ = null;
  }
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(
    APP_TITLE + ' server is running. Open the app at ' + APP_URL + ' and connect it with your link.');
}

/**
 * Run this from the editor: creates the Sheet (first time only) and an owner access key
 * for you, then prints what you need to connect the app.
 */
function setup() {
  const ss = openStore_();
  let owner = readPeople_().find(p => p.role === 'owner');
  if (!owner) owner = createPerson_(ownerName_(), 'owner', '');
  Logger.log('Data sheet: ' + ss.getUrl());
  Logger.log('Open the app: ' + APP_URL);
  Logger.log('Your ACCESS KEY (keep it private): ' + owner.key);
}

/** Run this from the editor if a link may have leaked: removes everyone's access and makes a new owner key. */
function resetAccessKeys() {
  withLock_(() => PropertiesService.getScriptProperties().deleteProperty('ACCESS_KEYS'));
  const owner = createPerson_(ownerName_(), 'owner', '');
  Logger.log('All devices are disconnected. Your NEW ACCESS KEY: ' + owner.key);
}

// ---------------------------------------------------------------------------
// API — reached only through doPost with a valid key
// ---------------------------------------------------------------------------

function bootstrap_() {
  const docs = readDocs_();
  const out = [];
  Object.keys(docs).forEach(path => {
    if (docs[path].data !== null) out.push({ path: path, data: filterFor_(REQUEST_PERSON_, path, docs[path].data) });
  });
  return { me: publicPerson_(REQUEST_PERSON_), rev: currentRev_(), docs: out, serverVersion: SERVER_VERSION };
}

/** Records changed since the client's revision. A replace-all import asks clients to start over. */
function sync_(since) {
  since = Number(since) || 0;
  const props = PropertiesService.getScriptProperties();
  const rev = Number(props.getProperty('REV') || 0);
  const resetRev = Number(props.getProperty('RESET_REV') || 0);
  if (since < resetRev) return { reset: true, rev: rev };
  if (since >= rev) return { rev: rev, changes: [] };
  const docs = readDocs_();
  const changes = [];
  Object.keys(docs).forEach(path => {
    const d = docs[path];
    if (d.rev > since) changes.push({ path: path, data: d.data === null ? null : filterFor_(REQUEST_PERSON_, path, d.data) });
  });
  return { rev: rev, changes: changes };
}

function setDoc_(path, data) {
  requireEditor_();
  checkPath_(path);
  if (!isObject_(data)) throw new Error('A record must be an object.');
  return writeDoc_(path, () => data);
}

/** Merge-write: nested objects merge recursively; anything else, arrays included, replaces the field. */
function updateDoc_(path, patch) {
  requireEditor_();
  checkPath_(path);
  if (!isObject_(patch)) throw new Error('An update must be an object.');
  return writeDoc_(path, existing => {
    if (existing === null) throw new Error('NOT_FOUND: ' + path);
    return deepMerge_(existing, patch);
  });
}

function deleteDoc_(path) {
  requireEditor_();
  checkPath_(path);
  return writeDoc_(path, () => null);
}

function exportDocs_() {
  requireEditor_();
  const docs = readDocs_();
  const out = {};
  Object.keys(docs).forEach(path => { if (docs[path].data !== null) out[path] = docs[path].data; });
  return out;
}

/** Owner only: replaces every record with the ones given ({path: data}). */
function importDocs_(docs) {
  requireOwner_();
  if (!isObject_(docs)) throw new Error('Nothing to import.');
  const paths = Object.keys(docs);
  paths.forEach(checkPath_);
  if (!paths.length) throw new Error('Nothing to import.');
  return withLock_(() => {
    const ss = openStore_();
    const sh = ss.getSheetByName(SHEET_DOCS);
    const props = PropertiesService.getScriptProperties();
    const rev = Number(props.getProperty('REV') || 0) + 1;
    const now = nowIso_();
    const by = REQUEST_PERSON_.name;
    const rows = paths.map(path => rowFor_(path, rev, now, by, docs[path]));
    const width = Math.max(HEAD.length, ...rows.map(r => r.length));
    sh.clearContents();
    const grid = [HEAD.concat(new Array(width - HEAD.length).fill(''))].concat(rows.map(r => r.concat(new Array(width - r.length).fill(''))));
    if (grid.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), grid.length - sh.getMaxRows());
    if (width > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    sh.getRange(1, 1, grid.length, width).setNumberFormat('@').setValues(grid);
    props.setProperties({ REV: String(rev), RESET_REV: String(rev) });
    return { imported: paths.length, rev: rev };
  });
}

// ---------------------------------------------------------------------------
// What a resident may see
// ---------------------------------------------------------------------------

function filterFor_(person, path, data) {
  if (!person || person.role !== 'resident') return data;
  const parts = path.split('/');
  if (parts[0] === 'residents') {
    if (parts[1] === person.rid) return data;
    // other residents: enough to show their name and level, none of their scores or events
    const b = data.baseline || null;
    return {
      name: data.name || '', start: data.start || null, startNote: data.startNote || '',
      baseline: b ? { month: b.month, level: b.level, points: 0, exam1: !!b.exam1, exam2: !!b.exam2, priorReqs: !!b.priorReqs } : null,
      reqs: {}, exams: { e1: [], e2: [] }, months: {}, stepBase: {}, lpBase: 0, notes: '', public: true,
    };
  }
  if (parts[0] === 'cases') {
    const items = {};
    Object.keys(data.items || {}).forEach(id => {
      const c = data.items[id];
      if (!c) { items[id] = c; return; }
      const copy = JSON.parse(JSON.stringify(c));
      (copy.team || []).forEach(m => { if (m.rid !== person.rid) { delete m.att; delete m.reason; delete m.why; delete m.attended; } });
      Object.keys(copy.out || {}).forEach(k => {
        const o = copy.out[k];
        if (o && o.who && o.who !== 'spec' && o.who !== person.rid) copy.out[k] = { who: o.who };
      });
      (copy.extra || []).forEach(x => { if (x.rid !== person.rid) delete x.for; });
      delete copy.perf;
      items[id] = copy;
    });
    return Object.assign({}, data, { items: items });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function openStore_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  if (!id) {
    // first run only, from setup() in the editor; requests later always find the Sheet
    const ss = SpreadsheetApp.create(APP_TITLE + ' — Data');
    const sh = ss.getSheets()[0];
    sh.setName(SHEET_DOCS);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    id = ss.getId();
    props.setProperty('SPREADSHEET_ID', id);
  }
  return SpreadsheetApp.openById(id);
}

function currentRev_() {
  return Number(PropertiesService.getScriptProperties().getProperty('REV') || 0);
}

/** Every record: {path: {rev, data}}; a deleted record has data null until the next import. */
function readDocs_() {
  const sh = openStore_().getSheetByName(SHEET_DOCS);
  const values = sh.getDataRange().getValues();
  const out = {};
  values.slice(1).forEach(r => {
    const path = String(r[0] || '').trim();
    if (!path) return;
    const n = Number(r[4]);
    let data = null;
    if (n > 0) {
      try { data = JSON.parse(r.slice(5, 5 + n).join('')); } catch (e) { data = null; }
    }
    out[path] = { rev: Number(r[1]) || 0, data: data };
  });
  return out;
}

function rowFor_(path, rev, now, by, data) {
  const row = [path, String(rev), now, by];
  if (data === null) return row.concat(['0']);
  const json = JSON.stringify(data);
  const parts = [];
  for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  return row.concat([String(parts.length)], parts);
}

/** Read-modify-write of one record under a lock, so edits from several devices apply one at a time. */
function writeDoc_(path, fn) {
  return withLock_(() => {
    const ss = openStore_();
    const sh = ss.getSheetByName(SHEET_DOCS);
    const rowNo = findRow_(sh, path);
    let existing = null, oldWidth = 0;
    if (rowNo) {
      const lastCol = sh.getLastColumn();
      const r = sh.getRange(rowNo, 1, 1, lastCol).getValues()[0];
      const n = Number(r[4]);
      oldWidth = 5 + Math.max(0, n);
      if (n > 0) { try { existing = JSON.parse(r.slice(5, 5 + n).join('')); } catch (e) { existing = null; } }
    }
    const data = fn(existing);
    const props = PropertiesService.getScriptProperties();
    const rev = Number(props.getProperty('REV') || 0) + 1;
    const row = rowFor_(path, rev, nowIso_(), REQUEST_PERSON_ ? REQUEST_PERSON_.name : '', data);
    const width = Math.max(row.length, oldWidth);
    const target = rowNo || sh.getLastRow() + 1;
    if (target > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
    if (width > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    sh.getRange(target, 1, 1, width).setNumberFormat('@').setValues([row.concat(new Array(width - row.length).fill(''))]);
    props.setProperty('REV', String(rev));
    return { path: path, data: data === null ? null : filterFor_(REQUEST_PERSON_, path, data), rev: rev };
  });
}

function findRow_(sh, path) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const hit = sh.getRange(2, 1, last - 1, 1).createTextFinder(path).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function checkPath_(path) {
  const parts = String(path || '').split('/');
  if (parts.length !== 2 || COLLECTIONS.indexOf(parts[0]) < 0 || !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(parts[1])) {
    throw new Error('Not a record this app keeps: ' + path);
  }
}

function deepMerge_(target, patch) {
  const out = JSON.parse(JSON.stringify(target));
  (function merge(t, p) {
    Object.keys(p).forEach(k => {
      const v = p[k];
      if (isObject_(v) && isObject_(t[k])) merge(t[k], v);
      else t[k] = v === undefined ? null : JSON.parse(JSON.stringify(v));
    });
  })(out, patch);
  return out;
}

function isObject_(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// People and access keys (stored in Script Properties, never in the Sheet)
// ---------------------------------------------------------------------------

/** The owner sees everyone's link, so a resident's link can be sent again. */
function listPeople_() {
  requireOwner_();
  return readPeople_().map(p => Object.assign(publicPerson_(p), { key: p.key }));
}

/** Creates a link for a specialist (trainer) or a resident. A new resident link replaces their old one. */
function addPerson_(name, role, rid) {
  requireOwner_();
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw new Error('Enter a name.');
  if (role !== 'trainer' && role !== 'resident') throw new Error('Choose trainer or resident.');
  if (role === 'resident' && !rid) throw new Error('Choose which resident the link is for.');
  if (role === 'resident') withLock_(() => writePeople_(readPeople_().filter(p => !(p.role === 'resident' && p.rid === rid))));
  const p = createPerson_(clean, role, role === 'resident' ? String(rid) : '');
  return Object.assign(publicPerson_(p), { key: p.key });
}

function removePerson_(id) {
  requireOwner_();
  if (REQUEST_PERSON_.id === id) throw new Error('You can’t remove your own access.');
  withLock_(() => writePeople_(readPeople_().filter(p => p.id !== id)));
  return listPeople_();
}

function requireEditor_() {
  if (!REQUEST_PERSON_ || (REQUEST_PERSON_.role !== 'owner' && REQUEST_PERSON_.role !== 'trainer')) throw new Error('VIEW_ONLY');
}

function requireOwner_() {
  if (!REQUEST_PERSON_ || REQUEST_PERSON_.role !== 'owner') throw new Error('Only the owner can do this.');
}

function readPeople_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ACCESS_KEYS');
  const list = parseJson_(raw, []);
  return Array.isArray(list) ? list : [];
}

function writePeople_(list) {
  PropertiesService.getScriptProperties().setProperty('ACCESS_KEYS', JSON.stringify(list));
}

function createPerson_(name, role, rid) {
  if (ROLES.indexOf(role) < 0) throw new Error('Unknown role: ' + role);
  return withLock_(() => {
    const p = {
      id: newId_(),
      name: name,
      role: role,
      rid: rid || '',
      key: (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''),
      createdAt: nowIso_(),
    };
    writePeople_(readPeople_().concat([p]));
    return p;
  });
}

function ownerName_() {
  const email = Session.getEffectiveUser().getEmail() || '';
  return email.split('@')[0] || 'Owner';
}

function findPersonByKey_(key) {
  if (typeof key !== 'string' || key.length < 32) return null;
  return readPeople_().find(p => p.key === key) || null;
}

function publicPerson_(p) {
  return { id: p.id, name: p.name, role: p.role, rid: p.rid || '', createdAt: p.createdAt };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    // Sheets holds writes back until the script ends. Save them before letting the next request in,
    // or it reads the row without this change and overwrites it.
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function nowIso_() {
  return new Date().toISOString();
}

function newId_() {
  return 'u' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function parseJson_(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  try { return JSON.parse(String(v)); } catch (e) { return fallback; }
}
