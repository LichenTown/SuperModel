interface ItemModelDetails {
    type?: string; // Type of item to override, e.g. "apple".
    types?: string[]; // Override multiple item types, e.g. ["apple", "carrot"].
    texture?: string; // Name of default texture in SM type folder..
    textures?: Record<string, string>; // Map of texture key -> texture filename in the same folder.
    variants?: string[]; // Array of variant textures to automatically generate simple variant models for.
    variant?: string; // Internal use only.
    model?: string | { parent?: string; name: string; data: object }; // Name of the primary model in the SM type folder or raw model data.
    models?: (string | { parent?: string; name: string; data: object })[]; // Additional models to be imported for external reference.
    definition?: Record<string, any>; // Overrides primary model definition.
}

export type { ItemModelDetails };
