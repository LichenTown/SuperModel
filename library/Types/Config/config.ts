interface Config {
    packName: string;
    version: string;
    minecraftVersion: string;
    deployPath: string;
    ignoredFiles: string[];
    format: number;
}

export type { Config };