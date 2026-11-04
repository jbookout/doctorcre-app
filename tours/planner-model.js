export function tourGroups(tours, query = "") {
  const term = query.trim().toLocaleLowerCase();
  const matching = tours.filter(tour => `${tour.name || ""} ${tour.status || ""}`.toLocaleLowerCase().includes(term));
  return {
    upcoming: matching.filter(tour => !["completed", "finished", "cancelled", "canceled", "archived"].includes(tour.status)),
    history: matching.filter(tour => ["completed", "finished", "cancelled", "canceled", "archived"].includes(tour.status)),
  };
}
