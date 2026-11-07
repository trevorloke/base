// The two campaigns the home page was designed around. `npm run db:seed`
// loads them once; after that they are edited in /admin. Organizers can set
// goals, share text and the council addresses for the "email council" action.
export const seedCampaigns = [
  {
    slug: "stop-mccallum-pledge",
    kind: "pledge" as const,
    title: "Stop Doug McCallum and Mandeep Nagra",
    body: "Cuts, fee hikes, and deals for his friends, all at your expense. Imagine Surrey is the organized voice of residents who won't let it happen quietly.",
    statement:
      "I won't sit back while City Hall gets run for insiders. I'll watch every cut, fee hike, and backroom deal, speak up when it counts, and vote to replace Doug McCallum and Mandeep Nagra at the next election.",
    goal: 1000,
    question: null,
    shareText: "I signed the pledge to stop McCallum's chaos at Surrey City Hall. Add your name:",
    sortOrder: 0,
  },
  {
    slug: "skytrain-south-surrey",
    kind: "petition" as const,
    title: "Get SkyTrain to South Surrey",
    body: "Doug promised SkyTrain to 64 Avenue. It still stops at King George. We're calling on Mayor McCallum to commit in writing to SkyTrain reaching at least 64 Avenue, get the extension into TransLink's next investment plan, and report to residents every year on what's funded, designed and built.",
    statement: "I'm calling on Mayor Doug McCallum to keep his promise and bring SkyTrain all the way to South Surrey.",
    goal: 2500,
    question: "Where do you think the line should end? (optional)",
    shareText: "I signed the petition for SkyTrain all the way to South Surrey. Add your name:",
    sortOrder: 1,
  },
];
