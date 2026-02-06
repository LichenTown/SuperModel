interface Config {
    sourceRepo?: string; /* SuperModel source repository. If you want to provide a server resource pack, or if you want to use a custom fork, set this to your repo. */
    resourcePackRepo?: string; /* Resource pack repository, should point towards your resource pack assets. */
    resourcePackBranch?: string; /* Branch of resource pack repository to use, defaults to main. */
    packName: string; /* Name to use for the generated resource pack. */
    version: string; /* Version to use for the generated resource pack. */
    minecraftVersion: string; /* Minecraft version your resource pack is made for. */
    deployPath: string; /* Path to your resource packs directory for watch task deployment. */
    ignoredFiles: string[]; /* File paths to ignore when watching for changes. */
}

export type { Config };