import * as Y from "yjs";

export class TreeCrdt {
  private doc: Y.Doc;
  private arr: Y.Array<string>;

  constructor(state?: Uint8Array) {
    this.doc = new Y.Doc();
    this.arr = this.doc.getArray<string>("children");
    if (state) {
      Y.applyUpdate(this.doc, state);
    }
  }

  insert(childId: string, index: number): void {
    this.arr.insert(index, [childId]);
  }

  move(childId: string, index: number): void {
    const current = this.arr.toArray();
    const oldIndex = current.indexOf(childId);
    if (oldIndex === -1) return;
    this.doc.transact(() => {
      this.arr.delete(oldIndex);
      const newIndex = index > oldIndex ? index - 1 : index;
      this.arr.insert(newIndex, [childId]);
    });
  }

  delete(childId: string): void {
    const current = this.arr.toArray();
    const index = current.indexOf(childId);
    if (index !== -1) this.arr.delete(index);
  }

  toArray(): string[] {
    return this.arr.toArray();
  }

  getState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }
}

export function treeOperationPayload(
  parentId: string,
  update: Uint8Array
): object {
  return { parentId, update };
}
