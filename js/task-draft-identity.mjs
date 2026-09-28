// Choose whether an in-memory Quick Add draft belongs to the verified actor.
export function draftIdentityPlan(previousActor, nextActor) {
  if (!nextActor) return "refuse";
  if (!previousActor) return "first";
  return previousActor === nextActor ? "reuse" : "replace";
}
