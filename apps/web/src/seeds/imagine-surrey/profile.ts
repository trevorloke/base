import type { ClientProfile } from "../profile-types";

export const profile: ClientProfile = {
  orgName: "Imagine Surrey",
  email: "hello@imaginesurrey.ca",
  uidDomain: "imaginesurrey.ca",
  place: "Surrey",
  placeLine: "Surrey, BC",
  defaultCity: "Surrey",
  fundName: "Imagine Victory Fund",
  trackerName: "Safe Surrey promise tracker",
  homeCampaigns: {
    pledge: "stop-mccallum-pledge",
    petition: "skytrain-south-surrey",
    titles: { "stop-mccallum-pledge": "Stop Doug McCallum and Mandeep Nagra pledge", "skytrain-south-surrey": "SkyTrain to South Surrey petition" },
    petitionAsk: { title: "Sign the SkyTrain petition", body: "Call on the mayor to keep his promise and bring SkyTrain all the way to South Surrey." },
  },
  places: {
    // The six town centres.
    names: ["Newton", "Whalley", "Fleetwood", "Cloverdale", "Guildford", "South Surrey"],
    slugs: { newton: "Newton", whalley: "Whalley", fleetwood: "Fleetwood", cloverdale: "Cloverdale", guildford: "Guildford", "south-surrey": "South Surrey" },
    // Forward sortation areas to town centres.
    postalAreas: {
      V3T: "Whalley",
      V3V: "Whalley",
      V3R: "Guildford",
      V4N: "Fleetwood",
      V3W: "Newton",
      V3X: "Newton",
      V3S: "Cloverdale",
      V3Z: "South Surrey",
      V4A: "South Surrey",
      V4P: "South Surrey",
    },
    outside: "Outside Surrey",
    campuses: ["Kwantlen Cloverdale", "Kwantlen Newton", "SFU Surrey", "Another campus"],
  },
};
