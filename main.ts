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

import { copy, emptyDir } from "https://deno.land/std@0.203.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.203.0/fs/walk.ts";
import { join } from "https://deno.land/std@0.203.0/path/mod.ts";
import { Config, Generator } from "./library/index.ts";

// Path Constants
const CONFIG_PATH = "./config.json", BUILD_PATH = "./build", PACK_DIR = "./pack", GENERATORS_DIR = "./generators";

const CONFIG = {};
function getConfig() { return CONFIG as Config; }

// Helper for logging.
function logProcess(process: string, color: string, message: string, logFunc: typeof console.log = console.log) {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    logFunc(`[${timestamp}] [%c${process}%c] ${message}`, `color: ${color}`, "color: inherit");
}

/**
 * Load and validate config.json.
 */
async function loadConfig(): Promise<Config> {
    try {
        const data = await Deno.readTextFile(CONFIG_PATH);
        Object.assign(CONFIG, JSON.parse(data));
        return CONFIG as Config;
    } catch {
        console.error("CRITICAL ERROR: Could not read config.json. Please ensure it exists and is valid JSON.");
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
            await Deno.remove(join(specificBuildDir, "assets/supermodel"), { recursive: true });
        }
    } catch (_e) {
        logProcess("Build Error", "red", "Failed to copy static pack files.", console.warn);
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
            logProcess("Gen", "green", `Running ${path.slice(11)}...`);
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
}

/**
 * Main entrypoint.
 */
export async function run(mode?: string) {
    const resolvedMode = mode ?? (Deno.args[0] || "build");
    const config = await loadConfig();

    // Watch task behavior.
    if (resolvedMode === "watch") {
        await validateDeployPath(config.deployPath);

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
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(runFullProcess, 250);
            }
        }
    } else {
        // Build task behavior.
        const buildDir = await buildPack(config);
        logProcess("Build", "green", `Build successful! Output at: ${buildDir}`);
    }
}

export { getConfig, logProcess };

export default run;