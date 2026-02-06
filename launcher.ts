import { dirname, join, toFileUrl } from "@std/path";
import { copy, emptyDir, ensureDir } from "@std/fs";
import * as zip_ts from "@fakoua/zip-ts";
import { bundle } from "@deno/emit";

// Get the repo from sourceRepo from config, defaults to palmmc/SuperModel.
const config = await readLauncherConfig();
const sourceRepo = config?.sourceRepo ?? "LichenTown/SuperModel";
const REPO_URL = `https://github.com/${sourceRepo}/archive/refs/heads/main.zip`;

const ROOT_DIR = dirname(Deno.execPath());
// Launcher paths
const LOG_FILE = join(ROOT_DIR, "supermodel.log");
const LAUNCHER_DIR = join(ROOT_DIR, ".launcher");
const CACHE_DIR = join(LAUNCHER_DIR, "cache");
const CACHE_PATH = join(CACHE_DIR, "repo.zip");
const META_PATH = join(CACHE_DIR, "repo.json");
const BUNDLE_CACHE_DIR = join(LAUNCHER_DIR, "bundle-cache");
const PACK_CACHE_DIR = join(LAUNCHER_DIR, "pack-cache");
const PACK_ZIP_PATH = join(PACK_CACHE_DIR, "pack.zip");
const PACK_META_PATH = join(PACK_CACHE_DIR, "pack.json");

async function downloadLatestRepo() {
    await ensureDir(CACHE_DIR);

    const meta = await readJson<{ etag?: string }>(META_PATH);
    const headers = new Headers();
    if (meta?.etag) headers.set("If-None-Match", meta.etag);

    console.log("Downloading latest source...");
    const res = await fetch(REPO_URL, { headers });

    if (res.status === 304) {
        console.log("Source is already up to date.");
    } else if (res.ok) {
        const srcData = new Uint8Array(await res.arrayBuffer());
        await Deno.writeFile(CACHE_PATH, srcData);
        const etag = res.headers.get("etag") ?? undefined;
        await Deno.writeTextFile(META_PATH, JSON.stringify({ etag, updatedAt: new Date().toISOString() }, null, 2));
    } else {
        console.error(`Failed to download updated source (${res.status}).`);
        Deno.exit(1);
    }

    const srcExists = await Deno.stat(CACHE_PATH).then(() => true).catch(() => false);
    if (!srcExists) {
        console.error("Source cache is missing.");
        Deno.exit(1);
    }

    const tempDir = await Deno.makeTempDir({ prefix: "supermodel-" });
    await unzipFolder(CACHE_PATH, tempDir, "source repo");

    const extractedRoot = await findExtractedRoot(tempDir);
    await copyRepoContents(extractedRoot, ROOT_DIR);

    // Check configuration.
    await mergeConfig(extractedRoot, ROOT_DIR);
    // Check that minecraft version is valid.
    await ensureMinecraftVersion(ROOT_DIR);

    // Patch main 600 times because I love how deno build works!1!!!!1
    await ensureMainRunExport();
    await ensureItemModelPatches();

    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
}

async function syncResourcePackWithPrompt() {
    const config = await readLauncherConfig();
    const { repo, branch } = resolveResourcePackTarget(config);
    if (!repo) return;

    console.log(`Preparing resource pack sync from ${repo}${branch ? ` (${branch})` : ""}...`);

    const packDir = join(ROOT_DIR, "pack");
    const packExists = await Deno.stat(packDir).then(s => s.isDirectory).catch(() => false);
    const packMeta = await readJson<{ etag?: string; commitHash?: string }>(PACK_META_PATH);
    const latestCommitHash = await fetchLatestPackCommitHash(repo, branch);

    if (latestCommitHash && packMeta?.commitHash && latestCommitHash === packMeta.commitHash && packExists) {
        console.log(`Resource pack is already up to date (${latestCommitHash.slice(0, 7)}).`);
        return;
    }

    const { changed, zipPath } = await fetchResourcePackArchive(repo, branch, latestCommitHash);
    if (!changed && packExists) {
        console.log("Resource pack is already up to date.");
        return;
    }

    const action = await promptResourcePackUpdate();
    if (action === "ignore") return;

    const overwrite = action === "overwrite";
    await applyResourcePackArchive(zipPath, packDir, overwrite);
    console.log("Resource pack sync complete.");
}

async function readLauncherConfig(): Promise<{ sourceRepo?: string; resourcePackRepo?: string } | undefined> {
    try {
        const configPath = join(ROOT_DIR, "config.json");
        const raw = await Deno.readTextFile(configPath);
        return JSON.parse(raw) as { sourceRepo?: string; resourcePackRepo?: string };
    } catch (err) {
        console.warn("Failed to read config.json:", err);
        return undefined;
    }
}

function resolveResourcePackTarget(config?: { resourcePackRepo?: string; resourcePackBranch?: string }): { repo?: string; branch?: string } {
    if (!config?.resourcePackRepo) return {};
    const trimmed = config.resourcePackRepo.trim();
    if (!trimmed) return {};

    let repo = trimmed;
    let branch = config.resourcePackBranch?.trim();

    const hashIndex = repo.indexOf("#");
    if (hashIndex >= 0) {
        const parsedRepo = repo.slice(0, hashIndex);
        const parsedBranch = repo.slice(hashIndex + 1);
        repo = parsedRepo;
        if (parsedBranch) branch = parsedBranch;
    }

    if (repo.startsWith("http://") || repo.startsWith("https://")) {
        try {
            const url = new URL(repo);
            const parts = url.pathname.replace(/^\//, "").split("/");
            if (parts.length >= 2) repo = `${parts[0]}/${parts[1]}`;
        } catch {
            return {};
        }
    }

    return { repo, branch };
}

async function fetchResourcePackArchive(repo: string, branch?: string, latestCommitHash?: string, forceDownload = false): Promise<{ changed: boolean; zipPath: string }> {
    await ensureDir(PACK_CACHE_DIR);

    let meta = await readJson<{ etag?: string; commitHash?: string }>(PACK_META_PATH);
    if (forceDownload) meta = undefined;
    if (latestCommitHash && meta?.commitHash && latestCommitHash !== meta.commitHash) {
        meta = undefined;
    }

    const headers = new Headers();
    if (meta?.etag) headers.set("If-None-Match", meta.etag);

    console.log(`Downloading resource pack archive for ${repo}${branch ? ` (${branch})` : ""}...`);

    const targetBranch = branch || "main";
    const primary = await fetchResourcePackZip(repo, targetBranch, headers);
    const primaryResult = await handleResourcePackResponse(repo, targetBranch, primary, latestCommitHash, meta?.commitHash);
    if (primaryResult) return primaryResult;

    if (!branch) {
        const fallbackBranch = "master";
        console.warn(`Primary branch "${targetBranch}" failed, falling back to "${fallbackBranch}"...`);
        const fallback = await fetchResourcePackZip(repo, fallbackBranch, headers);
        const fallbackResult = await handleResourcePackResponse(repo, fallbackBranch, fallback, latestCommitHash, meta?.commitHash);
        if (fallbackResult) return fallbackResult;
    }

    console.error("Failed to download resource pack archive.");
    Deno.exit(1);
}

async function fetchResourcePackZip(repo: string, branch: string, headers: Headers): Promise<Response> {
    const url = `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`;
    return await fetch(url, { headers });
}

async function handleResourcePackResponse(
    repo: string,
    branch: string,
    res: Response,
    latestCommitHash?: string,
    cachedCommitHash?: string
): Promise<{ changed: boolean; zipPath: string } | undefined> {
    if (res.status === 304) {
        console.log(`Resource pack not modified (${repo}@${branch}).`);
        const zipExists = await Deno.stat(PACK_ZIP_PATH).then(() => true).catch(() => false);
        if (!zipExists) {
            console.warn("ETag indicates not modified, but cached zip is missing.");
            return undefined;
        }
        return { changed: false, zipPath: PACK_ZIP_PATH };
    }

    if (!res.ok) {
        console.warn(`Resource pack download failed for ${repo}@${branch} (${res.status}).`);
        return undefined;
    }

    const data = new Uint8Array(await res.arrayBuffer());
    if (!isZipBuffer(data)) {
        logNonZipResponse(repo, branch, data, res.headers.get("content-type") ?? undefined);
        return undefined;
    }

    console.log(`Resource pack archive downloaded (${Math.round(data.length / 1024)} KB).`);
    await Deno.writeFile(PACK_ZIP_PATH, data);
    const etag = res.headers.get("etag") ?? undefined;
    const commitHashToStore = latestCommitHash ?? cachedCommitHash;
    await Deno.writeTextFile(
        PACK_META_PATH,
        JSON.stringify({ etag, updatedAt: new Date().toISOString(), commitHash: commitHashToStore }, null, 2)
    );
    return { changed: true, zipPath: PACK_ZIP_PATH };
}

async function fetchLatestPackCommitHash(repo: string, branch?: string): Promise<string | undefined> {
    const targetBranch = branch || "main";
    const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(targetBranch)}`;
    try {
        const res = await fetch(url, {
            headers: {
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28"
            }
        });
        if (!res.ok) {
            console.warn(`Unable to fetch latest commit hash for ${repo}@${targetBranch} (${res.status}).`);
            return undefined;
        }
        const data = await res.json() as { sha?: string };
        if (typeof data.sha !== "string" || !data.sha) return undefined;
        return data.sha;
    } catch (err) {
        console.warn(`Failed to fetch latest commit hash for ${repo}@${targetBranch}:`, err);
        return undefined;
    }
}

function isZipBuffer(data: Uint8Array): boolean {
    return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;
}

function logNonZipResponse(repo: string, branch: string | undefined, data: Uint8Array, contentType?: string) {
    const preview = new TextDecoder().decode(data.subarray(0, 200));
    const targetBranch = branch || "main";
    console.error(`Downloaded resource pack is not a zip (repo: ${repo}, branch: ${targetBranch}).`);
    if (contentType) console.error(`Content-Type: ${contentType}`);
    console.error(`Response preview: ${preview}`);
}

async function promptResourcePackUpdate(): Promise<"integrate" | "overwrite" | "ignore"> {
    console.log("Your resource pack is outdated. How would you like to update?");
    console.log("[1] Integrate (default) - Adds any new files without overwriting existing ones.");
    console.log("[2] Overwrite - Overwrites all local changes with newer ones.");
    console.log("[3] Ignore - Don't update.");

    try {
        const buf = new Uint8Array(16);
        const read = await Deno.stdin.read(buf);
        const choice = read ? new TextDecoder().decode(buf.subarray(0, read)).trim() : "";
        if (choice === "2") return "overwrite";
        if (choice === "3") return "ignore";
        return "integrate";
    } catch {
        return "integrate";
    }
}

async function applyResourcePackArchive(zipPath: string, packDir: string, overwrite: boolean) {
    console.log(`Applying resource pack archive (${overwrite ? "overwrite" : "integrate"} mode)...`);
    const tempDir = await Deno.makeTempDir({ prefix: "resource-pack-" });
    await unzipFolder(zipPath, tempDir, "resource pack");

    const extractedRoot = await findFirstDirectory(tempDir);
    const candidate = join(extractedRoot, "pack");
    const sourceDir = await Deno.stat(candidate).then(s => s.isDirectory).catch(() => false) ? candidate : extractedRoot;

    if (overwrite) {
        await emptyDir(packDir);
        await copy(sourceDir, packDir, { overwrite: true });
    } else {
        await ensureDir(packDir);
        await copyDirContents(sourceDir, packDir, false);
    }

    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
    console.log("Resource pack files applied.");
}

async function unzipFolder(filepath: string, output: string, label: string): Promise<void> {
    const success = await zip_ts.decompress(filepath, output);
    if (success) return;

    const hasEntries = await directoryHasEntries(output);
    if (hasEntries) {
        console.warn(`zip-ts reported failure, but ${label} files exist. Continuing.`);
        return;
    }

    console.error(`Failed to decompress ${label} zip.`);
    Deno.exit(1);
}

async function directoryHasEntries(dir: string): Promise<boolean> {
    try {
        for await (const _entry of Deno.readDir(dir)) {
            return true;
        }
    } catch {
        return false;
    }
    return false;
}

async function findFirstDirectory(root: string): Promise<string> {
    for await (const entry of Deno.readDir(root)) {
        if (entry.isDirectory) {
            return join(root, entry.name);
        }
    }
    console.error("Failed to locate extracted resource pack contents.");
    Deno.exit(1);
}

async function copyDirContents(srcRoot: string, destRoot: string, overwrite: boolean) {
    for await (const entry of Deno.readDir(srcRoot)) {
        if (entry.name === ".git") continue;
        const srcPath = join(srcRoot, entry.name);
        const destPath = join(destRoot, entry.name);

        if (entry.isDirectory) {
            await ensureDir(destPath);
            await copyDirContents(srcPath, destPath, overwrite);
        } else {
            if (!overwrite) {
                const exists = await Deno.stat(destPath).then(() => true).catch(() => false);
                if (exists) continue;
            }
            await ensureDir(dirname(destPath));
            await Deno.copyFile(srcPath, destPath).catch(async () => {
                await copy(srcPath, destPath, { overwrite });
            });
        }
    }
}

async function ensureMinecraftVersion(destRoot: string) {
    const destConfigPath = join(destRoot, "config.json");
    const destExists = await Deno.stat(destConfigPath).then(() => true).catch(() => false);
    if (!destExists) return;

    try {
        const destRaw = await Deno.readTextFile(destConfigPath);
        const destJson = JSON.parse(destRaw) as Record<string, unknown>;
        if (!destJson.minecraftVersion) {
            // Default to latest version.
            destJson.minecraftVersion = "latest";
            await Deno.writeTextFile(destConfigPath, JSON.stringify(destJson, null, 2));
            console.log("No minecraftVersion provided, defaulting to 'latest'.");
        }
        console.log(`Minecraft Version: ${destJson.minecraftVersion}`);
    } catch (err) {
        console.warn("Unable to validate minecraftVersion in config.json:", err);
    }
}

async function mergeConfig(srcRoot: string, destRoot: string) {
    const srcConfigPath = join(srcRoot, "config.json");
    const destConfigPath = join(destRoot, "config.json");

    const srcExists = await Deno.stat(srcConfigPath).then(() => true).catch(() => false);
    if (!srcExists) return;

    const destExists = await Deno.stat(destConfigPath).then(() => true).catch(() => false);
    if (!destExists) {
        await Deno.copyFile(srcConfigPath, destConfigPath);
        console.log("Wrote default config.json.");
        return;
    }

    try {
        const srcRaw = await Deno.readTextFile(srcConfigPath);
        const destRaw = await Deno.readTextFile(destConfigPath);
        const srcJson = JSON.parse(srcRaw) as Record<string, unknown>;
        const destJson = JSON.parse(destRaw) as Record<string, unknown>;

        const updated = mergeMissing(destJson, srcJson);
        if (updated) {
            await Deno.writeTextFile(destConfigPath, JSON.stringify(destJson, null, 2));
            console.log("Merged missing config defaults into config.json.");
        }
    } catch (err) {
        console.warn("Unable to merge config.json:", err);
    }
}

function mergeMissing(target: Record<string, unknown>, source: Record<string, unknown>): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(source)) {
        if (!(key in target)) {
            target[key] = value;
            changed = true;
        } else if (isPlainObject(target[key]) && isPlainObject(value)) {
            const nestedChanged = mergeMissing(target[key] as Record<string, unknown>, value as Record<string, unknown>);
            if (nestedChanged) changed = true;
        }
    }
    return changed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ensureMainRunExport() {
    const mainPath = join(ROOT_DIR, "main.ts");
    let contents: string;
    try {
        contents = await Deno.readTextFile(mainPath);
    } catch (err) {
        console.error("Unable to read main.ts:", err);
        return;
    }

    let updated = contents;

    if (updated.includes("const module = await import(`./${entry.path}?t=${Date.now()}`) as Generator;")) {
        updated = updated.replace(
            /const module = await import\(`\.\/\$\{entry\.path\}\?t=\$\{Date\.now\(\)\}`\) as Generator;/,
            "const module = await importGenerator(entry.path) as Generator;"
        );
    }

    if (!updated.includes("async function importGenerator")) {
        updated += `\n\nasync function importGenerator(path: string): Promise<unknown> {\n    const customImporter = (globalThis as { __SM_IMPORT__?: (path: string) => Promise<unknown> }).__SM_IMPORT__;\n    if (customImporter) return await customImporter(path);\n    return await import(\`./\${path}?t=\${Date.now()}\`);\n}\n`;
    }

    if (updated.includes("export function getConfig() { return CONFIG as Config; }")) {
        updated = updated.replace(
            "export function getConfig() { return CONFIG as Config; }",
            "export function getConfig() {\n    const globalConfig = (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__;\n    return (globalConfig ?? CONFIG) as Config;\n}"
        );
    }

    if (updated.includes("function getConfig() { return CONFIG as Config; }")) {
        updated = updated.replace(
            "function getConfig() { return CONFIG as Config; }",
            "function getConfig() {\n    const globalConfig = (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__;\n    return (globalConfig ?? CONFIG) as Config;\n}"
        );
    }

    if (!updated.includes("globalConfig") && /function\s+getConfig\(\)\s*\{\s*return\s+CONFIG\s+as\s+Config;\s*\}/.test(updated)) {
        updated = updated.replace(
            /function\s+getConfig\(\)\s*\{\s*return\s+CONFIG\s+as\s+Config;\s*\}/,
            "function getConfig() {\n    const globalConfig = (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__;\n    return (globalConfig ?? CONFIG) as Config;\n}"
        );
    }

    if (updated.includes("Object.assign(CONFIG, JSON.parse(data));") && !updated.includes("__SM_CONFIG__")) {
        updated = updated.replace(
            "Object.assign(CONFIG, JSON.parse(data));",
            "Object.assign(CONFIG, JSON.parse(data));\n        (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__ = CONFIG as Config;"
        );
    }

    if (updated.includes("main();") && !updated.includes("import.meta.main")) {
        updated = updated.replace(/\bmain\(\);/, "if (import.meta.main) {\n    main();\n}");
    }

    if (!updated.includes("export async function run")) {
        updated += `\n\nexport async function run(mode?: string) {\n    if (mode) {\n        (Deno.args as string[])[0] = mode;\n    }\n    await main();\n}\n\nexport default run;\n`;
    }

    if (updated !== contents) {
        await Deno.writeTextFile(mainPath, updated);
    }
}

async function ensureItemModelPatches() {
    const itemModelPath = join(ROOT_DIR, "generators", "internal", "itemModel.ts");
    let contents: string;
    try {
        contents = await Deno.readTextFile(itemModelPath);
    } catch {
        return;
    }

    let updated = contents;
    if (updated.includes("{ Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from \"@zip.js/zip.js\"")) {
        updated = updated.replace(
            "{ Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from \"@zip.js/zip.js\"",
            "{ configure, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from \"@zip.js/zip.js\""
        );
    }

    if (!updated.includes("configure({ useWebWorkers: false });")) {
        const marker = "import { getConfig, logProcess } from \"../../main.ts\";";
        if (updated.includes(marker)) {
            updated = updated.replace(marker, `${marker}\n\nconfigure({ useWebWorkers: false });`);
        }
    }

    const target = "const config = getConfig();\n    const version = config.minecraftVersion;";
    if (updated.includes(target)) {
        const replacement = "const config = getConfig();\n    let version = config.minecraftVersion;\n\n    if (!version || typeof version !== \"string\") {\n        try {\n            const raw = await Deno.readTextFile(\"./config.json\");\n            const parsed = JSON.parse(raw) as { minecraftVersion?: unknown };\n            if (typeof parsed.minecraftVersion === \"string\" && parsed.minecraftVersion) {\n                version = parsed.minecraftVersion;\n            }\n        } catch {\n            // Ignore config fallback errors.\n        }\n    }";
        updated = updated.replace(target, replacement);
    }

    if (updated !== contents) {
        await Deno.writeTextFile(itemModelPath, updated);
    }
}

async function findExtractedRoot(tempDir: string): Promise<string> {
    for await (const entry of Deno.readDir(tempDir)) {
        if (entry.isDirectory && entry.name.startsWith(`SuperModel-`)) {
            return join(tempDir, entry.name);
        }
    }
    console.error("Failed to locate extracted repo contents.");
    Deno.exit(1);
}


async function readJson<T>(path: string): Promise<T | undefined> {
    try {
        const raw = await Deno.readTextFile(path);
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

async function copyRepoContents(srcRoot: string, destRoot: string) {
    const skipIfExists = new Set(["config.json"]);

    for await (const entry of Deno.readDir(srcRoot)) {
        const srcPath = join(srcRoot, entry.name);
        const destPath = join(destRoot, entry.name);

        if (skipIfExists.has(entry.name)) {
            const exists = await Deno.stat(destPath).then(() => true).catch(() => false);
            if (exists) continue;
        }

        if (entry.isDirectory) {
            await ensureDir(destPath);
            await copyRepoContents(srcPath, destPath);
        } else {
            await ensureDir(dirname(destPath));
            await Deno.copyFile(srcPath, destPath).catch(async () => {
                await copy(srcPath, destPath, { overwrite: true });
            });
        }
    }
}

function setupLogging(): Deno.FsFile {
    const logFile = Deno.openSync(LOG_FILE, { create: true, write: true, truncate: true });
    const encoder = new TextEncoder();

    const original = {
        log: console.log.bind(console),
        error: console.error.bind(console),
        warn: console.warn.bind(console),
        info: console.info.bind(console)
    };

    const sanitizeConsoleArgs = (args: unknown[]): unknown[] => {
        if (args.length === 0) return args;
        const first = args[0];
        if (typeof first !== "string") return args;

        const matches = first.match(/%c/g);
        if (!matches || matches.length === 0) return args;

        const cleanedFirst = first.replace(/%c/g, "");
        const dropCount = matches.length;
        const remaining = args.slice(1 + dropCount);
        return [cleanedFirst, ...remaining];
    };

    const formatLogArg = (arg: unknown): string => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) {
            const stack = arg.stack ? `\n${arg.stack}` : "";
            return `${arg.name}: ${arg.message}${stack}`;
        }
        if (typeof arg === "object" && arg !== null) {
            const maybeStack = (arg as { stack?: unknown }).stack;
            const maybeMessage = (arg as { message?: unknown }).message;
            if (typeof maybeMessage === "string") {
                const stack = typeof maybeStack === "string" ? `\n${maybeStack}` : "";
                return `Error: ${maybeMessage}${stack}`;
            }
        }
        try { return JSON.stringify(arg); } catch { return String(arg); }
    };

    const writeLine = (args: unknown[]) => {
        const sanitizedArgs = sanitizeConsoleArgs(args);
        const line = sanitizedArgs.map(formatLogArg).join(" ");
        logFile.writeSync(encoder.encode(line + "\n"));
    };

    console.log = (...args: unknown[]) => { original.log(...args); writeLine(args); };
    console.error = (...args: unknown[]) => { original.error(...args); writeLine(args); };
    console.warn = (...args: unknown[]) => { original.warn(...args); writeLine(args); };
    console.info = (...args: unknown[]) => { original.info(...args); writeLine(args); };

    console.log("Launcher started.");

    return logFile;
}

async function runWatch() {
    const mainPath = join(ROOT_DIR, "main.ts");
    const importMap = withNodeModules(await loadImportMap());
    const module = await bundleImport(mainPath, importMap) as { run?: (mode?: string) => Promise<void> };

    if (!module.run) {
        console.error("Unable to start: run() not found in main.ts.");
        Deno.exit(1);
    }

    (globalThis as { __SM_IMPORT__?: (path: string) => Promise<unknown> }).__SM_IMPORT__ = async (path: string) => {
        const normalized = path.replace(/^[.\\/]+/, "");
        const absPath = join(ROOT_DIR, normalized);
        return await bundleImport(absPath, importMap);
    };

    await seedGlobalConfig();

    await module.run("watch");
}

async function seedGlobalConfig() {
    const configPath = join(ROOT_DIR, "config.json");
    try {
        const raw = await Deno.readTextFile(configPath);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        (globalThis as { __SM_CONFIG__?: Record<string, unknown> }).__SM_CONFIG__ = parsed;
    } catch (err) {
        console.warn("Failed to read config.json:", err);
    }
}

async function bundleImport(path: string, importMap?: Record<string, unknown>): Promise<unknown> {
    const specifier = toFileUrl(path).href;
    await ensureDir(BUNDLE_CACHE_DIR);

    const cacheKey = await hashBundleKey(path, importMap);
    const bundlePath = join(BUNDLE_CACHE_DIR, `${cacheKey}.bundle.js`);

    const exists = await Deno.stat(bundlePath).then(() => true).catch(() => false);
    if (!exists) {
        let code: string;
        try {
            const result = await bundle(specifier, {
                importMap: importMap ?? undefined
            });
            code = result.code;
        } catch (bundleErr) {
            console.error("Bundling failed:", bundleErr);
            throw bundleErr;
        }

        await Deno.writeTextFile(bundlePath, code);
    }

    return await import(toFileUrl(bundlePath).href + `?t=${Date.now()}`);
}

async function hashBundleKey(entryPath: string, importMap?: Record<string, unknown>): Promise<string> {
    let source = "";
    try {
        source = await Deno.readTextFile(entryPath);
    } catch {
        source = entryPath;
    }

    const payload = JSON.stringify({ entryPath, source, importMap: importMap ?? {} });
    const data = new TextEncoder().encode(payload);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadImportMap(): Promise<Record<string, unknown> | undefined> {
    const denoConfigPath = join(ROOT_DIR, "deno.json");
    try {
        const raw = await Deno.readTextFile(denoConfigPath);
        const parsed = JSON.parse(raw) as { imports?: Record<string, string>; importMap?: string };

        if (parsed.importMap) {
            const importMapPath = join(ROOT_DIR, parsed.importMap);
            const importMapRaw = await Deno.readTextFile(importMapPath);
            return JSON.parse(importMapRaw) as Record<string, unknown>;
        }

        if (parsed.imports) {
            return { imports: parsed.imports } as Record<string, unknown>;
        }
    } catch (err) {
        console.warn("Failed to load import map:", err);
    }
    return undefined;
}

function withNodeModules(importMap?: Record<string, unknown>): Record<string, unknown> {
    const base = importMap ?? {};
    const imports = { ...(base as { imports?: Record<string, string> }).imports };
    if (!imports["node:path"]) {
        imports["node:path"] = "https://deno.land/std@0.203.0/path/mod.ts";
    }
    if (!imports["@std/path"]) {
        imports["@std/path"] = "jsr:@std/path@^0.203.0";
    }
    if (!imports["@std/fs"]) {
        imports["@std/fs"] = "jsr:@std/fs@^0.203.0";
    }
    if (!imports["@std/fs/walk"]) {
        imports["@std/fs/walk"] = "jsr:@std/fs@^0.203.0/walk";
    }
    if (!imports["@std/collections"]) {
        imports["@std/collections"] = "jsr:@std/collections@^1.1.5";
    }
    if (imports["@zip.js/zip.js"]?.startsWith("npm:")) {
        imports["@zip.js/zip.js"] = toEsmShSpecifier(imports["@zip.js/zip.js"]);
    }
    return { ...base, imports };
}

function toEsmShSpecifier(specifier: string): string {
    const cleaned = specifier.replace(/^npm:/, "").replace(/\^/g, "");
    return `https://esm.sh/${cleaned}?deno`;
}

function setWindowTitle() {
    try {
        if (!Deno.stdout.isTerminal()) return;
        const configPath = join(ROOT_DIR, "config.json");
        const raw = Deno.readTextFileSync(configPath);
        const parsed = JSON.parse(raw) as { packName?: string; version?: string };
        const name = parsed.packName ?? "Supermodel";
        const version = parsed.version ? ` v${parsed.version}` : "";
        const title = `Supermodel - ${name}${version}`;
        const bytes = new TextEncoder().encode(`\x1b]0;${title}\x07`);
        Deno.stdout.writeSync(bytes);
    } catch {
        // Ignore title errors
    }
}

async function waitForExit() {
    try {
        console.log("Press Enter to close...");
        const buf = new Uint8Array(1);
        await Deno.stdin.read(buf);
    } catch { /* close */ }
}

async function main() {
    const logFile = setupLogging();

    addEventListener("error", (event) => {
        console.error("Unhandled error:", (event as ErrorEvent).error ?? event);
    });

    addEventListener("unhandledrejection", (event) => {
        console.error("Unhandled rejection:", (event as PromiseRejectionEvent).reason ?? event);
    });

    try {
        Deno.chdir(ROOT_DIR);
        setWindowTitle();
        await downloadLatestRepo();
        await syncResourcePackWithPrompt();
        (globalThis as { __SM_SKIP_PACK_SYNC__?: boolean }).__SM_SKIP_PACK_SYNC__ = true;
        await runWatch();
    } catch (err) {
        console.error("Launcher failed:", err);
        Deno.exitCode = 1;
    } finally {
        try { logFile.close(); } catch { /* close 2: electric boogaloo */ }
        await waitForExit();
    }
}

main();
