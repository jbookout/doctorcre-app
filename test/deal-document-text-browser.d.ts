interface Window {
  textTest: {
    requests: import("../src/ui/deal-document-text.ts").TextRequest[];
    signals: AbortSignal[];
    resolve(value: unknown): void;
    resolveAt(index: number, value: unknown): void;
    rejectAt(index: number, value: unknown): void;
    reject(value: unknown): void;
    dispose(): void;
  };
}
