const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
} = require("./sourceInventory");

const IMPORT_REPORT_VERSION = 1;
const IMPORT_REPORT_JSON_FILE = "import-report.json";
const IMPORT_REPORT_MARKDOWN_FILE = "import-report.md";

const IMPORT_REPORT_ERROR_CODES = Object.freeze({
  argumentInvalid: "IMPORT_ARGUMENT_INVALID",
  reportFailed: "IMPORT_REPORT_FAILED",
});

class ImportReportError extends Error {
  constructor(code, message, { cause } = {}) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "ImportReportError";
    this.code = code;
  }
}

function reportError(code, message, options) {
  return new ImportReportError(code, message, options);
}

function calculateSemanticReportHash(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report)
  ) {
    throw reportError(
      IMPORT_REPORT_ERROR_CODES.argumentInvalid,
      "An import report object is required."
    );
  }
  const payload = { ...report };
  delete payload.semanticReportHash;
  return crypto
    .createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex");
}

function finalizeImportReport(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report)
  ) {
    throw reportError(
      IMPORT_REPORT_ERROR_CODES.argumentInvalid,
      "An import report object is required."
    );
  }
  const finalized = {
    reportVersion: IMPORT_REPORT_VERSION,
    ...report,
  };
  finalized.semanticReportHash =
    calculateSemanticReportHash(finalized);
  return Object.freeze(finalized);
}

function markdownTable(rows, columns) {
  const header = `| ${columns
    .map((column) => column.label)
    .join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => {
    return `| ${columns
      .map((column) => String(row[column.key]))
      .join(" | ")} |`;
  });
  return [header, divider, ...body].join("\n");
}

function renderImportReportMarkdown(report) {
  const targetRows = report.targetTables || [];
  const omissionRows = report.resetOmissions || [];
  const protectedRows = report.protectedFamilies || [];
  const rejectCodes = (report.rejects || []).map(
    (reject) => reject.code
  );
  const quarantineCodes = (report.quarantine || []).map(
    (entry) => entry.code
  );

  return [
    "# Hundo Leago SQLite Import Report",
    "",
    `Status: \`${report.status}\``,
    "",
    `Dry run: \`${report.dryRun}\``,
    "",
    `Imported rows retained: \`${report.importedRowsRetained}\``,
    "",
    `Source bundle: \`${report.sourceBundle.id}\``,
    "",
    `Source checksum: \`${report.sourceBundle.checksum}\``,
    "",
    `Reset manifest: \`${report.resetManifest.id}\``,
    "",
    `Reset checksum: \`${report.resetManifest.checksum}\``,
    "",
    `Semantic report hash: \`${report.semanticReportHash}\``,
    "",
    "## Target Tables",
    "",
    markdownTable(targetRows, [
      { key: "table", label: "Table" },
      { key: "plannedRowCount", label: "Planned" },
      { key: "validatedRowCount", label: "Validated" },
      { key: "postRollbackRowCount", label: "After rollback" },
      { key: "semanticHash", label: "Semantic hash" },
    ]),
    "",
    "## Reset Omissions",
    "",
    markdownTable(omissionRows, [
      { key: "familyId", label: "Family" },
      { key: "sourceCount", label: "Source count" },
      { key: "targetTreatment", label: "Treatment" },
      { key: "reconciled", label: "Reconciled" },
    ]),
    "",
    "## Protected Families",
    "",
    markdownTable(protectedRows, [
      { key: "familyId", label: "Family" },
      { key: "observedSourceCount", label: "Observed" },
      { key: "plannedTargetRowCount", label: "Planned" },
      { key: "preserved", label: "Preserved" },
    ]),
    "",
    "## Checks",
    "",
    `Integrity: \`${report.checks.integrity}\``,
    "",
    `Foreign-key violations: \`${report.checks.foreignKeyViolationCount}\``,
    "",
    `Ownership reconciliation: \`${report.ownership.reconciled}\``,
    "",
    `Money reconciliation: \`${report.money.reconciled}\``,
    "",
    `Blocking rejects: \`${rejectCodes.length}\`${
      rejectCodes.length
        ? ` (${rejectCodes.join(", ")})`
        : ""
    }`,
    "",
    `Quarantine entries: \`${quarantineCodes.length}\`${
      quarantineCodes.length
        ? ` (${quarantineCodes.join(", ")})`
        : ""
    }`,
    "",
  ].join("\n");
}

function publishImportReport({
  report,
  reportDirectory,
  fsModule = fs,
} = {}) {
  if (
    !report ||
    typeof report !== "object" ||
    typeof reportDirectory !== "string" ||
    reportDirectory.trim() === "" ||
    !fsModule
  ) {
    throw reportError(
      IMPORT_REPORT_ERROR_CODES.argumentInvalid,
      "An import report and new report directory are required."
    );
  }
  const output = path.resolve(reportDirectory);
  if (fsModule.existsSync(output)) {
    throw reportError(
      IMPORT_REPORT_ERROR_CODES.reportFailed,
      "The import report directory already exists."
    );
  }
  const parent = path.dirname(output);
  const temporary = path.join(
    parent,
    `.${path.basename(output)}.building-${crypto.randomUUID()}`
  );
  let ownsTemporary = false;

  try {
    fsModule.mkdirSync(parent, { recursive: true });
    fsModule.mkdirSync(temporary);
    ownsTemporary = true;
    fsModule.writeFileSync(
      path.join(temporary, IMPORT_REPORT_JSON_FILE),
      `${canonicalize(report)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      }
    );
    fsModule.writeFileSync(
      path.join(temporary, IMPORT_REPORT_MARKDOWN_FILE),
      renderImportReportMarkdown(report),
      {
        encoding: "utf8",
        flag: "wx",
      }
    );
    fsModule.renameSync(temporary, output);
    ownsTemporary = false;
  } catch (error) {
    if (ownsTemporary) {
      try {
        fsModule.rmSync(temporary, {
          recursive: true,
          force: true,
        });
      } catch {
        // Preserve the report publication failure.
      }
    }
    if (error instanceof ImportReportError) throw error;
    throw reportError(
      IMPORT_REPORT_ERROR_CODES.reportFailed,
      "The import report could not be published atomically.",
      { cause: error }
    );
  }

  return Object.freeze({
    reportDirectory: output,
    jsonPath: path.join(output, IMPORT_REPORT_JSON_FILE),
    markdownPath: path.join(
      output,
      IMPORT_REPORT_MARKDOWN_FILE
    ),
    semanticReportHash: report.semanticReportHash,
  });
}

module.exports = {
  IMPORT_REPORT_ERROR_CODES,
  IMPORT_REPORT_JSON_FILE,
  IMPORT_REPORT_MARKDOWN_FILE,
  IMPORT_REPORT_VERSION,
  ImportReportError,
  calculateSemanticReportHash,
  finalizeImportReport,
  publishImportReport,
  renderImportReportMarkdown,
};
