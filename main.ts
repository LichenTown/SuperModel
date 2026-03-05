/**
 *  _______           _______  _______  _______  _______  _______  ______   _______  _       
 * (  ____ \|\     /|(  ____ )(  ____ \(  ____ )(       )(  ___  )(  __  \ (  ____ \( \      
 * | (    \/| )   ( || (    )|| (    \/| (    )|| () () || (   ) || (  \  )| (    \/| (      
 * | (_____ | |   | || (____)|| (__    | (____)|| || || || |   | || |   ) || (__    | |      
 * (_____  )| |   | ||  _____)|  __)   |     __)| |(_)| || |   | || |   | ||  __)   | |      
 *       ) || |   | || (      | (      | (\ (   | |   | || |   | || |   ) || (      | |      
 * /\____) || (___) || )      | (____/\| ) \ \__| )   ( || (___) || (__/  )| (____/\| (____/\
 * \_______)(_______)|/       (_______/|/   \__/|/     \|(_______)(______/ (_______/(_______/                                                                                
 *                           Minecraft Resource Pack Wrapper                   made by palm1
 */

import { copy, emptyDir, ensureDir } from "@std/fs";
import { walk } from "@std/fs/walk";
import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { Config, Generator } from "./library/index.ts";

// Path Constants
const CONFIG_PATH = "./config.json", DEFAULT_CONFIG_PATH = "./config.default.json", BUILD_PATH = "./build", PACK_DIR = "./pack", GENERATORS_DIR = "./generators";
const PACK_CACHE_DIR = "./.supermodel/pack-cache", PACK_META_PATH = join(PACK_CACHE_DIR, "pack.json");
const CONFIG = {};

// Default config.

async function readDefaultConfig() {
    try {
        const raw = await Deno.readTextFile(DEFAULT_CONFIG_PATH);
        const parsed = JSON.parse(raw) as Partial<Config>;
        return Object.assign({}, parsed) as Config;
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            console.warn("Missing default config file.");
            Deno.exit(1);
        }
    }
}

// Helper for getting config.
function getConfig() {
    const globalConfig = (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__;
    return (globalConfig ?? CONFIG) as Config;
}

// Helper for logging.
function logProcess(process: string, color: string, message: string, logFunc: typeof console.log = console.log) {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    logFunc(`[${timestamp}] [%c${process}%c] ${message}`, `color: ${color}`, "color: inherit");
}

/**
 * Load and validate config.json.
 */
async function loadConfig(): Promise<Config> {
    const defaultConfig = await readDefaultConfig();
    try {
        const data = await Deno.readTextFile(CONFIG_PATH);
        const parsed = JSON.parse(data) as Partial<Config>;
        Object.assign(CONFIG, defaultConfig, parsed);
        (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__ = CONFIG as Config;
        return CONFIG as Config;
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            const content = JSON.stringify(defaultConfig, null, 2) + "\n";
            await Deno.writeTextFile(CONFIG_PATH, content);
            Object.assign(CONFIG, defaultConfig);
            (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__ = CONFIG as Config;
            logProcess("Config", "yellow", `Created default config at ${CONFIG_PATH}.`);
            return CONFIG as Config;
        }

        console.error("CRITICAL ERROR: Could not read config.json. Please ensure it exists and is valid JSON.");
        console.error((err as Error).message);
        Deno.exit(1);
    }
}

/**
 * Validate deployment path exists.
 */
async function validateDeployPath(path: string) {
    try {
        const info = await Deno.stat(path);
        if (!info.isDirectory) throw new Error();
    } catch {
        console.error(`ERROR: Deployment path "${path}" is invalid or unreachable. Check your config.json.`);
        Deno.exit(1);
    }
}

/**
 * Folder name scheme.
 */
function getTargetFolderName(config: Config): string {
    return `${config.packName}-${config.version}`;
}

/**
 * Sync working resource pack copy with Github remote.
 */
async function syncResourcePack(config: Config) {
    if ((globalThis as { __SM_SKIP_PACK_SYNC__?: boolean }).__SM_SKIP_PACK_SYNC__) return;
    if (!config.resourcePackRepo) return;

    const { repo, branch } = resolveResourcePackTarget(config.resourcePackRepo, config.resourcePackBranch);
    if (!repo) return;

    const targetBranch = branch || "main";
    logProcess("Pack", "cyan", `Checking resource pack updates from ${repo} (${targetBranch})...`);

    const packExists = await Deno.stat(PACK_DIR).then(s => s.isDirectory).catch(() => false);
    const meta = await readJson<{ etag?: string }>(PACK_META_PATH);
    let archive = await fetchResourcePackArchive(repo, targetBranch, meta?.etag, Boolean(branch));
    if (archive.status === "not-modified") {
        if (packExists) {
            logProcess("Pack", "cyan", "Resource pack is already up to date.");
            return;
        }
        archive = await fetchResourcePackArchive(repo, targetBranch, undefined, Boolean(branch));
    }
    if (archive.status !== "changed" || !archive.data) return;

    const shouldPrompt = packExists;
    let overwrite = false;
    if (shouldPrompt) {
        const action = await promptResourcePackUpdate();
        if (action === "ignore") return;
        overwrite = action === "overwrite";
    }

    const tempDir = await Deno.makeTempDir({ prefix: "resource-pack-" });
    const zipPath = join(tempDir, "pack.zip");
    await Deno.writeFile(zipPath, archive.data);
    logProcess("Pack", "cyan", `Cached pack archive at ${zipPath}.`);
    try {
        await unzipFolder(zipPath, tempDir);
    } catch (err) {
        logProcess("Pack Error", "red", "Failed to decompress resource pack.", console.error);
        logProcess("Pack Error", "red", `File header bytes: ${formatZipHeader(archive.data)}`, console.error);
        logProcess("Pack Error", "red", `File size: ${archive.data.length} bytes`, console.error);
        logProcess("Pack Error", "red", `Error trace: ${(err as Error).message}`, console.error);
        await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
        return;
    }

    const extractedRoot = await findFirstDirectory(tempDir);
    const candidate = join(extractedRoot, "pack");
    const sourceDir = await Deno.stat(candidate).then(s => s.isDirectory).catch(() => false) ? candidate : extractedRoot;

    logProcess("Pack", "cyan", `Applying resource pack files to ${PACK_DIR}...`);
    const preserved = await preserveIgnoredPackEntries(config);
    if (overwrite) {
        await emptyDir(PACK_DIR);
        await ensureDir(PACK_DIR);
        await copy(sourceDir, PACK_DIR, { overwrite: true });
    } else {
        await ensureDir(PACK_DIR);
        await copyDirContents(sourceDir, PACK_DIR, false);
    }
    if (preserved) await restoreIgnoredPackEntries(preserved);

    logProcess("Pack", "cyan", "Resource pack sync complete.");

    await writeJson(PACK_META_PATH, { etag: archive.etag, updatedAt: new Date().toISOString() });

    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
}

/**
 * Parse config for resource pack target repo and branch.
 */
function resolveResourcePackTarget(repoValue: string, branchValue?: string): { repo?: string; branch?: string } {
    const trimmed = repoValue.trim();
    if (!trimmed) return {};

    let repo = trimmed;
    let branch = branchValue?.trim();

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

/* Helpers */

function isZipBuffer(data: Uint8Array): boolean {
    return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;
}

async function findFirstDirectory(root: string): Promise<string> {
    for await (const entry of Deno.readDir(root)) {
        if (entry.isDirectory) return join(root, entry.name);
    }
    throw new Error("Failed to locate extracted resource pack contents.");
}

async function fetchResourcePackZip(repo: string, branch: string, headers?: Headers): Promise<Response> {
    const url = `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`;
    return await fetch(url, headers ? { headers } : undefined);
}

function formatZipHeader(data: Uint8Array): string {
    const bytes = Array.from(data.subarray(0, 8)).map(b => b.toString(16).padStart(2, "0")).join(" ");
    return bytes || "(empty)";
}

async function readJson<T>(path: string): Promise<T | undefined> {
    try {
        const raw = await Deno.readTextFile(path);
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

async function writeJson(path: string, data: unknown): Promise<void> {
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
}

async function fetchResourcePackArchive(
    repo: string,
    branch: string,
    etag?: string,
    hasExplicitBranch = false
): Promise<{ status: "changed"; data: Uint8Array; etag?: string } | { status: "not-modified" | "failed" }> {
    const headers = new Headers();
    if (etag) headers.set("If-None-Match", etag);

    const primary = await fetchResourcePackZip(repo, branch, headers);
    const primaryResult = await readResourcePackArchive(repo, branch, primary);
    if (primaryResult.status !== "failed" || hasExplicitBranch) return primaryResult;

    const fallbackBranch = "main";
    if (branch !== fallbackBranch) {
        logProcess("Pack", "yellow", `Branch is invalid, attempting to use ${fallbackBranch} instead...`, console.warn);
        const fallback = await fetchResourcePackZip(repo, fallbackBranch, headers);
        return await readResourcePackArchive(repo, fallbackBranch, fallback);
    }

    return primaryResult;
}

async function readResourcePackArchive(
    repo: string,
    branch: string,
    res: Response
): Promise<{ status: "changed"; data: Uint8Array; etag?: string } | { status: "not-modified" | "failed" }> {
    if (res.status === 304) return { status: "not-modified" };
    if (!res.ok) {
        logProcess("Pack Error", "red", `Failed to download ${repo}@${branch} (${res.status}).`, console.error);
        return { status: "failed" };
    }

    const data = new Uint8Array(await res.arrayBuffer());
    if (!isZipBuffer(data)) {
        logNonZipResponse(repo, branch, data, res.headers.get("content-type") ?? undefined);
        return { status: "failed" };
    }

    const newEtag = res.headers.get("etag") ?? undefined;
    logProcess("Pack", "cyan", `Downloaded ${repo}@${branch} (${Math.round(data.length / 1024)} KB).`);
    return { status: "changed", data, etag: newEtag };
}

function logNonZipResponse(repo: string, branch: string, data: Uint8Array, contentType?: string) {
    const preview = new TextDecoder().decode(data.subarray(0, 200));
    logProcess("Pack Error", "red", `Downloaded resource pack is not a zip (${repo}@${branch}).`, console.error);
    if (contentType) logProcess("Pack Error", "red", `Content-Type: ${contentType}`, console.error);
    logProcess("Pack Error", "red", `Response preview: ${preview}`, console.error);
}

async function promptResourcePackUpdate(): Promise<"integrate" | "overwrite" | "ignore"> {
    logProcess("Pack", "yellow", "Your resource pack is outdated. How would you like to update?");
    logProcess("Pack", "yellow", "[1] Integrate (default) - Adds new files without overwriting existing ones.");
    logProcess("Pack", "yellow", "[2] Overwrite - Overwrites all local changes with newer ones.");
    logProcess("Pack", "yellow", "[3] Ignore - Don't update.");

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

async function unzipFolder(zipPath: string, output: string): Promise<void> {
    const data = await Deno.readFile(zipPath);
    const reader = new ZipReader(new Uint8ArrayReader(data));
    const entries = await reader.getEntries();
    for (const entry of entries) {
        const destPath = join(output, entry.filename);
        if (entry.directory) {
            await Deno.mkdir(destPath, { recursive: true });
            continue;
        }
        const fileData = await entry.getData(new Uint8ArrayWriter());
        await ensureDir(dirname(destPath));
        await Deno.writeFile(destPath, fileData);
    }
    await reader.close();
}

/**
 * Pack build logic.
 */
async function buildPack(config: Config): Promise<string> {
    const targetName = getTargetFolderName(config);
    const specificBuildDir = join(BUILD_PATH, targetName);

    logProcess("Build", "cyan", `Build in progress: ${targetName}`);

    // Clear build folder.
    await emptyDir(BUILD_PATH);
    await Deno.mkdir(specificBuildDir, { recursive: true });

    // Copy static resource pack files to build directory.
    try {
        const packExists = await Deno.stat(PACK_DIR).then(s => s.isDirectory).catch(() => false);
        if (packExists) {
            await copy(PACK_DIR, specificBuildDir, { overwrite: true });
            // Remove supermodel source files.
            const supermodelPath = join(specificBuildDir, "assets/supermodel");;
            const supermodelExists = await Deno.stat(supermodelPath).then(s => s.isDirectory).catch(() => false);
            if (supermodelExists)
                await Deno.remove(supermodelPath, { recursive: true });
        }
    } catch (e) {
        logProcess("Build Error", "red", "Failed to copy static pack files: " + (e as Error).message, console.warn);
    }

    // Iterate through and run API generators.
    const genExists = await Deno.stat(GENERATORS_DIR).then(s => s.isDirectory).catch(() => false);
    if (genExists) {
        // Collect generators.
        const generators: Array<{ path: string; module: Generator }> = [];

        for await (const entry of walk(GENERATORS_DIR, { exts: [".ts"] })) {
            if (entry.isFile) {
                try {
                    // Use dynamic import to hook generator function.
                    const module = await importGenerator(entry.path) as Generator;
                    if (typeof module.default === "function") {
                        generators.push({ path: entry.path, module });
                    }
                } catch (err) {
                    logProcess("Gen Error", "red", `Failed to load generator at ${entry.path}: ${(err as Error).message}`, console.error);
                }
            }
        }

        // Sort generators by load priority. Prioritizes higher values, defaults to 1.
        generators.sort((a, b) => {
            const priorityA = a.module.loadPriority ?? 1;
            const priorityB = b.module.loadPriority ?? 1;
            return priorityA - priorityB;
        });

        // Execute generators in order of priority.
        for (const { path, module } of generators) {
            const generatorName = module.generatorName ?? path.slice(11);
            logProcess("Gen", "green", `Running ${generatorName}...`);
            await module.default(PACK_DIR, specificBuildDir);
        }
    }

    return specificBuildDir;
}

async function importGenerator(path: string): Promise<unknown> {
    const customImporter = (globalThis as { __SM_IMPORT__?: (path: string) => Promise<unknown> }).__SM_IMPORT__;
    if (customImporter) return await customImporter(path);
    return await import(`./${path}?t=${Date.now()}`);
}

/**
 * Deploy built files to target path.
 */
async function deployPack(config: Config, sourceDir: string) {
    const targetName = getTargetFolderName(config);
    const destination = join(config.deployPath, targetName);

    logProcess("Deploy", "yellow", `Copying to ${destination}...`);

    // Empty destination folder and copy.
    await emptyDir(destination);
    await copy(sourceDir, destination, { overwrite: true });

    logProcess("Deploy", "yellow", `Deployment successful.`);

    const mirrorRoot = config.packMirror?.trim();
    if (!mirrorRoot) return;

    const mirrorDestination = join(mirrorRoot, targetName);
    try {
        const packExists = await Deno.stat(PACK_DIR).then(s => s.isDirectory).catch(() => false);
        if (!packExists) {
            logProcess("Deploy", "yellow", "Pack mirror skipped: ./pack folder is missing.");
            return;
        }
        await ensureDir(mirrorRoot);
        await ensureDir(mirrorDestination);
        await copy(PACK_DIR, mirrorDestination, { overwrite: true });
        logProcess("Deploy", "yellow", `Mirrored pack folder to ${mirrorDestination}.`);
    } catch (err) {
        logProcess("Deploy", "red", `Pack mirror failed: ${(err as Error).message}`, console.warn);
    }
}

/**
 * Main entrypoint.
 */
export async function run(mode?: string) {
    const resolvedMode = mode ?? (Deno.args[0] || "build");
    const config = await loadConfig();
    const isIgnoredPath = createIgnoredPathMatcher(config);

    // Watch task behavior.
    if (resolvedMode === "watch") {
        await validateDeployPath(config.deployPath);
        await syncResourcePack(config);

        const runFullProcess = async () => {
            const buildDir = await buildPack(config);
            await deployPack(config, buildDir);
            logProcess("Watcher", "gray", "Watch is active. Waiting for changes...");
        };

        // Initial run
        await runFullProcess();

        // Watch for changes in assets, generators, or config.
        const watcher = Deno.watchFs([PACK_DIR, GENERATORS_DIR, CONFIG_PATH]);
        let debounceTimer: number | undefined;

        for await (const event of watcher) {
            if (["modify", "create", "remove"].includes(event.kind)) {
                if (event.paths?.length && event.paths.every(isIgnoredPath)) continue;
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(runFullProcess, 250);
            }
        }
    } else {
        // Build task behavior.
        await syncResourcePack(config);
        const buildDir = await buildPack(config);
        logProcess("Build", "green", `Build successful! Output at: ${buildDir}`);
    }
}

export { getConfig, logProcess };

export default run;

if (import.meta.main) {
    run();
}

type PreservedIgnored = { tempDir: string; entries: Array<{ abs: string; rel: string }> };

function normalizeIgnoredPaths(packRoot: string, ignoredFiles: string[]): Array<{ abs: string; rel: string }> {
    const normalized: Array<{ abs: string; rel: string }> = [];
    for (const raw of ignoredFiles) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const abs = resolve(isAbsolute(trimmed) ? trimmed : join(packRoot, trimmed));
        const rel = relative(packRoot, abs);
        if (rel.startsWith("..")) {
            logProcess("Config", "yellow", `Ignored path is outside pack root: ${trimmed}`);
            continue;
        }
        normalized.push({ abs, rel });
    }
    return normalized;
}

async function preserveIgnoredPackEntries(config: Config): Promise<PreservedIgnored | undefined> {
    const ignored = config.ignoredFiles ?? [];
    if (ignored.length === 0) return undefined;

    const packRoot = resolve(PACK_DIR);
    const entries: Array<{ abs: string; rel: string }> = [];
    for (const entry of normalizeIgnoredPaths(packRoot, ignored)) {
        const exists = await Deno.stat(entry.abs).then(() => true).catch(() => false);
        if (exists) entries.push(entry);
    }

    if (entries.length === 0) return undefined;

    const tempDir = await Deno.makeTempDir({ prefix: "supermodel-ignored-" });
    for (const entry of entries) {
        const tempPath = join(tempDir, entry.rel);
        await ensureDir(dirname(tempPath));
        await copy(entry.abs, tempPath, { overwrite: true });
    }

    return { tempDir, entries };
}

async function restoreIgnoredPackEntries(preserved: PreservedIgnored): Promise<void> {
    for (const entry of preserved.entries) {
        const tempPath = join(preserved.tempDir, entry.rel);
        await ensureDir(dirname(entry.abs));
        await copy(tempPath, entry.abs, { overwrite: true });
    }
    await Deno.remove(preserved.tempDir, { recursive: true }).catch(() => undefined);
}

function createIgnoredPathMatcher(config: Config): (path: string) => boolean {
    const packRoot = resolve(PACK_DIR);
    const ignored = normalizeIgnoredPaths(packRoot, config.ignoredFiles ?? []);
    const ignoredAbs = ignored.map(entry => entry.abs);

    return (path: string) => {
        const abs = resolve(path);
        return ignoredAbs.some(ignoredPath =>
            abs === ignoredPath || abs.startsWith(ignoredPath + "/") || abs.startsWith(ignoredPath + "\\"));
    };
}