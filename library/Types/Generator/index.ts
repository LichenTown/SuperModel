/**
 * Generator
 * Defines exported structure of generator modules.
 */
interface Generator {
    default: (packPath: string, buildPath: string) => Promise<void>;
    loadPriority?: number;
}

export type { Generator };
