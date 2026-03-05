import { ensureDir } from "https://deno.land/std@0.203.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.203.0/fs/walk.ts";
import { basename, dirname, join } from "https://deno.land/std@0.203.0/path/mod.ts";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { ItemModel } from "../../library/index.ts";
import { logProcess } from "../../main.ts";

type TextureMap = Record<string, string>;

interface PartMapping {
    srcX: number;
    srcY: number;
    width: number;
    height: number;
    destX: number;
    destY: number;
}

interface FrameRegion {
    xStart: number;
    zStart: number;
    xEnd: number;
    zEnd: number;
    action?: string;
}

interface ZoneGroup {
    name?: string;
    regions: FrameRegion[];
}

interface AnimationFrame {
    name?: string;
    groups: ZoneGroup[];
}

interface StitchTemplate {
    model: string;
    animation?: Record<string, unknown>;
    mappings?: PartMapping[];
    frames?: AnimationFrame[];
}

interface StitchFile {
    type?: string;
    types?: string[];
    base?: string;
    variant?: string;
    variants?: string[];
    template?: StitchTemplate;
    templates?: StitchTemplate[];
    definition?: Record<string, unknown>;
}

export const generatorName = "Stitch Model Generator";
export const loadPriority = 5;

export default async function generate(packPath: string, buildPath: string) {
    const sourceDir = join(packPath, "assets/supermodel/stitches");
    const smTexturesBase = join(buildPath, "assets/supermodel/textures/item");
    const smModelsBase = join(buildPath, "assets/supermodel/models/item");

    await Promise.all([
        ensureDir(smTexturesBase),
        ensureDir(smModelsBase)
    ]);

    const stitchExists = await Deno.stat(sourceDir).then(s => s.isDirectory).catch(() => false);
    if (!stitchExists) return;

    const tasks: Promise<void>[] = [];

    for await (const entry of walk(sourceDir, { exts: ["stitch"] })) {
        if (!entry.isFile) continue;
        tasks.push(processStitch(entry.path, sourceDir, buildPath));
    }

    await Promise.all(tasks);
}

async function processStitch(stitchPath: string, sourceDir: string, buildPath: string) {
    const folder = dirname(stitchPath);
    const raw = await Deno.readTextFile(stitchPath).catch(err => {
        logProcess("Stitch Error", "red", `Failed to read ${stitchPath}: ${(err as Error).message}`);
        return undefined;
    });
    if (!raw) return;

    let data: StitchFile;
    try {
        data = parseJsonc(raw) as StitchFile;
    } catch (err) {
        logProcess("Stitch Error", "red", `Invalid stitch file ${stitchPath}: ${(err as Error).message}`);
        return;
    }

    const baseName = data.base ?? basename(stitchPath).replace(/\.stitch$/i, "");
    const variants = resolveVariants(data, baseName);
    const templates = resolveTemplates(data, baseName);
    const itemTypes = getItemTypes(data);
    const parentFolder = extractParentFolder(stitchPath, sourceDir);

    const baseModelPath = join(folder, `${baseName}.json`);
    const baseModelData = await readJson(baseModelPath);
    if (!baseModelData) {
        logProcess("Stitch Error", "red", `Missing base model ${baseModelPath}`);
        return;
    }

    const templateModelCache = new Map<string, Record<string, unknown>>();

    for (const variant of variants) {
        const inputPath = join(folder, `${variant}.png`);
        const inputImage = await loadImage(inputPath);
        if (!inputImage) {
            logProcess("Stitch Error", "red", `Missing variant texture ${inputPath}`);
            continue;
        }

        const baseFolder = buildModelFolder(parentFolder, variant);
        for (const template of templates) {
            const outputName = template.model === baseName ? variant : template.model;

            const layout = createBaseLayout(inputImage, template.mappings ?? [], template.animation);
            const sheet = buildSpritesheet(layout, template.frames ?? []);

            const texOutDir = join(buildPath, "assets/supermodel/textures/item", baseFolder);
            await ensureDir(texOutDir);
            await writeTextureWithMeta(texOutDir, outputName, sheet, template.animation);

            if (template.model !== baseName) {
                const templateModelData = await loadTemplateModel(template.model, folder, templateModelCache);
                if (templateModelData) {
                    const mdlOutDir = join(buildPath, "assets/supermodel/models/item", baseFolder);
                    await ensureDir(mdlOutDir);
                    const resolvedTexture = `supermodel:item/${baseFolder}/${outputName}`;
                    const patched = applyTextureOverride(templateModelData, resolvedTexture);
                    await Deno.writeTextFile(join(mdlOutDir, `${outputName}.json`), JSON.stringify(patched, null, 2));
                }
            }
        }

        const baseOutputName = variant;
        if (itemTypes.length > 0) {
            ItemModel.add({
                ...(itemTypes.length === 1 ? { type: itemTypes[0] } : { types: itemTypes }),
                texture: baseOutputName,
                model: { parent: parentFolder, name: baseOutputName, data: baseModelData },
                definition: data.definition
            });
        }
    }
}

function parseJsonc(raw: string): unknown {
    const normalized = raw.replace(/^\uFEFF/, "");
    const noBlock = normalized.replace(/\/\*[\s\S]*?\*\//g, "");
    const noLine = noBlock.replace(/^\s*\/\/.*$/gm, "");
    return JSON.parse(noLine);
}

function resolveVariants(data: StitchFile, baseName: string): string[] {
    if (Array.isArray(data.variants) && data.variants.length > 0) return data.variants;
    if (typeof data.variant === "string" && data.variant.trim()) return [data.variant.trim()];
    return [baseName];
}

function resolveTemplates(data: StitchFile, baseName: string): StitchTemplate[] {
    if (Array.isArray(data.templates) && data.templates.length > 0) return data.templates;
    if (data.template) return [data.template];
    return [{ model: baseName, mappings: [], frames: [] }];
}

function getItemTypes(data: StitchFile): string[] {
    if (Array.isArray(data.types)) return data.types;
    if (typeof data.type === "string") return [data.type];
    return [];
}

function buildModelFolder(parentFolder: string | undefined, modelName: string): string {
    return parentFolder ? `${parentFolder}/${modelName}` : modelName;
}

function createBaseLayout(template: Image, mappings: PartMapping[], animation?: Record<string, unknown>): Image {
    const width = typeof animation?.width === "number" ? animation.width : template.width;
    const height = typeof animation?.height === "number" ? animation.height : template.height;
    const base = new Image(width, height);

    if (!mappings || mappings.length === 0) {
        base.composite(template.clone(), 0, 0);
        return base;
    }

    for (const m of mappings) {
        if (m.width <= 0 || m.height <= 0) continue;
        const part = template.clone().crop(m.srcX, m.srcY, m.width, m.height);
        base.composite(part, m.destX, m.destY);
    }

    return base;
}

function buildSpritesheet(base: Image, frames: AnimationFrame[]): Image {
    const frameList = frames.length > 0 ? frames : [{ name: "Base", groups: [] }];
    const frameWidth = base.width;
    const frameHeight = base.height;
    const sheet = new Image(frameWidth, frameHeight * frameList.length);

    for (let i = 0; i < frameList.length; i++) {
        const frameData = frameList[i];
        const frameCanvas = base.clone();

        for (const group of frameData.groups) {
            for (const reg of group.regions) {
                if (reg.action && reg.action !== "hide") continue;
                const xStart = Math.min(reg.xStart, reg.xEnd);
                const xEnd = Math.max(reg.xStart, reg.xEnd);
                const zStart = Math.min(reg.zStart, reg.zEnd);
                const zEnd = Math.max(reg.zStart, reg.zEnd);

                for (let x = xStart; x <= xEnd; x++) {
                    for (let z = zStart; z <= zEnd; z++) {
                        if (x >= 0 && x < frameCanvas.width && z >= 0 && z < frameCanvas.height) {
                            frameCanvas.setPixelAt(x + 1, z + 1, 0x00000000);
                        }
                    }
                }
            }
        }

        sheet.composite(frameCanvas, 0, i * frameHeight);
    }

    return sheet;
}

async function writeTextureWithMeta(dir: string, name: string, sheet: Image, animation?: Record<string, unknown>) {
    const outPath = join(dir, `${name}.png`);
    await Deno.writeFile(outPath, await sheet.encode());

    if (!animation) return;
    const content = "animation" in animation ? animation : { animation };
    const metaPath = join(dir, `${name}.png.mcmeta`);
    await Deno.writeTextFile(metaPath, JSON.stringify(content, null, 2));
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
    try {
        const raw = await Deno.readTextFile(path);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
        return undefined;
    }
}

async function loadImage(path: string): Promise<Image | undefined> {
    try {
        const data = await Deno.readFile(path);
        return (await Image.decode(data)) as Image;
    } catch {
        return undefined;
    }
}

async function loadTemplateModel(
    modelName: string,
    folder: string,
    cache: Map<string, Record<string, unknown>>
): Promise<Record<string, unknown> | undefined> {
    if (cache.has(modelName)) return cache.get(modelName);
    const modelPath = join(folder, `${modelName}.json`);
    const data = await readJson(modelPath);
    if (data) cache.set(modelName, data);
    return data;
}

function applyTextureOverride(modelData: Record<string, unknown>, resolvedTexture: string): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(modelData)) as Record<string, unknown>;
    const textures = clone.textures && typeof clone.textures === "object" ? (clone.textures as TextureMap) : {};
    const updated: TextureMap = {};

    const keys = Object.keys(textures);
    if (keys.length === 0) {
        updated.layer0 = resolvedTexture;
    } else {
        keys.forEach(key => {
            const value = textures[key];
            updated[key] = typeof value === "string" && value.startsWith("#") ? value : resolvedTexture;
        });
    }

    clone.textures = updated;
    return clone;
}

function extractParentFolder(filePath: string, sourceDir: string): string | undefined {
    const relativePath = filePath.replace(sourceDir, "").replace(/^[\\/]+/, "");
    const parts = relativePath.split(/[\\/]/);

    if (parts.length >= 4) {
        return `${parts[0]}/${parts[1]}`;
    }
    if (parts.length >= 3) {
        return parts[0];
    }
    return undefined;
}