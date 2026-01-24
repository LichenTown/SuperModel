/**
 * Item Model Generator
 * Processes item models from API queue and the supermodel file format into dispatched item definitions.
 */
import { ensureDir, copy } from "https://deno.land/std@0.203.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.203.0/fs/walk.ts";
import { join, dirname, basename as stdBasename } from "https://deno.land/std@0.203.0/path/mod.ts";
import { ItemModel, ItemModelDetails } from "../../library/index.ts";
import { logProcess } from "../../main.ts";

// Threshold starting point for model ids (custom_model_data).
const THRESHOLD_START = 2557;


export const loadPriority = -1;

export default async function generate(packPath: string, buildPath: string) {

    // Define output paths.
    const texturesBase = join(buildPath, "assets/supermodel/textures/item");
    const modelsBase = join(buildPath, "assets/supermodel/models/item");
    const itemDefsBase = join(buildPath, "assets/minecraft/items");

    await Promise.all([
        ensureDir(texturesBase),
        ensureDir(modelsBase),
        ensureDir(itemDefsBase),
    ]);

    const modelsToProcess: Array<{ data: ItemModelDetails; isFromFile: boolean; filePath?: string }> = [];

    // Swallow internal queue.
    const queuedModels = ItemModel.getQueue();
    modelsToProcess.push(...queuedModels.map(d => ({ data: d, isFromFile: false })));

    // Discover supermodel additions.
    const sourceDir = join(packPath, "./assets/supermodel/items");
    try {
        for await (const entry of walk(sourceDir, { exts: ["smodel"] })) {
            try {
                const content = await Deno.readTextFile(entry.path);
                modelsToProcess.push({ data: JSON.parse(content), isFromFile: true, filePath: entry.path });
            } catch (err) {
                logProcess("Item Error", "red", `Failed to process item model at "${entry.path}": ${(err as Error).message}`, console.error);
            }
        }
    } catch { /* Optional source; ignore if missing */ }

    if (modelsToProcess.length === 0) return;

    // Item definition storage for final dispatch at the end.
    const modelsAddedByType: Record<string, { folder: string; id: string; definition?: Record<string, unknown> }[]> = {};

    const tasks = modelsToProcess.map(async ({ data, isFromFile, filePath }) => {
        try {
            const itemTypes = getItemTypes(data);
            if (itemTypes.length === 0) throw new Error("Definition has no defined item type(s).");

            const textures = gatherTextures(data);
            if (textures.length === 0) throw new Error("Item model requires at least one texture.");

            // Copy textures and models.
            for (const type of itemTypes) {
                const perTypeModel = resolveModelForType(data, type);
                const modelFolder = resolveModelFolder(perTypeModel, data, type, textures);
                const texOutDir = join(texturesBase, modelFolder);
                const mdlOutDir = join(modelsBase, modelFolder);
                await Promise.all([ensureDir(texOutDir), ensureDir(mdlOutDir)]);

                if (isFromFile && filePath) {
                    const srcDir = dirname(filePath);
                    for (const tex of textures) {
                        const src = join(srcDir, tex);
                        const dest = join(texOutDir, stdBasename(tex));
                        await safeCopy(src, dest);
                    }
                } else {
                    logProcess("Item", "orange", `Skipping texture "${type}": source missing.`);
                }

                // Build or copy models
                const createdModelNames: string[] = [];

                if (perTypeModel === undefined) {
                    // Generate default model for simple 2D items.
                    const primaryTexId = stripExtension(textures[0]);
                    const modelName = `${primaryTexId}.json`;
                    const modelData = defaultItemModel(modelFolder, primaryTexId);
                    await Deno.writeTextFile(join(mdlOutDir, modelName), JSON.stringify(modelData, null, 2));
                    createdModelNames.push(stripExtension(modelName));
                } else if (typeof perTypeModel === "object") {
                    // Write raw models.
                    const baseName = `${deriveModelBaseName(textures, type)}.json`;
                    await Deno.writeTextFile(join(mdlOutDir, baseName), JSON.stringify(perTypeModel, null, 2));
                    createdModelNames.push(stripExtension(baseName));
                } else if (typeof perTypeModel === "string") {

                    const modelFileName = stdBasename(perTypeModel);
                    if (isFromFile && filePath) {
                        const src = join(dirname(filePath), perTypeModel);
                        await safeCopy(src, join(mdlOutDir, modelFileName));
                    } else {
                        logProcess("Item", "orange", `Skipping model file reference "${perTypeModel}" for type "${type}": source missing.`);
                    }
                    createdModelNames.push(stripExtension(modelFileName));
                }

                // Record models added for entries update.
                if (!modelsAddedByType[type]) modelsAddedByType[type] = [];
                modelsAddedByType[type].push(...createdModelNames.map(id => ({ folder: modelFolder, id, definition: data.definition })));
            }
        } catch (err) {
            logProcess("ItemGen Error", "red", (err as Error).message, console.error);
        }
    });

    await Promise.all(tasks);

    // Update entries to item definitions.
    const typeList = Object.keys(modelsAddedByType);
    const summaryResults = await Promise.all(typeList.map(type =>
        updateItemDefinition(
            itemDefsBase,
            type,
            modelsAddedByType[type]
        )
    ));

    // Generate model data ID summary for user reference.
    const summaryByType: Record<string, { folder: string; id: string; threshold: number }[]> = {};
    typeList.forEach((t, i) => { summaryByType[t] = summaryResults[i] || []; });

    const summaryPath = "index.html";
    await ensureDir(dirname(summaryPath));

    const pageTitle = `SuperModel Item Summary │ ${modelsToProcess.length} unique models │ Last updated ${new Date().toLocaleString()}`;
    const summaryHTML = `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pageTitle}</title>
    <style>
        :root { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", Arial, sans-serif; }
        body { margin: 24px; background: #0f172a; color: #e5e7eb; }
        h1 { margin: 0 0 16px; font-size: 22px; }
        .search { margin: 0 0 16px; }
        .search input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #0b1220; color: #e5e7eb; }
        details { border: 1px solid #334155; border-radius: 10px; margin: 8px 0; overflow: hidden; background: #0b1220; }
        summary { cursor: pointer; padding: 12px 14px; font-weight: 600; background: #0c1424; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px 12px; border-bottom: 1px solid #1f2937; }
        th { text-align: left; color: #9ca3af; font-weight: 600; background: #0f192c; }
        tr:hover td { background: #0f1d36; }
        .count { color: #60a5fa; font-weight: 600; margin-left: 6px; }
        .muted { color: #94a3b8; }
        .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#1e293b; color:#93c5fd; font-size:12px; }
        .hidden { display: none !important; }
    </style>
    <script>
        const DATA = ${JSON.stringify(summaryByType)};
        function init() {
            const input = document.getElementById('search-input');
            input.addEventListener('input', () => {
                const q = input.value.toLowerCase().trim();
                const sections = document.querySelectorAll('[data-type-section]');
                sections.forEach(sec => {
                    let visibleRows = 0;
                    const rows = sec.querySelectorAll('tbody tr');
                    rows.forEach(row => {
                        const text = row.textContent.toLowerCase();
                        const show = !q || text.includes(q);
                        row.classList.toggle('hidden', !show);
                        if (show) visibleRows++;
                    });
                    sec.classList.toggle('hidden', visibleRows === 0);
                    const countEl = sec.querySelector('[data-count]');
                    if (countEl) countEl.textContent = visibleRows;
                });
            });
        }
        document.addEventListener('DOMContentLoaded', init);
    </script>
    </head>
    <body>
        <h1>${pageTitle}</h1>
        <div class="search">
            <input id="search-input" type="search" placeholder="Search by type, model, or threshold..." />
        </div>
        ${Object.entries(summaryByType).map(([type, items]) => `
            <details open data-type-section>
                <summary>${type} <span class="count" data-count>${items.length}</span></summary>
                <table>
                    <thead>
                        <tr><th>Model Name</th><th>ID (Custom Model Data)</th></tr>
                    </thead>
                    <tbody>
                        ${items.map(it => `<tr><td><span class="pill">${it.folder}</span> / ${it.id}</td><td>${it.threshold}</td></tr>`).join('')}
                    </tbody>
                </table>
            </details>
        `).join('')}
        <p class="muted">Generated by SuperModel, created by palm1</p>
    </body>
</html>`;

    await Deno.writeTextFile(summaryPath, summaryHTML);

    logProcess("Item", "cyan", `Generated item model summary at "${summaryPath}".`, console.log);

    // Clear queue after processing.
    ItemModel.clearQueue();
}

/* Helpers */

function getItemTypes(data: ItemModelDetails): string[] {
    if (data.models) return Object.keys(data.models);
    if (data.types) return data.types;
    if (data.type) return [data.type];
    return [];
}

function gatherTextures(data: ItemModelDetails): string[] {
    if (data.textures && data.textures.length > 0) return data.textures;
    if (data.texture) return [data.texture];
    return [];
}

function stripExtension(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
}

function defaultItemModel(modelFolder: string, textureId: string) {
    return {
        parent: "minecraft:item/generated",
        textures: {
            layer0: `supermodel:item/${modelFolder}/${textureId}`
        }
    } as Record<string, unknown>;
}

function deriveModelBaseName(textures: string[], type: string): string {
    if (textures.length > 0) return stripExtension(stdBasename(textures[0]));
    return `${type}_model`;
}

function resolveModelFolder(perTypeModel: string | object | undefined, _data: ItemModelDetails, type: string, textures: string[]): string {
    if (typeof perTypeModel === "string") return stripExtension(stdBasename(perTypeModel));
    if (typeof perTypeModel === "object") return deriveModelBaseName(textures, type);
    const base = textures.length > 0 ? stripExtension(stdBasename(textures[0])) : type;
    return base;
}

function resolveModelForType(data: ItemModelDetails, type: string): string | object | undefined {
    if (data.models && data.models[type] !== undefined) return data.models[type];
    if (data.model !== undefined) return data.model;
    return undefined;
}

async function safeCopy(src: string, dest: string) {
    try {
        await copy(src, dest, { overwrite: true });
    } catch (_e) {
        try { await Deno.copyFile(src, dest); } catch (err2) {
            logProcess("ItemGen Warn", "orange", `Failed to copy ${src} -> ${dest}: ${(err2 as Error).message}`);
        }
    }
}

function applyVariableSubstitution(definition: Record<string, unknown>, replacements: Record<string, string>): unknown {
    const jsonStr = JSON.stringify(definition);
    const replaced = Object.entries(replacements).reduce((acc, [key, val]) =>
        acc.replace(new RegExp(key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g"), val)
        , jsonStr);
    return JSON.parse(replaced);
}

function defaultDispatchDefinition(type: string): DispatchModel {
    return {
        type: "range_dispatch",
        property: "custom_model_data",
        fallback: {
            type: "model",
            model: `item/${type}`
        },
        index: 0,
        entries: [] as ModelEntry[]
    };
}

// Internal types.
type ModelEntry = { threshold: number; model: unknown };
type ModelWithThreshold = { folder: string; id: string; threshold: number };
type ModelRef = { folder: string; id: string; definition?: Record<string, unknown> };
type DispatchModel = { type: string; property?: string; fallback?: { type: string; model: string }; index?: number; entries: ModelEntry[] };
type ItemModelFile = { model: DispatchModel };

// Item definition updater.
async function updateItemDefinition(mcItemsBase: string, type: string, modelRefs: ModelRef[]): Promise<ModelWithThreshold[]> {
    const filePath = join(mcItemsBase, `${type}.json`);

    let data: ItemModelFile;
    let exists = false;
    try {
        const raw = await Deno.readTextFile(filePath);
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !("model" in parsed)) {
            throw new Error("Invalid JSON structure");
        }
        data = parsed as ItemModelFile;
        exists = true;
    } catch (_e) {
        // Create default definition.
        data = { model: defaultDispatchDefinition(type) } as ItemModelFile;
    }

    // Validate structure of definition.
    if (!data || !data.model) {
        throw new Error(`Invalid item definition structure at ${type}.json`);
    }
    if (!Array.isArray(data.model.entries)) data.model.entries = [] as ModelEntry[];

    const entries: ModelEntry[] = data.model.entries;

    // Pop current fallback entry.
    if (entries.length > 0) entries.pop();

    // Find latest available threshold.
    const used = entries.map(e => typeof e.threshold === "number" ? e.threshold : 0);
    const highest = used.length ? Math.max(...used) : 0;
    let nextIndex = Math.max(THRESHOLD_START, highest) + 1;

    // Add entries for each model reference.
    const thresholds: ModelWithThreshold[] = [];
    for (const ref of modelRefs) {
        const modelPath = `supermodel:item/${ref.folder}/${ref.id}`;
        const baseDefinition = ref.definition ?? undefined;
        const modelEntry = baseDefinition
            ? applyVariableSubstitution(baseDefinition, {
                "$fallback": `item/${type}`,
                "$model": modelPath,
                "$type": type,
                "$folder": ref.folder,
                "$id": ref.id
            })
            : { type: "model", model: modelPath };

        entries.push({
            threshold: nextIndex++,
            model: modelEntry
        });
        thresholds.push({ folder: ref.folder, id: ref.id, threshold: nextIndex - 1 });
        logProcess("Item", "white", `Added entry for "${ref.folder}/${ref.id}" at threshold ${nextIndex - 1}.`);
    }

    const fallbackModel = { type: "model", model: `item/${type}` };

    // Push final fallback entry.
    entries.push({
        threshold: nextIndex,
        model: fallbackModel
    });

    await ensureDir(dirname(filePath));
    await Deno.writeTextFile(filePath, JSON.stringify(data, null, 4));

    return thresholds;
}