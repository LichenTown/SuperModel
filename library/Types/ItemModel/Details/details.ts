interface ItemModelDetails {
    type?: string; // Type of item to override, e.g. "apple".
    types?: string[]; // Override multiple item types, e.g. ["apple", "carrot"].
    texture?: string; // Name of texture in SM type folder.
    textures?: string[]; // One or more texture filenames.
    model?: string | object; // Name of model in SM type folder or raw model data.
    models?: Record<string, string | object>; // Map of type -> filename or raw model data.
    definition?: Record<string, any>; // Overrides model definition in minecraft/items/<type>.json
}

export type { ItemModelDetails };
