type PreparationLifetime = {
  retire(ownerDialog?: HTMLDialogElement): void;
  open(nextDialog: HTMLDialogElement): void;
  capture(): { signal: AbortSignal; current(): boolean };
};

const preparationLifetimes = new WeakMap<Document, PreparationLifetime>();

export function meetingPreparationLifetime(document: Document): PreparationLifetime {
  if (!preparationLifetimes.has(document)) {
    let controller = new AbortController(), dialog: HTMLDialogElement | null = null;
    const retire = (ownerDialog?: HTMLDialogElement) => {
      if (ownerDialog && dialog !== ownerDialog) return;
      controller.abort(); controller = new AbortController(); dialog = null;
    };
    preparationLifetimes.set(document, {
      retire,
      open(nextDialog) { if (dialog) retire(); dialog = nextDialog; },
      capture() {
        const signal = controller.signal;
        return { signal, current: () => !signal.aborted && (!dialog || dialog.open) };
      },
    });
  }
  return preparationLifetimes.get(document)!;
}

