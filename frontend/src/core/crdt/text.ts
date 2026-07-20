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

  format(
    index: number,
    length: number,
    attributes: Record<string, unknown>
  ): void {
    this.text.format(index, length, attributes);
  }

  toPlaintext(): string {
    return this.text.toString();
  }

  toDelta(): Array<{ insert?: string | object; attributes?: Record<string, unknown> }> {
    return this.text.toDelta();
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
