import { access, copyFile, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");
const packaged = path.join(appRoot, "src-tauri", "packaged");

async function requirePath(candidate) {
  await access(candidate).catch(() => {
    throw new Error(`required packaged source is missing: ${candidate}`);
  });
}

async function normalizeTreeNames(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    if (entry.isDirectory()) await normalizeTreeNames(current);
    const normalizedName = entry.name.normalize("NFD");
    if (normalizedName !== entry.name) {
      await rename(current, path.join(root, normalizedName));
    }
  }
}

await mkdir(path.join(packaged, "scripts"), { recursive: true });
for (const name of [
  "models-registry.json",
  "moe-profile.py",
  "galactus-pack-plan.py",
  "galactus-pack-write.py",
  "galactus_pylang.py",
]) {
  const source = path.join(repoRoot, "scripts", name);
  await requirePath(source);
  await copyFile(source, path.join(packaged, "scripts", name));
}

for (const [source, target] of [
  [path.join(appRoot, "skills"), path.join(packaged, "skills")],
  [path.join(repoRoot, "vault"), path.join(packaged, "vault")],
]) {
  await requirePath(source);
  // These folders are generated build inputs. Replacing them prevents a
  // deleted source note or skill from surviving silently in a release.
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, force: true });
  // APFS disk images expose filenames in decomposed Unicode. Signing an app
  // assembled on an external filesystem with composed names makes codesign
  // see each accented vault note as both missing and newly added after the
  // bundle is copied into the DMG. Normalize before signing so both agree.
  await normalizeTreeNames(target);
}

const skillCount = (await readdir(path.join(packaged, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).length;
console.log(`sync-packaged: registry, scripts, vault and ${skillCount} skills are current`);
