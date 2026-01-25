interface EntityModelDetails {
    type?: string; // Type of model to override, e.g. "player".
    types?: string[]; // Override multiple model types, e.g. ["player", "player_slim"].
    texture?: string; // Name of texture file in SM type folder.
    textures?: string[]; // One or more texture filenames.
    model?: string | object; // Name of model file in SM type folder or raw model data.
    models?: Record<string, string | object>; // Map of type -> filename or raw model data.
    properties?: Record<string, string>; // Set of CEM/Optifine format property conditions to apply model under.
    loadPriority?: number; // Load priority for this model (higher = loaded later). Defaults to 5.
}

export type { EntityModelDetails };