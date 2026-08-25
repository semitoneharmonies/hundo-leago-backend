const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

async function hashFile(filePath) {
  const bytes = await fs.promises.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function hashTree(rootPath, { ignore = [] } = {}) {
  const root = path.resolve(rootPath);
  const ignored = new Set(ignore.map((item) => item.replaceAll("\\", "/")));
  const rows = [];

  async function visit(currentPath) {
    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path
        .relative(root, fullPath)
        .replaceAll("\\", "/");

      if (ignored.has(relativePath)) continue;

      if (entry.isSymbolicLink()) {
        throw new Error(`hashTree refuses symbolic links: ${relativePath}`);
      }

      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const stat = await fs.promises.stat(fullPath);
      rows.push({
        path: relativePath,
        size: stat.size,
        sha256: await hashFile(fullPath),
      });
    }
  }

  await visit(root);
  return rows;
}

module.exports = { hashFile, hashTree };
