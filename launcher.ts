import { dirname, join, toFileUrl } from "https://deno.land/std@0.203.0/path/mod.ts";
import { copy, ensureDir } from "https://deno.land/std@0.203.0/fs/mod.ts";
import * as zip_ts from "@fakoua/zip-ts";
import { bundle } from "@deno/emit";

// Change this if the repo is moved.
const REPO_URL = `https://github.com/LichenTown/SuperModel/archive/refs/heads/main.zip`;

const ROOT_DIR = dirname(Deno.execPath());
// Launcher paths
const LOG_FILE = join(ROOT_DIR, "supermodel.log");
const LAUNCHER_DIR = join(ROOT_DIR, ".launcher");
const CACHE_DIR = join(LAUNCHER_DIR, "cache");
const CACHE_PATH = join(CACHE_DIR, "repo.zip");
const META_PATH = join(CACHE_DIR, "repo.json");
const BUNDLE_CACHE_DIR = join(LAUNCHER_DIR, "bundle-cache");

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
    await unzipFolder(CACHE_PATH, tempDir);

    const extractedRoot = await findExtractedRoot(tempDir);
    await copyRepoContents(extractedRoot, ROOT_DIR);

    // Check configuration.
    await mergeConfig(extractedRoot, ROOT_DIR);
    // Check that minecraft version is valid.
    await ensureMinecraftVersion(ROOT_DIR);

    // Patch main 600 times because I love how deno build works!1!!!!1
    await ensureMainRunExport();

    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
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

    if (updated.includes("Object.assign(CONFIG, JSON.parse(data));") && !updated.includes("__SM_CONFIG__")) {
        updated = updated.replace(
            "Object.assign(CONFIG, JSON.parse(data));",
            "Object.assign(CONFIG, JSON.parse(data));\n        (globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__ = CONFIG as Config;"
        );
    }

    if (!updated.includes("__SM_CONFIG__")) {
        updated = updated.replace(
            /return CONFIG as Config;/,
            "(globalThis as { __SM_CONFIG__?: Config }).__SM_CONFIG__ = CONFIG as Config;\n        return CONFIG as Config;"
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

async function findExtractedRoot(tempDir: string): Promise<string> {
    for await (const entry of Deno.readDir(tempDir)) {
        if (entry.isDirectory && entry.name.startsWith(`SuperModel-`)) {
            return join(tempDir, entry.name);
        }
    }
    console.error("Failed to locate extracted repo contents.");
    Deno.exit(1);
}

async function unzipFolder(filepath: string, output: string): Promise<void> {
    const success = await zip_ts.decompress(filepath, output);
    if (!success) {
        console.error("Failed to decompress repo zip.");
        Deno.exit(1);
    }
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

    const writeLine = (args: unknown[]) => {
        const sanitizedArgs = sanitizeConsoleArgs(args);
        const line = sanitizedArgs.map(arg => {
            if (typeof arg === "string") return arg;
            try { return JSON.stringify(arg); } catch { return String(arg); }
        }).join(" ");
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
        //console.error("Available exports:", Object.keys(module ?? {}));
        Deno.exit(1);
    }

    (globalThis as { __SM_IMPORT__?: (path: string) => Promise<unknown> }).__SM_IMPORT__ = async (path: string) => {
        const normalized = path.replace(/^[.\\/]+/, "");
        const absPath = join(ROOT_DIR, normalized);
        return await bundleImport(absPath, importMap);
    };

    await readConfig();

    await module.run("watch");
}

async function readConfig() {
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
    return { ...base, imports };
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
        await downloadLatestRepo();
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
