/**
 * Newspaper Generator V2.2 (Minecraft Edition)
 * Processes newspaper JSON data into PNG textures and dispatches Minecraft item models.
 */
import { ensureDir } from "https://deno.land/std@0.203.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.203.0/fs/walk.ts";
import { join, basename } from "https://deno.land/std@0.203.0/path/mod.ts";
import { createCanvas, CanvasRenderingContext2D } from "https://deno.land/x/skia_canvas@0.5.8/mod.ts";
import { ItemModel } from "../../library/index.ts";
import { logProcess } from "../../main.ts";

export default async function generate(packPath: string, buildPath: string) {
    const sourceDir = join(packPath, "assets/supermodel/items/palm/glowing_review");
    const textureOutDir = join(buildPath, "assets/supermodel/textures/item/palm/glowing_review");
    const templatePath = join(packPath, "assets/supermodel/templates/palm/glowing_review/glowing_review.json");

    await ensureDir(textureOutDir);

    let templateData: any;
    try {
        const templateContent = await Deno.readTextFile(templatePath);
        templateData = JSON.parse(templateContent);
    } catch (err) {
        logProcess("Newspaper Error", "red", `Could not find template at ${templatePath}`);
        return;
    }

    try {
        for await (const entry of walk(sourceDir, { exts: ["json"] })) {
            try {
                const content = await Deno.readTextFile(entry.path);
                const config = JSON.parse(content);
                const fileName = basename(entry.path).replace(".json", "") || "newspaper";

                const texturePath = `supermodel:item/palm/glowing_review/${fileName}`;

                // 2. Generate the Newspaper Image
                const canvas = createCanvas(1000, 1000);
                const ctx = canvas.getContext("2d");
                await drawNewspaper(ctx, config);

                // 3. Save the resulting PNG
                await canvas.save(join(textureOutDir, `${fileName}.png`), "png");

                // 4. Create the Model Data based on Template
                const modelData = JSON.parse(JSON.stringify(templateData));
                if (modelData.textures) {
                    modelData.textures["1"] = texturePath;
                }

                // 5. Add to ItemModel queue
                ItemModel.add({
                    type: "paper",
                    model: { parent: "palm", name: fileName, data: modelData },
                    definition: {
                        type: "minecraft:select",
                        cases: [
                            {
                                model: {
                                    type: "minecraft:model",
                                    model: "palm:item/newspaper/newspaper"
                                },
                                when: [
                                    "gui",
                                    "ground",
                                    "fixed",
                                    "thirdperson_lefthand",
                                    "thirdperson_righthand"
                                ]
                            }
                        ],
                        fallback: {
                            type: "minecraft:model",
                            model: "$model"
                        },
                        property: "minecraft:display_context"

                    }
                });

                logProcess("Newspaper", "green", `Generated ${fileName}.png and added model to queue.`);

            } catch (err) {
                logProcess("Newspaper Error", "red", `Failed to process ${entry.path}: ${(err as Error).message}`);
            }
        }
    } catch (err) {
        logProcess("Newspaper Error", "red", `Directory not found: ${sourceDir}`);
    }
}

interface AdConfig {
    title: string;
    text: string;
}

interface QuoteConfig {
    text: string;
    author: string;
}

interface NewspaperConfig {
    paperColor: string;
    inkColor: string;
    masthead: string;
    tagline: string;
    establishedText: string;
    edition: string;
    date: string;
    price: string;
    fortune: string;
    volumeText: string;
    headline: string;
    subHeadline: string;
    writer: string;
    editor: string;
    creator: string;
    leadStory: string;
    ad1: AdConfig;
    quotes: QuoteConfig[];
}

const drawNewspaper = (ctx: CanvasRenderingContext2D, config: NewspaperConfig): void => {
    const width = 1000;
    const height = 1000;
    const ink = config.inkColor;
    const paper = config.paperColor;
    const fontStack = "'Times New Roman', Times, serif";
    const margin = 50;

    // 1. BACKGROUND & BORDERS
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = ink;
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, 980, 980);
    ctx.lineWidth = 1;
    ctx.strokeRect(22, 22, 956, 956);

    ctx.fillStyle = ink;

    // 2. HEADER SECTION
    const headerY = 80;
    const sideBoxHeight = 75;
    const sideBoxWidth = 150;
    const boxTop = headerY - (sideBoxHeight / 2);

    // Established Box (Left)
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, boxTop, sideBoxWidth, sideBoxHeight);

    ctx.font = `bold 12px ${fontStack}`;
    ctx.fillText(config.establishedText, margin + sideBoxWidth / 2, boxTop + 16);
    ctx.font = `bold 16px ${fontStack}`;
    ctx.fillText(config.price, margin + sideBoxWidth / 2, boxTop + 40);

    // Masthead (Center)
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const mastheadCenterY = headerY + 8;
    drawScaledText(ctx, config.masthead.replace(/_/g, " "), width / 2, mastheadCenterY, 580, 90, fontStack, true);

    // Tagline (Center)
    ctx.textBaseline = "top";
    ctx.font = `italic 19px ${fontStack}`;
    ctx.fillText(config.tagline, width / 2, mastheadCenterY + 10);

    // Fortune Box (Right)
    const rBoxX = width - margin - sideBoxWidth;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeRect(rBoxX, boxTop, sideBoxWidth, sideBoxHeight);

    ctx.font = `bold 16px ${fontStack}`;
    ctx.fillText("FORTUNE", rBoxX + sideBoxWidth / 2, boxTop + 16);
    ctx.font = `italic 12px ${fontStack}`;
    drawWrappedText(ctx, config.fortune, rBoxX + sideBoxWidth / 2, boxTop + 36, sideBoxWidth - 10, 16, fontStack);

    // 3. DATE & VOLUME BAR
    ctx.textBaseline = "top";
    let yCursor = 138;
    const barHeight = 38;
    ctx.lineWidth = 3;
    ctx.strokeRect(margin, yCursor, width - (margin * 2), barHeight);

    ctx.font = `bold 17px ${fontStack}`;
    const barTextY = yCursor + (barHeight / 2) - 8;

    ctx.textAlign = "left";
    ctx.fillText(config.date.toUpperCase(), margin + 15, barTextY);
    ctx.textAlign = "center";
    ctx.fillText(config.edition?.toUpperCase() || "WEEKEND EDITION", width / 2, barTextY);
    ctx.textAlign = "right";
    ctx.fillText(config.volumeText || "VOL. III NO. I", width - margin - 15, barTextY);

    yCursor += barHeight + 20;

    // 4. HEADLINE SECTION
    ctx.textAlign = "center";
    drawScaledText(ctx, config.headline, width / 2, yCursor, 920, 85, fontStack, true);
    yCursor += 70;

    ctx.font = `italic 28px ${fontStack}`;
    yCursor += drawWrappedText(ctx, config.subHeadline, width / 2, yCursor, 860, 35, fontStack) + 8;

    ctx.font = `bold 15px ${fontStack}`;
    ctx.fillText(`|  WRITTEN BY ${config.writer.toUpperCase()}  |  EDITED BY ${config.editor.toUpperCase()}  |  CREATED BY ${config.creator.toUpperCase()}  |`, width / 2, yCursor);
    yCursor += 28;

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.moveTo(margin, yCursor); ctx.lineTo(width - margin, yCursor); ctx.stroke();
    yCursor += 15;

    // 5. COLUMN CONTENT
    const colGap = 40;
    const colWidth = (width - (margin * 2) - colGap) / 2;
    const rightX = margin + colWidth + colGap;
    const columnTopY = yCursor;
    const columnBottomY = 960;

    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.moveTo(width / 2, columnTopY);
    ctx.lineTo(width / 2, columnBottomY);
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.font = `21px ${fontStack}`;
    const lineHeight = 28;

    const firstPartTargetHeight = 360;
    const storyRemainder = drawFlowingText(ctx, config.leadStory, margin, columnTopY, colWidth, lineHeight, firstPartTargetHeight);

    // AD BOX
    const adY = columnTopY + firstPartTargetHeight - 20;
    const adHeight = 135;
    ctx.strokeRect(margin, adY, colWidth, adHeight);

    ctx.textAlign = "center";
    ctx.font = `bold 22px ${fontStack}`;
    ctx.fillText(config.ad1.title, margin + colWidth / 2, adY + 25);
    ctx.font = `italic 17px ${fontStack}`;
    drawWrappedText(ctx, config.ad1.text, margin + colWidth / 2, adY + 60, colWidth - 40, 22, fontStack);

    // Story continues
    ctx.textAlign = "left";
    ctx.font = `21px ${fontStack}`;
    const storyPart2Y = adY + adHeight + 12;
    const storyPart2MaxH = columnBottomY - storyPart2Y;
    const finalRemainder = drawFlowingText(ctx, storyRemainder, margin, storyPart2Y, colWidth, lineHeight, storyPart2MaxH);

    // RIGHT COLUMN
    const quoteBoxH = 150;
    const rightStoryMaxH = (columnBottomY - columnTopY) - quoteBoxH - 12;
    drawFlowingText(ctx, finalRemainder, rightX, columnTopY, colWidth, lineHeight, rightStoryMaxH);

    // QUOTE BOX
    const quoteY = columnBottomY - quoteBoxH;
    ctx.strokeRect(rightX, quoteY, colWidth, quoteBoxH);
    ctx.font = `italic 20px ${fontStack}`;
    drawWrappedText(ctx, `“${config.quotes[0].text}”`, rightX + 25, quoteY + 32, colWidth - 50, 26, fontStack);

    ctx.textAlign = "right";
    ctx.font = `bold 16px ${fontStack}`;
    ctx.fillText(`— ${config.quotes[0].author}`, rightX + colWidth - 25, quoteY + quoteBoxH - 38);
};

/** HELPER: Scales text to fit width */
function drawScaledText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    startSize: number,
    fontStack: string,
    isBold: boolean = false
): void {
    let size = startSize;
    const weight = isBold ? "bold" : "normal";
    ctx.font = `${weight} ${size}px ${fontStack}`;
    while (ctx.measureText(text).width > maxWidth && size > 10) {
        size--;
        ctx.font = `${weight} ${size}px ${fontStack}`;
    }
    ctx.fillText(text, x, y);
}

/** HELPER: Wraps and returns height */
function drawWrappedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    _fontStack: string
): number {
    if (!text) return 0;
    const words = text.split(/\s+/);
    let line = '';
    let linesDrawn = 0;
    for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        if (ctx.measureText(testLine).width > maxWidth && n > 0) {
            ctx.fillText(line, x, y + (linesDrawn * lineHeight));
            line = words[n] + ' ';
            linesDrawn++;
        } else { line = testLine; }
    }
    ctx.fillText(line, x, y + (linesDrawn * lineHeight));
    return (linesDrawn + 1) * lineHeight;
}

/** HELPER: Flows text and returns overflow string */
function drawFlowingText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxHeight: number
): string {
    if (!text || text.trim() === "") return "";
    const words = text.split(/\s+/);
    let line = '';
    let linesDrawn = 0;
    for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i] + ' ';
        if (ctx.measureText(testLine).width > maxWidth && i > 0) {
            if ((linesDrawn + 1) * lineHeight > maxHeight) {
                return words.slice(i).join(' ');
            }
            ctx.fillText(line, x, y + (linesDrawn * lineHeight));
            line = words[i] + ' ';
            linesDrawn++;
        } else { line = testLine; }
    }
    if (line.length > 0 && (linesDrawn + 1) * lineHeight <= maxHeight) {
        ctx.fillText(line, x, y + (linesDrawn * lineHeight));
        return "";
    }
    return line + words.slice(words.length).join(' ');
}