import { ItemModelDetails } from "../Types/index.ts";

/**
 * ItemModel queue for resource pack item model definitions.
 * Mirrors the behavior of EntityModel for consistency.
 */
class ItemModel {
    private static modelQueue: ItemModelDetails[] = [];

    public static add(model: ItemModelDetails): void {
        ItemModel.modelQueue.push(model);
    }

    public static getQueue(): ItemModelDetails[] {
        return ItemModel.modelQueue;
    }

    public static clearQueue(): void {
        ItemModel.modelQueue = [];
    }

    public static getQueueSize(): number {
        return ItemModel.modelQueue.length;
    }
}

export { ItemModel };

