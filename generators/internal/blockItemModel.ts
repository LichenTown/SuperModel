/** 
 * IMPORTS 
 * */
import { ensureDir, copy } from "https://deno.land/std@0.203.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.203.0/fs/walk.ts";
import { join, dirname, basename as stdBasename, extname } from "https://deno.land/std@0.203.0/path/mod.ts";
import { BlockModelDetails, ItemModel } from "../../library/index.ts";
import { logProcess } from "../../main.ts";

// Runs before item model generator.
export const loadPriority = 9;

/**
 * Block Model Generator
 * Processes block-style models from the supermodel file format into dispatched item definitions.
 */
export default async function generate(packPath: string, buildPath: string) {
    const sourceDir = join(packPath, "./assets/supermodel/blocks");
    const texturesBase = join(buildPath, "assets/supermodel/textures/item");

    let processedCount = 0;

    try {
        for await (const entry of walk(sourceDir, { exts: ["smodel"] })) {
            try {
                const content = await Deno.readTextFile(entry.path);
                const data = JSON.parse(content) as BlockModelDetails;

                // Check if the UV mode in use exists.
                if (!data.uv || !["flat", "cardinal"].includes(data.uv)) {
                    throw new Error(`Invalid or missing UV mode. Must be "flat" or "cardinal".`);
                }

                // Get the item types for this model.
                const itemTypes = getItemTypes(data);
                if (itemTypes.length === 0) {
                    throw new Error("No item type(s) defined.");
                }

                // Get the texture path.
                const texturePath = data.texture || stdBasename(dirname(entry.path));
                const textureFileName = extname(texturePath) ? texturePath : texturePath + ".png";

                // Generate block model based on UV mode.
                const modelData = generateBlockModel(data.uv, texturePath);

                // Extract parent folder.
                const relativePath = entry.path.replace(sourceDir, "").replace(/^[\\\/]+/, "");
                const parts = relativePath.split(/[\\\/]/);
                let parentFolder: string | undefined;

                if (parts.length >= 3) {
                    parentFolder = parts[0];
                }

                // Determine model folder name.
                const modelBaseName = stdBasename(entry.path, ".smodel");
                const modelFolder = parentFolder ? `${parentFolder}/${modelBaseName}` : modelBaseName;

                // Copy texture file.
                const srcDir = dirname(entry.path);
                const textureSrc = join(srcDir, textureFileName);
                const textureDestDir = join(texturesBase, modelFolder);
                await ensureDir(textureDestDir);
                const textureDest = join(textureDestDir, stdBasename(textureFileName));

                try {
                    await copy(textureSrc, textureDest, { overwrite: true });
                } catch (copyErr) {
                    logProcess("Block", "orange", `Failed to copy texture "${textureFileName}": ${(copyErr as Error).message}`);
                }

                // Add model to item model queue for processing.
                for (const type of itemTypes) {
                    ItemModel.add({
                        type,
                        textures: {
                            "0": textureFileName
                        },
                        model: {
                            parent: parentFolder,
                            name: modelBaseName,
                            data: modelData as object
                        }
                    });
                    processedCount++;
                }

                logProcess("Block", "blue", `Processed block model "${stdBasename(entry.path)}" for ${itemTypes.length} item type(s).`);
            } catch (err) {
                logProcess("Block Error", "red", `Failed to process block model at "${entry.path}": ${(err as Error).message}`, console.error);
            }
        }
    } catch { /* :) */ }

    if (processedCount > 0) {
        logProcess("Block", "blue", `Queued ${processedCount} block model(s) for item generation.`);
    }
}

/* Helpers */

function getItemTypes(data: BlockModelDetails): string[] {
    if (data.types) return data.types;
    if (data.type) return [data.type];
    return [];
}

function generateBlockModel(uvMode: "flat" | "cardinal", textureName: string) {
    const baseTexturePath = textureName.replace(/\.png$/, "");

    if (uvMode === "flat") {
        // flat
        return {
            "format_version": "1.21.6",
            "credit": "Made with Blockbench",
            "textures": {
                "0": baseTexturePath,
                "particle": baseTexturePath
            },
            "elements": [
                {
                    "from": [0, 0, 0],
                    "to": [16, 16, 16],
                    "faces": {
                        "north": { "uv": [0, 0, 16, 16], "texture": "#0" },
                        "east": { "uv": [0, 0, 16, 16], "texture": "#0" },
                        "south": { "uv": [0, 0, 16, 16], "texture": "#0" },
                        "west": { "uv": [0, 0, 16, 16], "texture": "#0" },
                        "up": { "uv": [0, 0, 16, 16], "texture": "#0" },
                        "down": { "uv": [0, 0, 16, 16], "texture": "#0" }
                    }
                }
            ],
            "display": {
                "thirdperson_righthand": {
                    "rotation": [75, 45, 0],
                    "translation": [0, 2.5, 0],
                    "scale": [0.375, 0.375, 0.375]
                },
                "thirdperson_lefthand": {
                    "rotation": [75, 45, 0],
                    "translation": [0, 2.5, 0],
                    "scale": [0.375, 0.375, 0.375]
                },
                "firstperson_righthand": {
                    "rotation": [0, 45, 0],
                    "scale": [0.4, 0.4, 0.4]
                },
                "firstperson_lefthand": {
                    "rotation": [0, 45, 0],
                    "scale": [0.4, 0.4, 0.4]
                },
                "ground": {
                    "translation": [0, 3, 0],
                    "scale": [0.25, 0.25, 0.25]
                },
                "gui": {
                    "rotation": [30, 45, 0],
                    "scale": [0.625, 0.625, 0.625]
                },
                "head": {
                    "scale": [1.01, 1.01, 1.01]
                },
                "fixed": {
                    "translation": [0, 0, -14],
                    "scale": [2.01, 2.01, 2.01]
                }
            }
        };
    } else if (uvMode === "cardinal") {
        // cardinal
        return {
            "format_version": "1.21.6",
            "credit": "Made with Blockbench",
            "texture_size": [32, 32],
            "textures": {
                "0": baseTexturePath,
                "particle": baseTexturePath
            },
            "elements": [
                {
                    "from": [0, 0, 0],
                    "to": [16, 16, 16],
                    "faces": {
                        "north": { "uv": [8, 0, 16, 8], "texture": "#0" },
                        "east": { "uv": [0, 8, 8, 16], "texture": "#0" },
                        "south": { "uv": [0, 8, 8, 16], "texture": "#0" },
                        "west": { "uv": [0, 8, 8, 16], "texture": "#0" },
                        "up": { "uv": [8, 8, 0, 0], "texture": "#0" },
                        "down": { "uv": [8, 0, 0, 8], "texture": "#0" }
                    }
                }
            ],
            "display": {
                "thirdperson_righthand": {
                    "rotation": [75, 45, 0],
                    "translation": [0, 2.5, 0],
                    "scale": [0.375, 0.375, 0.375]
                },
                "thirdperson_lefthand": {
                    "rotation": [75, 45, 0],
                    "translation": [0, 2.5, 0],
                    "scale": [0.375, 0.375, 0.375]
                },
                "firstperson_righthand": {
                    "rotation": [0, 135, 0],
                    "scale": [0.4, 0.4, 0.4]
                },
                "firstperson_lefthand": {
                    "rotation": [0, 135, 0],
                    "scale": [0.4, 0.4, 0.4]
                },
                "ground": {
                    "translation": [0, 3, 0],
                    "scale": [0.25, 0.25, 0.25]
                },
                "gui": {
                    "rotation": [30, -135, 0],
                    "scale": [0.625, 0.625, 0.625]
                },
                "head": {
                    "scale": [1.01, 1.01, 1.01]
                },
                "fixed": {
                    "rotation": [-90, 0, 0],
                    "translation": [0, 0, -14],
                    "scale": [2.01, 2.01, 2.01]
                }
            }
        };
    }
}
