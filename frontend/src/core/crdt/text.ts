import * as Y from 'yjs';

export class TextCrdt {
  private doc: Y.Doc;
  private text: Y.Text;

  constructor(state?: Uint8Array) {
    this.doc = new Y.Doc();
    this.text = this.doc.getText('content');
    if (state) {
      Y.applyUpdate(this.doc, state);
    }
  }

  insert(index: number, value: string): void {
    this.text.insert(index, value);
  }

  delete(index: number, length: number): void {
    this.text.delete(index, length);
  }

  toPlaintext(): string {
    return this.text.toString();
  }

  getState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }
}

export function textOperationPayload(
  nodeId: string,
  update: Uint8Array
): object {
  return { nodeId, update };
}
