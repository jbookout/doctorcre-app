export declare const tourId: string;
export declare const detail: {
  id: string;
  name: string;
  routes: [
    {
      id: string;
      accepted: boolean;
      route_version: number;
      stops: [
        { property_name: string; locked_appointment?: boolean },
        { property_name: string; locked_appointment?: boolean },
      ];
    },
  ];
};
