type QuoteTestSource = import("../src/ui/deal-document-text.ts").TextIdentity & { filename: string };
type QuoteTestClient = {
  askSession(): Promise<{ actor: string }>;
  submitDocRequest(request: import("../src/ui/queued-asks.ts").AskRequest, actor: string): Promise<unknown>;
  listDocConversations(args: { limit: number; cursor?: string }, options: { signal: AbortSignal }): Promise<unknown>;
  readDocConversation(
    args: { conversation_id: string; limit: number },
    options: { signal: AbortSignal },
  ): Promise<unknown>;
  readDealDocumentText(): Promise<unknown>;
};
interface Window {
  mountQuote(host: HTMLElement, source: QuoteTestSource, value: unknown, client: QuoteTestClient): void;
  mountViewer(host: HTMLElement, source: QuoteTestSource, client: QuoteTestClient): void;
  openViewer(): void;
  quoteRequests: import("../src/ui/queued-asks.ts").AskRequest[];
  originalSetItem: Storage["setItem"];
  pendingText: ((value: unknown) => void)[];
  pendingConversations: (() => void)[];
  holdConversation: boolean;
  axe: { run(element: Element | null): Promise<{ violations: { id: string }[] }> };
}
