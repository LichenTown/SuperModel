interface ItemModelDetails {
    type?: string; // Type of item to override, e.g. "apple".
    types?: string[]; // Override multiple item types, e.g. ["apple", "carrot"].
    texture?: string; // Name of default texture in SM type folder..
    textures?: Record<string, string>; // Map of texture key -> texture filename in the same folder.
    model?: string | { parent?: string; name: string; data: object }; // Name of model in SM type folder or raw model data.
    models?: Record<string, string | { parent?: string; name: string; data: object }>; // Map of type -> filename or raw model data.
    definition?: Record<string, any>; // Overrides model definition in minecraft/items/<type>.json
}

export type { ItemModelDetails };
