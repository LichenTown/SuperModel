/**
 * Generator
 * Defines exports of generator modules.
 */
interface Generator {
    default: (packPath: string, buildPath: string) => Promise<void>;
    loadPriority?: number;
    generatorName?: string;
}

export type { Generator };
