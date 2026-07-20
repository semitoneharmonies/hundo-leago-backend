const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_BUNDLE_MANIFEST_VERSION = 1;
const SOURCE_BUNDLE_FILE_NAME = "source-bundle.json";
const SOURCE_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const SOURCE_INVENTORY_ERROR_CODES = Object.freeze({
  argumentInvalid: "INVENTORY_ARGUMENT_INVALID",
  pathUnsafe: "INVENTORY_PATH_UNSAFE",
  sourceUnsupported: "INVENTORY_SOURCE_UNSUPPORTED",
  sourceChanged: "INVENTORY_SOURCE_CHANGED",
  copyMismatch: "INVENTORY_COPY_MISMATCH",
  outputExists: "INVENTORY_OUTPUT_EXISTS",
  bundleInvalid: "INVENTORY_BUNDLE_INVALID",
  operationFailed: "INVENTORY_OPERATION_FAILED",
});

class SourceInventoryError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "SourceInventoryError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function inventoryError(code, message, options) {
  return new SourceInventoryError(code, message, options);
}

function ordinalCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalize(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort(ordinalCompare)
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(bytes) {
  return crypto
    .createHash("sha256")
    .update(bytes)
    .digest("hex");
}

function hashFile(filePath, fsModule = fs) {
  const hash = crypto.createHash("sha256");
  const descriptor = fsModule.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead;
    do {
      bytesRead = fsModule.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null
      );
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fsModule.closeSync(descriptor);
  }

  return hash.digest("hex");
}

function normalizePathForComparison(filePath) {
  const normalized = path.resolve(filePath);
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(firstPath, secondPath) {
  const first = normalizePathForComparison(firstPath);
  const second = normalizePathForComparison(secondPath);
  return (
    first === second ||
    isPathInside(first, second) ||
    isPathInside(second, first)
  );
}

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      `${name} must be a non-negative safe integer.`
    );
  }
}

function normalizeOptionalText(value, name) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 500
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      `${name} must be a non-empty bounded string when provided.`
    );
  }
  return value.trim();
}

function lstatBigInt(filePath, fsModule) {
  try {
    return fsModule.lstatSync(filePath, { bigint: true });
  } catch (error) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      "A source path could not be inspected.",
      { cause: error }
    );
  }
}

function assertSupportedStat(stat, filePath) {
  if (stat.isSymbolicLink()) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.pathUnsafe,
      "Symbolic links and junctions are not supported.",
      { details: { filePath } }
    );
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.sourceUnsupported,
      "A source contains an unsupported filesystem entry.",
      { details: { filePath } }
    );
  }
}

function toSafeNumber(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.sourceUnsupported,
      `${name} exceeds the supported integer range.`
    );
  }
  return number;
}

function inspectSourceTree(source, fsModule) {
  const files = [];
  const directories = [];

  function visit(absolutePath, relativePath) {
    const stat = lstatBigInt(absolutePath, fsModule);
    assertSupportedStat(stat, absolutePath);
    const modifiedAtNs = stat.mtimeNs.toString();
    const modifiedAtMs = toSafeNumber(
      stat.mtimeNs / 1_000_000n,
      "Source modification time"
    );

    if (stat.isDirectory()) {
      directories.push({
        relativePath,
        modifiedAtMs,
        modifiedAtNs,
      });
      const names = fsModule
        .readdirSync(absolutePath)
        .sort(ordinalCompare);
      for (const name of names) {
        visit(
          path.join(absolutePath, name),
          relativePath
            ? path.join(relativePath, name)
            : name
        );
      }
      return;
    }

    files.push({
      absolutePath,
      relativePath:
        relativePath || path.basename(absolutePath),
      byteSize: toSafeNumber(stat.size, "Source byte size"),
      modifiedAtMs,
      modifiedAtNs,
      sha256: hashFile(absolutePath, fsModule),
    });
  }

  visit(
    source.absolutePath,
    source.kind === "file"
      ? path.basename(source.absolutePath)
      : ""
  );

  files.sort((left, right) => {
    return ordinalCompare(left.relativePath, right.relativePath);
  });
  directories.sort((left, right) => {
    return ordinalCompare(left.relativePath, right.relativePath);
  });

  return {
    directories,
    files,
  };
}

function stabilityDescriptor(tree) {
  return {
    directories: tree.directories.map(
      ({ relativePath, modifiedAtNs }) => ({
        relativePath,
        modifiedAtNs,
      })
    ),
    files: tree.files.map(
      ({
        relativePath,
        byteSize,
        modifiedAtNs,
        sha256,
      }) => ({
        relativePath,
        byteSize,
        modifiedAtNs,
        sha256,
      })
    ),
  };
}

function toPortablePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function analyzeJsonFile(filePath, fsModule) {
  if (!filePath.toLowerCase().endsWith(".json")) {
    return Object.freeze({
      parseStatus: "not_applicable",
      topLevelShape: "not_json",
      topLevelArrayCount: null,
      directArrayCounts: Object.freeze({}),
      errorCode: null,
    });
  }

  try {
    const parsed = JSON.parse(
      fsModule.readFileSync(filePath, "utf8")
    );
    let topLevelShape;
    let topLevelArrayCount = null;
    const directArrayCounts = {};

    if (Array.isArray(parsed)) {
      topLevelShape = "array";
      topLevelArrayCount = parsed.length;
    } else if (parsed === null) {
      topLevelShape = "null";
    } else if (typeof parsed === "object") {
      topLevelShape = "object";
      for (const key of Object.keys(parsed).sort(ordinalCompare)) {
        if (Array.isArray(parsed[key])) {
          directArrayCounts[key] = parsed[key].length;
        }
      }
    } else {
      topLevelShape = typeof parsed;
    }

    return Object.freeze({
      parseStatus: "parsed",
      topLevelShape,
      topLevelArrayCount,
      directArrayCounts: Object.freeze(directArrayCounts),
      errorCode: null,
    });
  } catch {
    return Object.freeze({
      parseStatus: "failed",
      topLevelShape: "unknown",
      topLevelArrayCount: null,
      directArrayCounts: Object.freeze({}),
      errorCode: "JSON_PARSE_FAILED",
    });
  }
}

function normalizeSources(sources, outputDirectory, fsModule) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      "At least one explicitly named source is required."
    );
  }

  const labels = new Set();
  const physicalPaths = new Set();
  const normalized = sources.map((source) => {
    if (
      !source ||
      typeof source !== "object" ||
      !SOURCE_LABEL_PATTERN.test(source.label || "") ||
      typeof source.path !== "string" ||
      source.path.trim() === ""
    ) {
      throw inventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
        "Each source requires a safe unique label and path."
      );
    }
    if (labels.has(source.label)) {
      throw inventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
        "Source labels must be unique."
      );
    }
    labels.add(source.label);

    const requestedPath = path.resolve(source.path.trim());
    const requestedStat = lstatBigInt(requestedPath, fsModule);
    assertSupportedStat(requestedStat, requestedPath);
    const absolutePath = fsModule.realpathSync.native(
      requestedPath
    );
    const comparisonPath =
      normalizePathForComparison(absolutePath);
    if (physicalPaths.has(comparisonPath)) {
      throw inventoryError(
        SOURCE_INVENTORY_ERROR_CODES.pathUnsafe,
        "Physical source paths must be unique."
      );
    }
    physicalPaths.add(comparisonPath);

    if (pathsOverlap(absolutePath, outputDirectory)) {
      throw inventoryError(
        SOURCE_INVENTORY_ERROR_CODES.pathUnsafe,
        "Source and output paths must not overlap."
      );
    }

    return Object.freeze({
      label: source.label,
      absolutePath,
      kind: requestedStat.isDirectory()
        ? "directory"
        : "file",
    });
  });

  normalized.sort((left, right) => {
    return ordinalCompare(left.label, right.label);
  });
  for (let first = 0; first < normalized.length; first += 1) {
    for (
      let second = first + 1;
      second < normalized.length;
      second += 1
    ) {
      if (
        pathsOverlap(
          normalized[first].absolutePath,
          normalized[second].absolutePath
        )
      ) {
        throw inventoryError(
          SOURCE_INVENTORY_ERROR_CODES.pathUnsafe,
          "Source paths must not overlap each other."
        );
      }
    }
  }

  return Object.freeze(normalized);
}

function normalizeOutputDirectory(outputDirectory, fsModule) {
  if (
    typeof outputDirectory !== "string" ||
    outputDirectory.trim() === ""
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      "An explicit new output directory is required."
    );
  }

  const requestedOutput = path.resolve(outputDirectory.trim());
  if (fsModule.existsSync(requestedOutput)) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.outputExists,
      "The source-bundle output already exists."
    );
  }

  const requestedParent = path.dirname(requestedOutput);
  if (!fsModule.existsSync(requestedParent)) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      "The source-bundle parent directory must already exist."
    );
  }
  const parentStat = lstatBigInt(requestedParent, fsModule);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory()
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.pathUnsafe,
      "The source-bundle parent must be a real directory."
    );
  }

  const parentPath = fsModule.realpathSync.native(requestedParent);
  const outputPath = path.join(
    parentPath,
    path.basename(requestedOutput)
  );
  if (fsModule.existsSync(outputPath)) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.outputExists,
      "The source-bundle output already exists."
    );
  }

  return outputPath;
}

function buildContentDescriptor(manifestPayload) {
  return {
    manifestVersion: manifestPayload.manifestVersion,
    sources: manifestPayload.sources.map((source) => ({
      label: source.label,
      kind: source.kind,
      files: source.files.map((file) => ({
        copiedPath: file.copiedPath,
        byteSize: file.byteSize,
        sha256: file.sha256,
        json: file.json,
      })),
    })),
  };
}

function calculateSourceBundleId(manifestPayload) {
  const descriptor = buildContentDescriptor(manifestPayload);
  return (
    "source-bundle-v1-" +
    sha256Bytes(Buffer.from(canonicalize(descriptor), "utf8"))
  );
}

function calculateBundleChecksum(manifestWithoutChecksum) {
  return sha256Bytes(
    Buffer.from(canonicalize(manifestWithoutChecksum), "utf8")
  );
}

function assertCopiedFile(
  sourceFile,
  copiedPath,
  fsModule
) {
  const copiedStat = lstatBigInt(copiedPath, fsModule);
  if (
    copiedStat.isSymbolicLink() ||
    !copiedStat.isFile()
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.copyMismatch,
      "A copied source is not a regular file."
    );
  }
  const copiedByteSize = toSafeNumber(
    copiedStat.size,
    "Copied byte size"
  );
  const copiedHash = hashFile(copiedPath, fsModule);
  if (
    copiedByteSize !== sourceFile.byteSize ||
    copiedHash !== sourceFile.sha256
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.copyMismatch,
      "A copied source does not match its source bytes."
    );
  }
}

function createTemporaryOutputPath(outputDirectory) {
  return path.join(
    path.dirname(outputDirectory),
    `.${path.basename(outputDirectory)}.building-` +
      `${process.pid}-${crypto.randomUUID()}`
  );
}

function cleanupTemporaryDirectory(
  temporaryDirectory,
  outputDirectory,
  fsModule
) {
  if (!temporaryDirectory) return;

  const expectedParent = path.dirname(outputDirectory);
  const expectedPrefix = `.${path.basename(
    outputDirectory
  )}.building-`;
  if (
    path.dirname(temporaryDirectory) !== expectedParent ||
    !path.basename(temporaryDirectory).startsWith(expectedPrefix)
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.pathUnsafe,
      "Refusing to clean an unowned temporary path."
    );
  }

  if (fsModule.existsSync(temporaryDirectory)) {
    fsModule.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

function inventorySourceBundle({
  sources,
  outputDirectory,
  capturedAtMs,
  applicationBuildId,
  sourceGitCommit,
  fsModule = fs,
  copyFile = (sourcePath, targetPath) => {
    fsModule.copyFileSync(sourcePath, targetPath);
  },
  renameDirectory = (sourcePath, targetPath) => {
    fsModule.renameSync(sourcePath, targetPath);
  },
} = {}) {
  assertSafeInteger(capturedAtMs, "capturedAtMs");
  const buildId = normalizeOptionalText(
    applicationBuildId,
    "applicationBuildId"
  );
  const gitCommit = normalizeOptionalText(
    sourceGitCommit,
    "sourceGitCommit"
  );
  const normalizedOutput = normalizeOutputDirectory(
    outputDirectory,
    fsModule
  );
  const normalizedSources = normalizeSources(
    sources,
    normalizedOutput,
    fsModule
  );
  const initialTrees = new Map(
    normalizedSources.map((source) => [
      source.label,
      inspectSourceTree(source, fsModule),
    ])
  );
  const temporaryDirectory =
    createTemporaryOutputPath(normalizedOutput);
  const copiedPaths = new Set();

  try {
    fsModule.mkdirSync(temporaryDirectory);
    const filesDirectory = path.join(
      temporaryDirectory,
      "files"
    );
    fsModule.mkdirSync(filesDirectory);
    const manifestSources = [];

    for (const source of normalizedSources) {
      const sourceOutput = path.join(
        filesDirectory,
        source.label
      );
      fsModule.mkdirSync(sourceOutput);
      const tree = initialTrees.get(source.label);
      const manifestFiles = [];

      for (const sourceFile of tree.files) {
        const destinationRelativePath = path.join(
          "files",
          source.label,
          sourceFile.relativePath
        );
        const portableDestination =
          toPortablePath(destinationRelativePath);
        const foldedDestination =
          portableDestination.toLowerCase();
        if (copiedPaths.has(foldedDestination)) {
          throw inventoryError(
            SOURCE_INVENTORY_ERROR_CODES.pathUnsafe,
            "Copied source paths collide by case."
          );
        }
        copiedPaths.add(foldedDestination);

        const destinationPath = path.join(
          temporaryDirectory,
          destinationRelativePath
        );
        fsModule.mkdirSync(path.dirname(destinationPath), {
          recursive: true,
        });
        copyFile(sourceFile.absolutePath, destinationPath);
        assertCopiedFile(
          sourceFile,
          destinationPath,
          fsModule
        );

        manifestFiles.push({
          sourceRelativePath: toPortablePath(
            sourceFile.relativePath
          ),
          copiedPath: portableDestination,
          byteSize: sourceFile.byteSize,
          modifiedAtMs: sourceFile.modifiedAtMs,
          sha256: sourceFile.sha256,
          json: analyzeJsonFile(
            destinationPath,
            fsModule
          ),
        });
      }

      const rootStat = lstatBigInt(
        source.absolutePath,
        fsModule
      );
      manifestSources.push({
        label: source.label,
        absolutePath: source.absolutePath,
        kind: source.kind,
        byteSize: manifestFiles.reduce(
          (total, file) => total + file.byteSize,
          0
        ),
        modifiedAtMs: toSafeNumber(
          rootStat.mtimeNs / 1_000_000n,
          "Source modification time"
        ),
        files: manifestFiles,
      });
    }

    for (const source of normalizedSources) {
      const finalTree = inspectSourceTree(source, fsModule);
      if (
        canonicalize(stabilityDescriptor(finalTree)) !==
        canonicalize(
          stabilityDescriptor(initialTrees.get(source.label))
        )
      ) {
        throw inventoryError(
          SOURCE_INVENTORY_ERROR_CODES.sourceChanged,
          "A source changed while the bundle was captured.",
          { details: { label: source.label } }
        );
      }
    }

    const payloadWithoutId = {
      manifestVersion: SOURCE_BUNDLE_MANIFEST_VERSION,
      capturedAtMs,
      applicationBuildId: buildId,
      sourceGitCommit: gitCommit,
      sources: manifestSources,
    };
    const sourceBundleId =
      calculateSourceBundleId(payloadWithoutId);
    const manifestWithoutChecksum = {
      ...payloadWithoutId,
      sourceBundleId,
    };
    const manifest = {
      ...manifestWithoutChecksum,
      bundleChecksum: calculateBundleChecksum(
        manifestWithoutChecksum
      ),
    };
    fsModule.writeFileSync(
      path.join(
        temporaryDirectory,
        SOURCE_BUNDLE_FILE_NAME
      ),
      `${canonicalize(manifest)}\n`,
      "utf8"
    );

    verifySourceBundle({
      bundleDirectory: temporaryDirectory,
      fsModule,
    });
    renameDirectory(temporaryDirectory, normalizedOutput);

    return {
      bundleDirectory: normalizedOutput,
      manifest,
    };
  } catch (error) {
    cleanupTemporaryDirectory(
      temporaryDirectory,
      normalizedOutput,
      fsModule
    );
    if (error instanceof SourceInventoryError) {
      throw error;
    }
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.operationFailed,
      "The source inventory operation failed.",
      { cause: error }
    );
  }
}

function parseBundleManifest(bundleDirectory, fsModule) {
  let manifest;
  try {
    manifest = JSON.parse(
      fsModule.readFileSync(
        path.join(
          bundleDirectory,
          SOURCE_BUNDLE_FILE_NAME
        ),
        "utf8"
      )
    );
  } catch (error) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "The source-bundle manifest is unreadable.",
      { cause: error }
    );
  }

  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.manifestVersion !==
      SOURCE_BUNDLE_MANIFEST_VERSION ||
    !Array.isArray(manifest.sources) ||
    typeof manifest.sourceBundleId !== "string" ||
    typeof manifest.bundleChecksum !== "string"
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "The source-bundle manifest shape is invalid."
    );
  }

  return manifest;
}

function resolveCopiedPath(
  bundleDirectory,
  copiedPath
) {
  if (
    typeof copiedPath !== "string" ||
    copiedPath.includes("\\")
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "A copied bundle path is invalid."
    );
  }
  const segments = copiedPath.split("/");
  if (
    segments.length < 3 ||
    segments[0] !== "files" ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    )
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "A copied bundle path is unsafe."
    );
  }

  const resolved = path.resolve(bundleDirectory, ...segments);
  if (!isPathInside(bundleDirectory, resolved)) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "A copied bundle path escapes the bundle."
    );
  }
  return resolved;
}

function listBundleFiles(
  bundleDirectory,
  fsModule
) {
  const files = [];

  function visit(directoryPath, relativePath) {
    const names = fsModule
      .readdirSync(directoryPath)
      .sort(ordinalCompare);
    for (const name of names) {
      const absolutePath = path.join(directoryPath, name);
      const childRelative = relativePath
        ? path.join(relativePath, name)
        : name;
      const stat = lstatBigInt(absolutePath, fsModule);
      if (stat.isSymbolicLink()) {
        throw inventoryError(
          SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
          "A source bundle contains a symbolic link."
        );
      }
      if (stat.isDirectory()) {
        visit(absolutePath, childRelative);
      } else if (stat.isFile()) {
        files.push(toPortablePath(childRelative));
      } else {
        throw inventoryError(
          SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
          "A source bundle contains an unsupported entry."
        );
      }
    }
  }

  visit(bundleDirectory, "");
  return files.sort(ordinalCompare);
}

function verifySourceBundle({
  bundleDirectory,
  fsModule = fs,
} = {}) {
  if (
    typeof bundleDirectory !== "string" ||
    bundleDirectory.trim() === ""
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid,
      "An explicit source-bundle directory is required."
    );
  }

  const requestedDirectory = path.resolve(
    bundleDirectory.trim()
  );
  const rootStat = lstatBigInt(requestedDirectory, fsModule);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory()
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "The source bundle must be a real directory."
    );
  }
  const root = fsModule.realpathSync.native(requestedDirectory);
  const manifest = parseBundleManifest(root, fsModule);
  const {
    bundleChecksum,
    ...manifestWithoutChecksum
  } = manifest;
  if (
    calculateBundleChecksum(manifestWithoutChecksum) !==
    bundleChecksum
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "The source-bundle manifest checksum is invalid."
    );
  }
  if (
    calculateSourceBundleId(manifestWithoutChecksum) !==
    manifest.sourceBundleId
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "The source-bundle content ID is invalid."
    );
  }

  const expectedFiles = new Set([
    SOURCE_BUNDLE_FILE_NAME,
  ]);
  const copiedPaths = new Set();
  let fileCount = 0;
  let byteSize = 0;

  for (const source of manifest.sources) {
    if (
      !source ||
      !SOURCE_LABEL_PATTERN.test(source.label || "") ||
      !["file", "directory"].includes(source.kind) ||
      typeof source.absolutePath !== "string" ||
      !path.isAbsolute(source.absolutePath) ||
      !Array.isArray(source.files)
    ) {
      throw inventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
        "A source-bundle source entry is invalid."
      );
    }

    for (const file of source.files) {
      if (
        !file ||
        !Number.isSafeInteger(file.byteSize) ||
        file.byteSize < 0 ||
        !Number.isSafeInteger(file.modifiedAtMs) ||
        file.modifiedAtMs < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 || "") ||
        !file.json ||
        typeof file.json !== "object"
      ) {
        throw inventoryError(
          SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
          "A source-bundle file entry is invalid."
        );
      }
      const foldedPath = file.copiedPath?.toLowerCase();
      if (!foldedPath || copiedPaths.has(foldedPath)) {
        throw inventoryError(
          SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
          "Source-bundle copied paths must be unique."
        );
      }
      copiedPaths.add(foldedPath);
      expectedFiles.add(file.copiedPath);

      const copiedPath = resolveCopiedPath(
        root,
        file.copiedPath
      );
      const stat = lstatBigInt(copiedPath, fsModule);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        toSafeNumber(stat.size, "Bundle byte size") !==
          file.byteSize ||
        hashFile(copiedPath, fsModule) !== file.sha256 ||
        canonicalize(
          analyzeJsonFile(copiedPath, fsModule)
        ) !== canonicalize(file.json)
      ) {
        throw inventoryError(
          SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
          "A copied source file failed verification."
        );
      }
      fileCount += 1;
      byteSize += file.byteSize;
    }
  }

  const actualFiles = listBundleFiles(root, fsModule);
  const expectedFileList = [...expectedFiles].sort(
    ordinalCompare
  );
  if (
    actualFiles.length !== expectedFileList.length ||
    actualFiles.some((fileName, index) => {
      return fileName !== expectedFileList[index];
    })
  ) {
    throw inventoryError(
      SOURCE_INVENTORY_ERROR_CODES.bundleInvalid,
      "The source bundle contains missing or unexpected files."
    );
  }

  return Object.freeze({
    sourceBundleId: manifest.sourceBundleId,
    bundleChecksum: manifest.bundleChecksum,
    sourceCount: manifest.sources.length,
    fileCount,
    byteSize,
  });
}

module.exports = {
  SOURCE_BUNDLE_FILE_NAME,
  SOURCE_BUNDLE_MANIFEST_VERSION,
  SOURCE_INVENTORY_ERROR_CODES,
  SOURCE_LABEL_PATTERN,
  SourceInventoryError,
  calculateBundleChecksum,
  calculateSourceBundleId,
  canonicalize,
  inventorySourceBundle,
  verifySourceBundle,
};
