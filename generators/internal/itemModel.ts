/** 
 * IMPORTS 
 * */
import { ensureDir, copy } from "https://deno.land/std@0.203.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.203.0/fs/walk.ts";
import { join, dirname, basename as stdBasename, extname } from "https://deno.land/std@0.203.0/path/mod.ts";
import { ItemModel, ItemModelDetails } from "../../library/index.ts";
import * as zip_ts from "@fakoua/zip-ts";
import { getConfig, logProcess } from "../../main.ts";

type TextureMap = Record<string, string>;

// Threshold starting point for model ids (custom_model_data).
const THRESHOLD_START = 32767;
const ASSETS_CACHE_DIR = "./minecraft";
const ASSETS_CACHE_VERSION = ".version";

// By default, this generator should run last.
export const loadPriority = 10;

/**
 * Item Model Generator
 * Processes item models from API queue and the supermodel file format into dispatched item definitions.
 */
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

    const vanillaAssetsBase = await ensureVanillaAssets();

    // Item definition storage for final dispatch at the end.
    const modelsAddedByType: Record<string, { parent?: string; folder: string; id: string; definition?: Record<string, unknown> }[]> = {};

    const tasks = modelsToProcess.map(async ({ data, isFromFile, filePath }) => {
        try {
            const itemTypes = getItemTypes(data);
            if (itemTypes.length === 0) throw new Error("Definition has no defined item type(s).");

            const { map: textureMap, hasSingleTexture } = gatherTextureMap(data);
            const textureList = Object.values(textureMap);

            // Get parent/namespace from folder structure.
            const parentFolder = isFromFile && filePath ? extractParentFolder(filePath, sourceDir) : data.model && typeof data.model === "object" && "parent" in data.model ? data.model.parent : undefined;

            // Copy textures and models.
            for (const type of itemTypes) {
                let perTypeModel = resolveModelForType(data, type);
                const modelFolder = resolveModelFolder(perTypeModel, data, type, textureMap, parentFolder);
                const texOutDir = join(texturesBase, modelFolder);
                const mdlOutDir = join(modelsBase, modelFolder);
                await Promise.all([ensureDir(texOutDir), ensureDir(mdlOutDir)]);

                if (isFromFile && filePath && textureList.length > 0) {
                    const srcDir = dirname(filePath);
                    for (let tex of textureList) {
                        if (!extname(tex)) {
                            tex += ".png";
                        }
                        const src = join(srcDir, tex);
                        const dest = join(texOutDir, stdBasename(tex));
                        await safeCopy(src, dest);
                    }
                }

                // Build or copy models.
                const createdModelNames: string[] = [];

                if (perTypeModel === undefined) {
                    // Generate default model for simple 2D items.
                    if (textureList.length === 0) {
                        throw new Error(`No textures defined for type "${type}".`);
                    }
                    const modelBase = deriveModelBaseName(textureMap, type);
                    const modelName = `${modelBase}.json`;
                    const modelData = defaultItemModel(modelFolder, textureMap);
                    await Deno.writeTextFile(join(mdlOutDir, modelName), JSON.stringify(modelData, null, 2));
                    createdModelNames.push(modelBase);
                } else if (typeof perTypeModel === "object") {
                    // Parse internal raw model data.
                    const modelName = (perTypeModel as { name: string; data: object }).name;
                    const modelData = JSON.parse(JSON.stringify((perTypeModel as { name: string; data: object }).data));
                    if (!modelName) {
                        throw new Error(`Internal model for type "${type}" is missing "name" property.`);
                    }
                    if (!modelData) {
                        throw new Error(`Internal model "${modelName}" for type "${type}" is missing "data" property.`);
                    }
                    const fileName = modelName.endsWith(".json") ? modelName : `${modelName}.json`;

                    const alignedTextureMap = alignTextureMap(textureMap, hasSingleTexture, modelData);
                    const resolvedTextures = buildResolvedTextureMap(alignedTextureMap, modelFolder);
                    if (resolvedTextures) {
                        (modelData as Record<string, unknown>).textures = resolvedTextures;
                    }

                    await Deno.writeTextFile(join(mdlOutDir, fileName), JSON.stringify(modelData, null, 2));
                    createdModelNames.push(stripExtension(fileName));
                } else if (typeof perTypeModel === "string") {
                    // Get mode file.
                    if (!extname(perTypeModel)) {
                        perTypeModel += ".json";
                    }
                    const modelFileName = stdBasename(perTypeModel);
                    if (isFromFile && filePath) {
                        const src = join(dirname(filePath), perTypeModel);
                        const dest = join(mdlOutDir, modelFileName);
                        try {
                            const raw = await Deno.readTextFile(src);
                            const parsed = JSON.parse(raw) as Record<string, unknown>;

                            const alignedTextureMap = alignTextureMap(textureMap, hasSingleTexture, parsed);
                            const resolvedTextures = buildResolvedTextureMap(alignedTextureMap, modelFolder);
                            if (resolvedTextures) {
                                parsed.textures = resolvedTextures;
                            }

                            await Deno.writeTextFile(dest, JSON.stringify(parsed, null, 2));
                        } catch (_err) {
                            // Fallback to simple copy if parsing fails.
                            await safeCopy(src, dest);
                        }
                    } else {
                        logProcess("Item", "orange", `Skipping model file reference "${perTypeModel}" for type "${type}": source missing.`);
                    }
                    createdModelNames.push(stripExtension(modelFileName));
                }

                // Record models added for entries update.
                if (!modelsAddedByType[type]) modelsAddedByType[type] = [];
                modelsAddedByType[type].push(...createdModelNames.map(id => ({ parent: parentFolder, folder: modelFolder, id, definition: data.definition })));
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
            modelsAddedByType[type],
            vanillaAssetsBase
        )
    ));

    // Generate model data ID summary for user reference.
    const summaryByType: Record<string, { parent?: string; folder: string; id: string; threshold: number }[]> = {};
    typeList.forEach((t, i) => { summaryByType[t] = summaryResults[i] || []; });

    const summaryPath = "index.html";
    await ensureDir(dirname(summaryPath));

    const totalModels = modelsToProcess.length;
    const totalTypes = Object.keys(summaryByType).length;
    const timestamp = new Date().toLocaleString();

    // Collect all unique parents for the sidebar menu.
    const uniqueParents: Record<string, number> = {};
    Object.values(summaryByType).flat().forEach(item => {
        const parent = item.parent || "default";
        uniqueParents[parent] = (uniqueParents[parent] || 0) + 1;
    });

    // Generate summary to view and search SM item models.
    const summaryHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SuperModel | Item Model Summary</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&family=Space+Mono:wght@400;700&display=swap');
        :root { 
            --bg-main: #05070a;
            --bg-sidebar: #0a0d14;
            --surface: #111622;
            --border: #1e2536;
            --accent: #c18aff;
            --accent-glow: rgba(45, 212, 191, 0.2);
            --text-bright: #ffffff;
            --text-dim: #64748b;
            --text-mid: #94a3b8;
            --font-main: 'Plus Jakarta Sans', sans-serif;
            --font-code: 'Space Mono', monospace;
        }
        * { box-sizing: border-box; }
        body { 
            margin: 0; padding: 0; 
            background: var(--bg-main); 
            color: var(--text-mid); 
            font-family: var(--font-main);
            height: 100vh;
            display: flex;
            overflow: hidden;
            font-size: 16px; /* Base zoom increase */
        }
        
        /* Dual Sidebar Navigation */
        aside {
            width: 340px; /* Slightly wider sidebar */
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            height: 100vh;
        }
        .aside-pane {
            display: flex;
            flex-direction: column;
            min-height: 0;
            border-bottom: 1px solid var(--border);
        }
        .aside-pane:first-child { 
            flex: 0 1 auto; /* Grow to fit content, but cap it */
            max-height: 33%; 
        }
        .aside-pane:last-child { 
            flex: 1; /* Take the rest of the 67%+ */
            border-bottom: none; 
        }

        .aside-header { padding: 20px 24px; border-bottom: 1px solid var(--border); background: #0c111a; }
        .aside-header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
        .aside-header h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-dim); font-weight: 800; }
        .selection-count { font-size: 10px; font-weight: 800; color: var(--accent); background: var(--accent-glow); padding: 2px 8px; border-radius: 99px; border: 1px solid var(--accent); display: none; }
        
        .sidebar-search-wrapper { position: relative; }
        .sidebar-search { width: 100%; background: var(--bg-main); border: 1px solid var(--border); padding: 10px 12px 10px 32px; border-radius: 8px; color: white; font-size: 13px; outline: none; }
        .sidebar-search:focus { border-color: var(--accent); }
        .sidebar-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-dim); }

        .nav-list { padding: 12px; overflow-y: auto; flex-grow: 1; }
        .nav-item { padding: 12px 14px; border-radius: 8px; font-size: 14px; cursor: pointer; transition: all 0.2s; display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; border: 1px solid transparent; user-select: none; }
        .nav-item:hover { background: var(--surface); color: var(--text-bright); }
        .nav-item.active { background: var(--surface); border-color: var(--accent); color: var(--text-bright); box-shadow: 0 0 12px var(--accent-glow); }
        .nav-item .count-badge { font-size: 11px; background: var(--border); padding: 2px 6px; border-radius: 5px; color: var(--text-dim); }
        .nav-item.active .count-badge { background: var(--accent); color: var(--bg-main); }

        /* Main Area */
        main { flex-grow: 1; display: flex; flex-direction: column; overflow: hidden; }
        header { padding: 28px 48px; background: rgba(5, 7, 10, 0.8); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; z-index: 10; }
        .header-meta h1 { margin: 0; font-size: 24px; font-weight: 800; color: var(--text-bright); letter-spacing: -0.025em; }
        .header-meta p { margin: 4px 0 0; font-size: 13px; color: var(--text-dim); font-weight: 600; text-transform: uppercase; }
        
        .stats-container { display: flex; gap: 32px; }
        .stat-block { text-align: right; }
        .stat-label { font-size: 10px; color: var(--text-dim); font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
        .stat-value { font-size: 22px; font-weight: 800; color: var(--text-bright); }

        .search-area { padding: 18px 48px; background: var(--bg-main); }
        .search-input-wrapper { position: relative; max-width: 700px; }
        #search-input { width: 100%; background: var(--surface); border: 1px solid var(--border); padding: 14px 18px 14px 44px; border-radius: 10px; color: white; font-family: var(--font-main); outline: none; transition: all 0.2s; font-size: 16px; }
        #search-input:focus { border-color: var(--accent); box-shadow: 0 0 20px var(--accent-glow); }
        .search-icon { position: absolute; left: 16px; top: 50%; transform: translateY(-50%); color: var(--text-dim); }

        #content { padding: 0 48px 48px; overflow-y: auto; flex-grow: 1; }
        .section { margin-top: 32px; }
        .section-label { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; font-size: 13px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
        .section-label::after { content: ""; flex-grow: 1; height: 1px; background: var(--border); }
        
        .data-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); gap: 16px; }
        .item-row { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; display: flex; justify-content: space-between; align-items: center; transition: transform 0.2s, border-color 0.2s; }
        .item-row:hover { border-color: var(--text-mid); transform: translateY(-2px); }
        
        .model-path { display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
        .parent-tag { font-size: 10px; font-weight: 900; padding: 2px 6px; border-radius: 4px; width: fit-content; text-transform: uppercase; letter-spacing: 0.03em; }
        .full-path { font-family: var(--font-code); font-size: 15px; color: var(--text-mid); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .model-name { color: var(--text-bright); font-weight: 700; }
        
        .threshold-wrapper { text-align: right; flex-shrink: 0; padding-left: 20px; }
        .threshold-label { font-size: 9px; color: var(--text-dim); display: block; margin-bottom: 2px; font-weight: 800; }
        .threshold-value { font-family: var(--font-code); font-size: 20px; font-weight: 700; color: var(--accent); }
        .hidden { display: none !important; }
        footer { padding: 16px 48px; font-size: 12px; color: var(--text-dim); border-top: 1px solid var(--border); background: var(--bg-sidebar); display: flex; justify-content: space-between; font-family: var(--font-code); }
    </style>
</head>
<body>
    <aside>
        <div class="aside-pane">
            <div class="aside-header">
                <div class="aside-header-top">
                    <h2>Parents</h2>
                    <div id="parent-selection-badge" class="selection-count">0</div>
                </div>
                <div class="sidebar-search-wrapper">
                    <svg class="sidebar-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input type="text" class="sidebar-search" id="parent-search" placeholder="Search parents..." autocomplete="off">
                </div>
            </div>
            <div class="nav-list" id="parent-nav">
                ${Object.entries(uniqueParents).sort(([a], [b]) => a.localeCompare(b)).map(([ns, count]) => `
                    <div class="nav-item" data-parent="${ns}">
                        <span>${ns}</span>
                        <span class="count-badge">${count}</span>
                    </div>
                `).join('')}
            </div>
        </div>

        <div class="aside-pane">
            <div class="aside-header">
                <div class="aside-header-top">
                    <h2>Item Types</h2>
                    <div id="type-selection-badge" class="selection-count">0</div>
                </div>
                <div class="sidebar-search-wrapper">
                    <svg class="sidebar-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input type="text" class="sidebar-search" id="type-search" placeholder="Search item types..." autocomplete="off">
                </div>
            </div>
            <div class="nav-list" id="type-nav">
                ${Object.keys(summaryByType).sort().map(type => `
                    <div class="nav-item" data-type="${type}">
                        <span>${type.replace('minecraft:', '')}</span>
                        <span class="count-badge">${summaryByType[type].length}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    </aside>

    <main>
        <header>
            <div class="header-meta">
                <h1>SM - Item Model Collection</h1>
                <p>${getConfig().packName} - v${getConfig().version}</p>
            </div>
            <div class="stats-container">
                <div class="stat-block">
                    <div class="stat-label">Unique Models</div>
                    <div class="stat-value">${totalModels}</div>
                </div>
                <div class="stat-block">
                    <div class="stat-label">Types in Use</div>
                    <div class="stat-value">${totalTypes}</div>
                </div>
            </div>
        </header>

        <div class="search-area">
            <div class="search-input-wrapper">
                <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input id="search-input" type="search" placeholder="Search by type, model name, folder, or threshold index..." autocomplete="off">
            </div>
        </div>

        <div id="content">
            ${Object.entries(summaryByType).sort(([a], [b]) => a.localeCompare(b)).map(([type, items]) => `
                <div class="section" data-type-section="${type}">
                    <div class="section-label">${type}</div>
                    <div class="data-grid">
                        ${items.map(it => `
                            <div class="item-row" data-item-parent="${it.parent || 'default'}">
                                <div class="model-path">
                                    <span class="parent-tag" data-parent-color="${it.parent || 'default'}">${(it.parent || 'default').toUpperCase()}</span>
                                    <div class="full-path">${it.folder.replace((it.parent || '') + '/', '')}/<span class="model-name">${it.id}</span></div>
                                </div>
                                <div class="threshold-wrapper">
                                    <span class="threshold-label">CUSTOM MODEL DATA</span>
                                    <div class="threshold-value">${it.threshold}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('')}
        </div>

        <footer>
            <div>UPDATED: ${timestamp}</div>
            <div>GENERATED BY SUPERMODEL • CREATED BY PALM1</div>
        </footer>
    </main>

    <script>
        // Parent color palette, you like? :D
        const PALETTE = [
            { bg: 'rgba(45, 212, 191, 0.15)', text: '#4cf8b6' },
            { bg: 'rgba(56, 189, 248, 0.15)', text: '#5cceff' },
            { bg: 'rgba(129, 140, 248, 0.15)', text: '#818cf8' },
            { bg: 'rgba(192, 132, 252, 0.15)', text: '#c084fc' },
            { bg: 'rgba(244, 114, 182, 0.15)', text: '#f472b6' },
            { bg: 'rgba(251, 146, 60, 0.15)', text: '#fb923c' },
            { bg: 'rgba(163, 230, 53, 0.15)', text: '#a3e635' }
        ];

        function hashString(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            return Math.abs(hash);
        }

        function applyParentColors() {
            document.querySelectorAll('[data-parent-color]').forEach(el => {
                const parent = el.getAttribute('data-parent-color');
                const index = hashString(parent) % PALETTE.length;
                const style = PALETTE[index];
                el.style.background = style.bg;
                el.style.color = style.text;
                el.style.border = '1px solid ' + style.text + '33';
            });
        }

        const parentSearch = document.getElementById('parent-search');
        const typeSearch = document.getElementById('type-search');
        const mainSearch = document.getElementById('search-input');
        const parentItems = document.querySelectorAll('#parent-nav .nav-item');
        const typeItems = document.querySelectorAll('#type-nav .nav-item');
        const sections = document.querySelectorAll('[data-type-section]');
        const parentBadge = document.getElementById('parent-selection-badge');
        const typeBadge = document.getElementById('type-selection-badge');
        
        let selectedParents = new Set();
        let selectedTypes = new Set();

        parentSearch.addEventListener('input', () => {
            const q = parentSearch.value.toLowerCase().trim();
            parentItems.forEach(item => item.classList.toggle('hidden', q && !item.textContent.toLowerCase().includes(q)));
        });

        typeSearch.addEventListener('input', () => {
            const q = typeSearch.value.toLowerCase().trim();
            typeItems.forEach(item => item.classList.toggle('hidden', q && !item.textContent.toLowerCase().includes(q)));
        });

        parentItems.forEach(item => {
            item.addEventListener('click', () => {
                const parent = item.getAttribute('data-parent');
                if (selectedParents.has(parent)) { selectedParents.delete(parent); item.classList.remove('active'); }
                else { selectedParents.add(parent); item.classList.add('active'); }
                parentBadge.textContent = selectedParents.size;
                parentBadge.style.display = selectedParents.size > 0 ? 'block' : 'none';
                applyFilters();
            });
        });

        typeItems.forEach(item => {
            item.addEventListener('click', () => {
                const type = item.getAttribute('data-type');
                if (selectedTypes.has(type)) { selectedTypes.delete(type); item.classList.remove('active'); }
                else { selectedTypes.add(type); item.classList.add('active'); }
                typeBadge.textContent = selectedTypes.size;
                typeBadge.style.display = selectedTypes.size > 0 ? 'block' : 'none';
                applyFilters();
            });
        });

        mainSearch.addEventListener('input', applyFilters);

        function applyFilters() {
            const query = mainSearch.value.toLowerCase().trim();
            sections.forEach(sec => {
                const type = sec.getAttribute('data-type-section');
                const typeMatched = selectedTypes.size === 0 || selectedTypes.has(type);
                if (!typeMatched) { sec.classList.add('hidden'); return; }

                let visibleRows = 0;
                const rows = sec.querySelectorAll('.item-row');
                rows.forEach(row => {
                    const parent = row.getAttribute('data-item-parent');
                    const parentMatched = selectedParents.size === 0 || selectedParents.has(parent);
                    const textMatched = !query || row.textContent.toLowerCase().includes(query);
                    const show = parentMatched && textMatched;
                    row.classList.toggle('hidden', !show);
                    if (show) visibleRows++;
                });
                sec.classList.toggle('hidden', visibleRows === 0);
            });
        }

        document.addEventListener('DOMContentLoaded', applyParentColors);
    </script>
</body>
</html>`;

    await Deno.writeTextFile(summaryPath, summaryHTML);

    logProcess("Item", "cyan", `Generated item model summary at "${summaryPath}".`, console.log);

    // Clear queue after processing.
    ItemModel.clearQueue();
}

/* Helpers */

async function ensureVanillaAssets(): Promise<string> {
    const config = getConfig();
    const version = config.minecraftVersion;

    if (!version || typeof version !== "string") {
        logProcess("Item", "red", "Missing required config: minecraftVersion", console.error);
        Deno.exit(1);
    }
    ;
    const assetsDir = join(ASSETS_CACHE_DIR, "assets");
    const versionFile = join(ASSETS_CACHE_DIR, ASSETS_CACHE_VERSION);

    const cacheExists = await Deno.stat(ASSETS_CACHE_DIR).then(s => s.isDirectory).catch(() => false);
    const cacheHasEntries = cacheExists ? await hasDirEntries(ASSETS_CACHE_DIR) : false;
    let versionMatches = false;
    if (cacheExists && cacheHasEntries) {
        try {
            const cachedVersion = (await Deno.readTextFile(versionFile)).trim();
            versionMatches = cachedVersion === version;
        } catch {
            versionMatches = false;
        }
    }

    if (!cacheExists || !cacheHasEntries || !versionMatches) {
        if (cacheExists) {
            await Deno.remove(ASSETS_CACHE_DIR, { recursive: true }).catch(() => undefined);
        }
        await downloadVanillaAssets(version);
    }

    return assetsDir;
}

async function hasDirEntries(dir: string): Promise<boolean> {
    try {
        for await (const _entry of Deno.readDir(dir)) return true;
    } catch {
        return false;
    }
    return false;
}

async function downloadVanillaAssets(version: string) {
    // Thank you PixiGeko, you absolutely legend among mortals. :)
    const zipUrl = `https://github.com/PixiGeko/Minecraft-default-assets/archive/refs/heads/${version}.zip`;

    const head = await fetch(zipUrl, { method: "HEAD" });
    if (!head.ok) {
        logProcess("Item", "red", `Vanilla assets not available for version "${version}". Verify your 'minecraftVersion' is correct in config.json.`, console.error);
        Deno.exit(1);
    }

    logProcess("Item", "cyan", `Downloading vanilla assets for ${version}...`);
    const res = await fetch(zipUrl);
    if (!res.ok) {
        logProcess("Item", "red", `Failed to download vanilla assets for ${version}.`, console.error);
        Deno.exit(1);
    }

    const tempDir = join(ASSETS_CACHE_DIR, "__tmp");
    await ensureDir(tempDir);

    const zipPath = join(tempDir, "vanilla.zip");
    const zipData = new Uint8Array(await res.arrayBuffer());
    await Deno.writeFile(zipPath, zipData);

    await unzipFolder(zipPath, tempDir);

    const extractedRoot = join(tempDir, `Minecraft-default-assets-${version}`);
    const assetsSrc = join(extractedRoot, "assets");
    const assetsExists = await Deno.stat(assetsSrc).then(s => s.isDirectory).catch(() => false);

    if (!assetsExists) {
        logProcess("Item", "red", "Downloaded vanilla assets missing assets folder.", console.error);
        Deno.exit(1);
    }

    await ensureDir(ASSETS_CACHE_DIR);
    await copy(assetsSrc, join(ASSETS_CACHE_DIR, "assets"), { overwrite: true });
    await Deno.writeTextFile(join(ASSETS_CACHE_DIR, ASSETS_CACHE_VERSION), version);

    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
    logProcess("Item", "cyan", `Vanilla assets cached at ${ASSETS_CACHE_DIR}.`);
}

async function unzipFolder(filepath: string, output: string): Promise<void> {
    const success = await zip_ts.decompress(filepath, output);
    if (!success) {
        throw new Error("Failed to decompress file");
    }
}

async function getVanillaItemModel(assetsBase: string, type: string): Promise<Record<string, unknown> | undefined> {
    if (type.includes(":")) {
        if (!type.startsWith("minecraft:")) return undefined;
    }

    const normalized = type.startsWith("minecraft:") ? type.slice("minecraft:".length) : type;
    const filePath = join(assetsBase, "minecraft/items", `${normalized}.json`);

    try {
        const raw = await Deno.readTextFile(filePath);
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !("model" in parsed)) return undefined;
        const model = (parsed as { model?: Record<string, unknown> }).model;
        return model && typeof model === "object" ? model : undefined;
    } catch {
        return undefined;
    }
}

function getItemTypes(data: ItemModelDetails): string[] {
    if (data.models) return Object.keys(data.models);
    if (data.types) return data.types;
    if (data.type) return [data.type];
    return [];
}

function gatherTextureMap(data: ItemModelDetails): { map: TextureMap; hasSingleTexture: boolean } {
    const explicitMap = data.textures && Object.keys(data.textures).length > 0 ? { ...data.textures } : {};
    if (Object.keys(explicitMap).length > 0) return { map: explicitMap, hasSingleTexture: false };
    if (data.texture) return { map: { layer0: data.texture }, hasSingleTexture: true };
    return { map: {}, hasSingleTexture: false };
}

function stripExtension(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
}

function buildTexturePath(modelFolder: string, textureFile: string): string {
    return `supermodel:item/${modelFolder}/${stripExtension(stdBasename(textureFile))}`;
}

function buildResolvedTextureMap(textureMap: TextureMap, modelFolder: string): TextureMap | undefined {
    if (Object.keys(textureMap).length === 0) return undefined;
    const resolved: TextureMap = {};
    Object.entries(textureMap).forEach(([key, file]) => {
        resolved[key] = buildTexturePath(modelFolder, file);
    });
    return resolved;
}

function alignTextureMap(baseMap: TextureMap, cameFromSingle: boolean, modelData?: Record<string, unknown>): TextureMap {
    if (!cameFromSingle || Object.keys(baseMap).length !== 1) return { ...baseMap };

    const modelTextures = modelData && typeof modelData === "object" && "textures" in modelData && typeof (modelData as Record<string, unknown>).textures === "object"
        ? (modelData as { textures?: TextureMap }).textures
        : undefined;

    if (modelTextures && Object.keys(modelTextures).length > 0) {
        const firstKey = Object.keys(modelTextures)[0];
        const firstVal = Object.values(baseMap)[0];
        return { [firstKey]: firstVal };
    }

    return { ...baseMap };
}

function defaultItemModel(modelFolder: string, textureMap: TextureMap) {
    const resolved = buildResolvedTextureMap(textureMap, modelFolder) ?? { layer0: buildTexturePath(modelFolder, `${stdBasename(modelFolder)}.png`) };
    return {
        parent: "minecraft:item/generated",
        textures: resolved
    } as Record<string, unknown>;
}

function deriveModelBaseName(textureMap: TextureMap, type: string): string {
    const values = Object.values(textureMap);
    if (values.length > 0) return stripExtension(stdBasename(values[0]));
    return `${type}_model`;
}

function extractParentFolder(filePath: string, sourceDir: string): string | undefined {
    // Get relative path from source.
    const relativePath = filePath.replace(sourceDir, "").replace(/^[\\\/]+/, "");
    const parts = relativePath.split(/[\\\/]/);

    // For extended nesting, shorten the path.
    if (parts.length >= 4) {
        return `${parts[0]}/${parts[1]}`;
    }
    // Normal path.
    else if (parts.length >= 3) {
        return parts[0];
    }
    return undefined;
}

function resolveModelFolder(perTypeModel: string | object | undefined, _data: ItemModelDetails, type: string, textureMap: TextureMap, parentFolder?: string): string {
    let base: string;
    if (typeof perTypeModel === "string") {
        base = stripExtension(stdBasename(perTypeModel));
    } else if (typeof perTypeModel === "object") {
        if ("name" in perTypeModel && "data" in perTypeModel) {
            const modelName = (perTypeModel as { name: string; data: object }).name;
            base = stripExtension(stdBasename(modelName));
        } else {
            base = deriveModelBaseName(textureMap, type);
        }
    } else {
        const textureValues = Object.values(textureMap);
        base = textureValues.length > 0 ? stripExtension(stdBasename(textureValues[0])) : type;
    }

    // Apply parent folder (if exists).
    const parent = typeof perTypeModel === "object" && "parent" in perTypeModel ? (perTypeModel as { parent?: string; name: string; data: object }).parent : parentFolder;
    return parent ? `${parent}/${base}` : base;
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
            logProcess("Item", "orange", `Failed to copy ${src} -> ${dest}: ${(err2 as Error).message}`);
        }
    }
}

function applyVariableSubstitution(
    definition: Record<string, unknown>,
    replacements: Record<string, string | Record<string, unknown>>
): unknown {
    const jsonStr = JSON.stringify(definition);
    let result = jsonStr;

    for (const [key, val] of Object.entries(replacements)) {
        const escapedKey = key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
        const replacement = typeof val === "string" ? `"${val}"` : JSON.stringify(val);
        result = result.replace(new RegExp(`"${escapedKey}"`, "g"), replacement);
    }
    return JSON.parse(result);
}

// Default definition that is added as an entry for item models without overriding definitions.
function defaultDispatchDefinition(type: string, fallbackModel?: Record<string, unknown>): DispatchModel {
    return {
        type: "range_dispatch",
        property: "custom_model_data",
        fallback: {
            ...(fallbackModel ?? { type: "model", model: `item/${type}` })
        },
        index: 0,
        entries: [] as ModelEntry[]
    };
}

function hashString(str: string) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
}

function generateUniqueThreshold(modelId: string): number {
    // Generate a unique threshold number that will be consistent for the same ID, 1-8 digits.
    const baseHash = hashString(modelId) % 10000000;
    return THRESHOLD_START + baseHash;
}

// Internal types.
type ModelEntry = { threshold: number; model: unknown };
type ModelWithThreshold = { parent?: string; folder: string; id: string; threshold: number };
type ModelRef = { parent?: string; folder: string; id: string; definition?: Record<string, unknown> };
type DispatchModel = { type: string; property?: string; fallback?: Record<string, unknown>; index?: number; entries: ModelEntry[] };
type ItemModelFile = { model: DispatchModel };

// Item definition updater.
async function updateItemDefinition(mcItemsBase: string, type: string, modelRefs: ModelRef[], vanillaAssetsBase: string): Promise<ModelWithThreshold[]> {
    const filePath = join(mcItemsBase, `${type}.json`);
    const vanillaFallback = await getVanillaItemModel(vanillaAssetsBase, type);

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
        // Create default model definition.
        data = { model: defaultDispatchDefinition(type, vanillaFallback) } as ItemModelFile;
    }

    // Validate structure of definition.
    if (!data || !data.model) {
        throw new Error(`Invalid item definition structure at ${type}.json`);
    }
    if (!Array.isArray(data.model.entries)) data.model.entries = [] as ModelEntry[];

    const entries: ModelEntry[] = data.model.entries;

    // Pop current fallback entry.
    if (entries.length > 0) entries.pop();

    const takenThresholds = new Set<number>(entries.map(entry => entry.threshold));

    let previousIndex = THRESHOLD_START;

    // Add entries for each model reference.
    const thresholds: ModelWithThreshold[] = [];
    for (const ref of modelRefs) {
        const modelPath = `supermodel:item/${ref.folder}/${ref.id}`;
        const baseDefinition = ref.definition ?? undefined;
        const fallbackDefinition = vanillaFallback ? vanillaFallback : { type: "model", model: `item/${type}` };
        const modelEntry = baseDefinition
            ? applyVariableSubstitution(baseDefinition, {
                "$fallback": fallbackDefinition,
                "$model": modelPath,
                "$type": type,
                "$parent": ref.parent ?? "",
                "$folder": ref.folder,
                "$id": ref.id
            })
            : { type: "model", model: modelPath };

        previousIndex = generateUniqueThreshold(`${ref.folder}/${ref.id}`);
        if (takenThresholds.has(previousIndex)) {
            logProcess("Item", "orange", `Skipping entry for "${ref.folder}/${ref.id}": threshold ${previousIndex} already in use.`);
            continue;
        }

        entries.push({
            threshold: previousIndex,
            model: modelEntry
        });
        takenThresholds.add(previousIndex);
        thresholds.push({ parent: ref.parent, folder: ref.folder, id: ref.id, threshold: previousIndex });
        logProcess("Item", "white", `Added entry for "${ref.folder}/${ref.id}" at threshold ${previousIndex}.`);

        const fallbackThreshold = previousIndex + 1;
        if (!takenThresholds.has(fallbackThreshold)) {
            entries.push({
                threshold: fallbackThreshold,
                model: fallbackDefinition
            });
            takenThresholds.add(fallbackThreshold);
        }
    }

    await ensureDir(dirname(filePath));
    await Deno.writeTextFile(filePath, JSON.stringify(data, null, 4));

    return thresholds;
}