interface Window {
  editorRetirementClient: { library(): Promise<unknown> };
  editorRetirementNavigations: number;
  editorRetirementPanel: ReturnType<typeof import("../src/ui/deal-tours.tsx").mountDealTours>;
  editorRetirementFrame: Window | null;
  editorRetirementGeneration: number;
  editorRetirementControls: HTMLButtonElement[];
}

interface Window {
  __tourProofDispose: () => void;
}
