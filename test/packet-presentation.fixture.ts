export function presentedPacket(stops: Array<Record<string, unknown>>) {
  return {
    stops,
    presentation: {
      version: "2.0.0",
      title: "Your property tour",
      overview: "Tour day at a glance",
      properties: "Properties",
      notes: "My Notes",
      map: "Tour map",
      brand: "CARR Healthcare Real Estate",
      summary: `${stops.length} ${stops.length === 1 ? "property" : "properties"} in tour order.`,
      stops: stops.map((stop) => ({
        ...stop,
        facts: (
          [
            ["suite", "Suite"],
            ["property_type", "Property type"],
            ["size", "Size"],
            ["asking_economics", "Asking economics"],
            ["availability", "Availability"],
            ["parking", "Parking"],
          ] as const
        ).map(([key, label]) => {
          const value = stop[key];
          return { label, value: value == null ? "Unknown" : typeof value === "object" ? "1200 SF" : String(value) };
        }),
      })),
    },
  };
}
