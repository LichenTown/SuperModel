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
import { Config } from "./library/index.ts";

// Path Constants
const CONFIG_FILE = "./config.json", BUILD_ROOT = "./build", PACK_DIR = "./pack", GENERATORS_DIR = "./generators";

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
        const data = await Deno.readTextFile(CONFIG_FILE);
        return JSON.parse(data);
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
    const specificBuildDir = join(BUILD_ROOT, targetName);

    logProcess("Build", "cyan", `Build in progress: ${targetName}`);

    // Clear build folder.
    await emptyDir(BUILD_ROOT);
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
        for await (const entry of walk(GENERATORS_DIR, { exts: [".ts"] })) {
            if (entry.isFile) {
                // Use dynamic import to hook generator function.
                const module = await import(`./${entry.path}?t=${Date.now()}`);
                if (typeof module.default === "function") {
                    logProcess("Gen", "green", `Running ${entry.path.slice(11)}...`);
                    await module.default(PACK_DIR, specificBuildDir);
                }
            }
        }
    }

    return specificBuildDir;
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
async function main() {
    const mode = Deno.args[0] || "build";
    const config = await loadConfig();

    // Watch task behavior.
    if (mode === "watch") {
        await validateDeployPath(config.deployPath);

        const runFullProcess = async () => {
            const buildDir = await buildPack(config);
            await deployPack(config, buildDir);
            logProcess("Watcher", "gray", "Watch is active. Waiting for changes...");
        };

        // Initial run
        await runFullProcess();

        // Watch for changes in assets, generators, or config.
        const watcher = Deno.watchFs([PACK_DIR, GENERATORS_DIR, CONFIG_FILE]);
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

main();

export { logProcess };