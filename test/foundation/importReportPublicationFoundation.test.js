const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const { finalizeImportReport, renderImportReportMarkdown } = require("../../src/infrastructure/migration/importReport");
const { canonicalize } = require("../../src/infrastructure/migration/sourceInventory");

const implementation = path.resolve(__dirname, "../../src/infrastructure/migration/importReport.js");
const reportDirectory = path.join(__dirname, "virtual-report-publication");
const report = finalizeImportReport({
  status: "synthetic", dryRun: true, importedRowsRetained: false,
  sourceBundle: { id: "synthetic-input", checksum: "a".repeat(64) },
  resetManifest: { id: "synthetic-reset", checksum: "b".repeat(64) },
  targetTables: [], resetOmissions: [], protectedFamilies: [], rejects: [], quarantine: [],
  checks: { integrity: "ok", foreignKeyViolationCount: 0 },
  ownership: { reconciled: true }, money: { reconciled: true },
});

function fixture({ platform = "win32", renameFailure, afterWait } = {}) {
  const directories = new Set(), files = new Map(), waits = [], writes = [];
  let renameCalls = 0, removed = 0, temporary;
  const moduleRecord = { exports: {} };
  vm.runInNewContext(fs.readFileSync(implementation, "utf8"), {
    module: moduleRecord, exports: moduleRecord.exports,
    require: createRequire(implementation), process: { platform },
    SharedArrayBuffer, Int32Array,
    Atomics: { wait(_array, _index, _value, milliseconds) {
      waits.push(milliseconds); afterWait?.({ directories, files, temporary, waits });
      return "timed-out";
    } },
  }, { filename: implementation });
  const fsModule = {
    existsSync(file) { return directories.has(file) || files.has(file); },
    mkdirSync(directory) {
      directories.add(directory);
      if (path.basename(directory).includes(".building-")) temporary = directory;
    },
    writeFileSync(file, contents, options) {
      assert.equal(options.flag, "wx"); assert(!files.has(file));
      files.set(file, contents); writes.push({ file, contents });
    },
    renameSync(from, to) {
      renameCalls++;
      const failure = renameFailure?.(renameCalls); if (failure) throw failure;
      if (!directories.has(from)) throw Object.assign(new Error("missing fixture source"), { code: "ENOENT" });
      assert(!directories.has(to), "A report destination must not be replaced.");
      directories.delete(from); directories.add(to);
      for (const [file, contents] of [...files]) if (path.dirname(file) === from) {
        files.delete(file); files.set(path.join(to, path.basename(file)), contents);
      }
    },
    rmSync(directory, options) {
      assert.equal(directory, temporary); assert.equal(options.recursive, true); assert.equal(options.force, true);
      removed++; directories.delete(directory);
      for (const file of files.keys()) if (path.dirname(file) === directory) files.delete(file);
    },
  };
  return {
    directories, files, waits, writes,
    publish() { return moduleRecord.exports.publishImportReport({ report, reportDirectory, fsModule }); },
    get renameCalls() { return renameCalls; }, get removed() { return removed; },
  };
}

test("a temporary Windows report rename denial reuses the two completed report files", () => {
  const denied = Object.assign(new Error("temporary fixture denial"), { code: "EPERM" });
  const f = fixture({ renameFailure: call => call < 3 ? denied : null });
  const published = f.publish();
  assert.equal(f.renameCalls, 3); assert.deepEqual(f.waits, [10, 20]);
  assert.equal(f.writes.length, 2); assert.equal(f.removed, 0);
  assert.equal(f.files.get(published.jsonPath), canonicalize(report) + "\n");
  assert.equal(f.files.get(published.markdownPath), renderImportReportMarkdown(report));
  assert.equal(published.semanticReportHash, report.semanticReportHash);
});

test("a permanent Windows report rename denial stops after the bounded wait and preserves its cause", () => {
  const denied = Object.assign(new Error("permanent fixture denial"), { code: "EPERM" });
  const f = fixture({ renameFailure: () => denied });
  assert.throws(() => f.publish(), error => error.code === "IMPORT_REPORT_FAILED" && error.cause === denied);
  assert.equal(f.renameCalls, 4); assert.deepEqual(f.waits, [10, 20, 40]);
  assert.equal(f.writes.length, 2); assert.equal(f.removed, 1);
  assert.equal(f.files.size, 0); assert(!f.directories.has(reportDirectory));
});

test("a report destination appearing during the Windows wait remains untouched", () => {
  const denied = Object.assign(new Error("temporary fixture denial"), { code: "EPERM" });
  const f = fixture({ renameFailure: () => denied, afterWait({ directories, files }) {
    directories.add(reportDirectory); files.set(path.join(reportDirectory, "existing.txt"), "preserve me");
  } });
  assert.throws(() => f.publish(), error => error.code === "IMPORT_REPORT_FAILED" && error.cause === denied);
  assert.equal(f.renameCalls, 1); assert.deepEqual(f.waits, [10]);
  assert.equal(f.files.size, 1); assert.equal(f.files.get(path.join(reportDirectory, "existing.txt")), "preserve me");
  assert.equal(f.removed, 1);
});

test("other report rename errors fail immediately without rewriting the report", () => {
  for (const code of ["EIO", "EACCES", "ENOENT", "EEXIST"]) {
    const failure = Object.assign(new Error("fixture error"), { code });
    const f = fixture({ renameFailure: () => failure });
    assert.throws(() => f.publish(), error => error.code === "IMPORT_REPORT_FAILED" && error.cause === failure);
    assert.equal(f.renameCalls, 1); assert.deepEqual(f.waits, []); assert.equal(f.writes.length, 2); assert.equal(f.removed, 1);
  }
});

test("Linux report rename denial keeps the original immediate failure behavior", () => {
  const denied = Object.assign(new Error("fixture denial"), { code: "EPERM" });
  const f = fixture({ platform: "linux", renameFailure: () => denied });
  assert.throws(() => f.publish(), error => error.code === "IMPORT_REPORT_FAILED" && error.cause === denied);
  assert.equal(f.renameCalls, 1); assert.deepEqual(f.waits, []); assert.equal(f.removed, 1);
});

test("a pre-existing report destination is rejected before creating temporary files", () => {
  const f = fixture(); f.directories.add(reportDirectory);
  assert.throws(() => f.publish(), error => error.code === "IMPORT_REPORT_FAILED");
  assert.equal(f.renameCalls, 0); assert.equal(f.writes.length, 0); assert.equal(f.removed, 0); assert.deepEqual(f.waits, []);
});

test("a vanished temporary report is not rebuilt or retried after a different error", () => {
  const denied = Object.assign(new Error("temporary fixture denial"), { code: "EPERM" });
  const f = fixture({ renameFailure: call => call === 1 ? denied : null, afterWait({ directories, temporary }) { directories.delete(temporary); } });
  assert.throws(() => f.publish(), error => error.code === "IMPORT_REPORT_FAILED" && error.cause?.code === "ENOENT");
  assert.equal(f.renameCalls, 2); assert.deepEqual(f.waits, [10]); assert.equal(f.writes.length, 2); assert.equal(f.removed, 1);
});
