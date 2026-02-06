/** 
 * IMPORTS 
 * */
import { ensureDir } from "https://deno.land/std@0.203.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.203.0/fs/walk.ts";
import { join, dirname } from "https://deno.land/std@0.203.0/path/mod.ts";
import { EntityModelDetails, EntityModel } from "../../library/index.ts";
import { logProcess } from "../../main.ts";
import { basename } from "node:path";

// By default, this generator should run last.
export const generatorName = "Entity Model Generator";
export const loadPriority = 11;

/**
 * CEM/Optifine Entity Model Generator
 * Processes entity models from API queue and the supermodel file format into working CEM (.jem + .properties) formats.
 */
export default async function generate(packPath: string, buildPath: string) {
    const outputBase = join(buildPath, "assets/minecraft/optifine/cem");
    await ensureDir(outputBase);

    const propertiesCache: Record<string, string> = {}; // Cache properties file content to handle multiple models targeting the same type.
    const modelsToProcess: Array<{ data: EntityModelDetails; isFromFile: boolean; filePath?: string }> = []; // Current process queue for models.

    // Swallow internal queue.
    const queuedModels = EntityModel.getQueue();
    modelsToProcess.push(...queuedModels.map(data => ({ data, isFromFile: false })));

    // Discover supermodel additions.
    const sourceDir = join(packPath, "./assets/supermodel/entities");
    try {
        // Deno walk() expects extensions without leading dots
        for await (const entry of walk(sourceDir, { exts: ["smodel"] })) {
            try {
                const content = await Deno.readTextFile(entry.path);
                modelsToProcess.push({ data: JSON.parse(content), isFromFile: true, filePath: entry.path });
            } catch (err) {
                logProcess("CEM Error", "red", `Failed to process model file at "${entry.path}": ${(err as Error).message}`, console.error);
            }
        }
    } catch { /* Ignore and move on ya bum */ }

    if (modelsToProcess.length === 0) return;

    // Sort models by loadPriority (lower = loaded first). Default is 5.
    modelsToProcess.sort((a, b) => {
        const priorityA = a.data.loadPriority ?? 5;
        const priorityB = b.data.loadPriority ?? 5;
        return priorityA - priorityB;
    });

    // Process model entries.
    const indexTracker: Record<string, number> = {};

    const tasks = modelsToProcess.map(async ({ data, filePath }) => {
        try {
            const entityTypes = getEntityTypes(data);
            if (entityTypes.length === 0) throw new Error("Definition has no defined entity type(s).");

            const isQueueModel = typeof (data.models ? Object.values(data.models)[0] : data.model) === "object";

            for (const type of entityTypes) {
                if (!(type in indexTracker)) {
                    indexTracker[type] = await getNextIndex(outputBase, type, propertiesCache);
                }
                const iStr = (++indexTracker[type]).toString();

                const entry = buildPropertiesEntry(filePath ?? "internal", data, iStr);
                propertiesCache[type] = (propertiesCache[type] || "") + entry;

                const modelSource = data.models ? (data.models as any)[type] : data.model;
                if (isQueueModel) {
                    await Deno.writeTextFile(join(outputBase, `${type}${iStr}.jem`), JSON.stringify(modelSource, null, 2));
                } else if (filePath) {
                    await copyAssets(filePath, data, type, iStr, modelSource, outputBase);
                }
            }
        } catch (err) {
            logProcess("CEM Error", "red", (err as Error).message, console.error);
        }
    });

    await Promise.all(tasks);

    logProcess("CEM", "white", `Generated ${modelsToProcess.length} entity model(s) with a total of ${Object.values(indexTracker).reduce((a, b) => a + b - 1, 0)} model variant(s).`, console.log);

    const writePromises = Object.entries(propertiesCache).map(([type, content]) =>
        Deno.writeTextFile(join(outputBase, `${type}.properties`), content.trim() + "\n")
    );
    await Promise.all(writePromises);

    EntityModel.clearQueue();
}

/* Helper Functions */

function getEntityTypes(data: EntityModelDetails): string[] {
    if (data.models) return Object.keys(data.models);
    if (data.types) return data.types;
    if (data.type) return [data.type];
    return [];
}

async function getNextIndex(base: string, type: string, cache: Record<string, string>): Promise<number> {
    let content = cache[type];
    if (content === undefined) {
        try { content = await Deno.readTextFile(join(base, `${type}.properties`)); }
        catch { content = ""; }
        cache[type] = content;
    }
    const matches = Array.from(content.matchAll(/models\.(\d+)=/g));
    return matches.length > 0 ? Math.max(...matches.map(m => parseInt(m[1]))) : 1;
}

function buildPropertiesEntry(filePath: string, data: EntityModelDetails, iStr: string): string {
    let section = `\n# [SM] Generated ${filePath ? `from ${basename(filePath)}` : "internally"}\nmodels.${iStr}=${iStr}\n`;
    for (const [key, value] of Object.entries(data.properties ?? {})) {
        section += `${key.replace(/\^/g, iStr)}=${value.replace(/\^/g, iStr)}\n`;
    }
    return section;
}

async function copyAssets(filePath: string, data: EntityModelDetails, type: string, iStr: string, modelSrcName: string | undefined, dest: string) {
    const dir = dirname(filePath);
    const base = basename(filePath).replace(/\.smodel$/i, "");

    let modelName = modelSrcName || base;
    if (!modelName.endsWith(".jem")) {
        modelName += ".jem";
    }
    await Deno.copyFile(join(dir, modelName), join(dest, `${type}${iStr}.jem`)).catch(() => { });

    const textures = (data.textures || (data.texture ? [data.texture] : []) || []);
    const texturesToCopy = textures.length > 0 ? textures : [`${base}.png`];
    for (const tex of texturesToCopy) {
        await Deno.copyFile(join(dir, tex), join(dest, tex)).catch(() => { });
    }
}