export function isTextEntry(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return true;
  const target = event.target;
  const editable = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  return event.ctrlKey && event.altKey && !event.metaKey && Array.from(event.key).length === 1 && editable;
}
