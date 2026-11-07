// The volunteer shift calendar, driven in a real browser: dragging names onto
// shifts, recolouring by task, moving and removing shifts, tap mode, copying a
// week, and the CSV export.
import { chromium } from "playwright";
import { BASE, sql, ok, finish, adminLogin } from "./helpers.mjs";

/** Poll until the condition holds (saves are async), so a busy machine doesn't fail the suite. */
async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

await sql`insert into people (email, first_name, last_name, phone, neighbourhood, interest_volunteer) values
  ('priya@example.com','Priya','Sandhu','604-555-0101','Newton',true),
  ('marco@example.com','Marco','Reyes','604-555-0102','Whalley',true),
  ('li@example.com','Li','Chen',null,'Fleetwood',true),
  ('dana@example.com','Dana','Okafor','604-555-0104','Cloverdale',true),
  ('notvol@example.com','Sam','Bishop',null,'Guildford',false)
  on conflict (email) do update set interest_volunteer = excluded.interest_volunteer`;
await sql`delete from shifts`;
await sql`delete from shift_openings`;
await sql`delete from volunteer_tasks where name = 'Canvassing training'`;
const volunteers = (await sql`select count(*)::int c from people where interest_volunteer`)[0].c;

const saturdayAfter = (sunday) => {
  const d = new Date(`${sunday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 13);
  return d.toISOString().slice(0, 10);
};
const taskOf = async (first) => (await sql`select t.name from shifts s join volunteer_tasks t on t.id = s.task_id join people p on p.id = s.person_id where p.first_name = ${first}`)[0]?.name;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("dialog", (d) => d.accept());
await adminLogin(page);
await page.goto(BASE + "/admin/shifts");

ok((await page.locator(".shift-day").count()) === 7, "seven day columns, Sunday first: " + (await page.locator(".shift-weekday").first().textContent()));
ok((await page.locator(".roster-name").count()) === volunteers, `roster lists the ${volunteers} volunteers, not non-volunteers`);
const cell = (day, slot) => page.locator(".shift-cell").nth(slot * 7 + day);

await page.locator(".roster-name", { hasText: "Priya" }).dragTo(cell(1, 0));
await page.waitForTimeout(400);
ok((await cell(1, 0).locator(".shift-chip", { hasText: "Priya" }).count()) === 1, "drag name onto Monday morning");
ok((await taskOf("Priya")) === "Door-knocking", "saved with the selected task");
const bg = await cell(1, 0).locator(".shift-chip").evaluate((e) => getComputedStyle(e).backgroundColor);
ok(bg === "rgb(0, 57, 121)", "chip is navy for Door-knocking: " + bg);

await page.locator(".task-pill", { hasText: "Phone bank" }).click();
await page.locator(".roster-name", { hasText: "Marco" }).dragTo(cell(2, 2));
await page.waitForTimeout(400);
const marco = (await sql`select t.name || ' ' || s.slot as v from shifts s join volunteer_tasks t on t.id = s.task_id join people p on p.id = s.person_id where p.first_name = 'Marco'`)[0]?.v;
ok(marco === "Phone bank evening", "second brush colour applied");

await page.locator(".task-pill", { hasText: "Events" }).dragTo(cell(1, 0).locator(".shift-chip"));
await page.waitForTimeout(400);
ok((await taskOf("Priya")) === "Events", "drag colour onto a shift recolours it");

await cell(1, 0).locator(".shift-chip").dragTo(cell(3, 1));
await page.waitForTimeout(400);
const moved = (await sql`select extract(dow from date)::int || ' ' || slot as v from shifts s join people p on p.id = s.person_id where p.first_name = 'Priya'`)[0]?.v;
ok(moved === "3 afternoon", "drag shift moves it to another day and time");

await page.locator(".roster-name", { hasText: "Priya" }).dragTo(cell(3, 1));
await page.waitForTimeout(300);
ok((await page.locator("[role=status].alert").textContent()).includes("already on that shift"), "double-booking the same slot is refused");

await page.locator(".roster-name", { hasText: "Li Chen" }).click();
await cell(6, 0).locator(".shift-add").click();
await page.waitForTimeout(400);
ok((await cell(6, 0).locator(".shift-chip", { hasText: "Li" }).count()) === 1, "tap a name then a slot (phone-friendly)");
await page.keyboard.press("Escape");

await cell(6, 0).locator(".shift-chip").click();
await page.locator(".shift-menu-item", { hasText: "Office" }).click();
await page.waitForTimeout(400);
ok((await taskOf("Li")) === "Office", "click a shift to pick its task from a menu");
ok((await page.locator(".roster-name", { hasText: "Marco" }).locator(".roster-count").textContent()) === "1", "roster shows shift count");

await cell(2, 2).locator(".shift-chip").dragTo(page.locator(".roster-drop-hint"));
ok(await until(async () => (await sql`select count(*)::int c from shifts s join people p on p.id = s.person_id where p.first_name = 'Marco'`)[0].c === 0), "drag shift back to the list removes it");

await page.fill(".roster input[type=search]", "Bish");
await page.locator(".roster-name", { hasText: "Sam Bishop" }).waitFor();
await page.locator(".roster-name", { hasText: "Sam Bishop" }).dragTo(cell(0, 2));
await page.waitForTimeout(400);
ok((await sql`select count(*)::int c from shifts s join people p on p.id = s.person_id where p.first_name = 'Sam'`)[0].c === 1, "search finds non-volunteers and they can be dragged in");
ok((await cell(0, 2).locator(".shift-chip", { hasText: "Sam Bishop" }).count()) === 1, "dragged-in non-volunteer shows by name right away");

await page.click("text=+ New task");
await page.fill("#task-name", "Canvassing training");
await page.locator(".color-choice").nth(6).click();
await page.click('button:has-text("Add task")');
await page.waitForTimeout(400);
ok((await sql`select color from volunteer_tasks where name = 'Canvassing training'`)[0]?.color === "#0E9AA7", "new task created with chosen colour");
ok((await page.locator(".task-pill[aria-checked=true]", { hasText: "Canvassing" }).count()) === 1, "new task becomes the active colour");

await page.click('a[aria-label="Next week"]');
await page.waitForURL(/week=/);
await page.click("text=Copy last week");
ok(await until(async () => (await page.locator(".shift-chip").count()) === 3), "copy last week repeats the 3 shifts");
await page.reload();
ok(await until(async () => (await page.locator(".shift-chip").count()) === 3), "shifts persist after reload");

// ── Keyboard: a chip's menu is a real menu; "Move to…" moves with selects ──
const weekSunday = new URL(page.url()).searchParams.get("week");
const priyaChip = page.locator(".shift-chip", { hasText: "Priya" });
const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
const arrowTo = async (label) => {
  for (let i = 0; i < 20 && (await focused()) !== label; i++) await page.keyboard.press("ArrowDown");
};
await priyaChip.focus();
await page.keyboard.press("Enter");
ok((await page.locator(".shift-menu[role=menu]").count()) === 1, "Enter on a chip opens a menu");
ok((await page.locator(".shift-menu [role=menuitemradio]").first().evaluate((el) => el === document.activeElement)) === true, "focus moves into the menu");
await page.keyboard.press("End");
ok((await focused()) === "Remove from shift", "End jumps to the last item");
await page.keyboard.press("Home");
await arrowTo("Move to…");
await page.keyboard.press("Enter");
ok((await page.locator(".shift-menu[role=dialog]").count()) === 1, "Move to… opens the day and time dialog");
const dialogSelects = page.locator(".shift-menu[role=dialog] select");
ok((await dialogSelects.first().evaluate((el) => el === document.activeElement)) === true, "focus lands on the day select");
await dialogSelects.nth(0).selectOption({ index: 5 });
await dialogSelects.nth(1).selectOption("evening");
await dialogSelects.nth(1).focus();
await page.keyboard.press("Tab");
ok((await focused()) === "Move", "Tab reaches the Move button");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
const kbMoved = (await sql`select extract(dow from date)::int || ' ' || slot as v from shifts s join people p on p.id = s.person_id where p.first_name = 'Priya' and date >= ${weekSunday}`)[0]?.v;
ok(kbMoved === "5 evening", "keyboard move via the menu: " + kbMoved);
ok((await cell(5, 2).locator(".shift-chip", { hasText: "Priya" }).count()) === 1, "moved chip shows in Friday evening");
ok((await cell(5, 2).locator(".shift-chip").evaluate((el) => el === document.activeElement)) === true, "focus follows the moved chip");

await page.keyboard.press("Enter");
await arrowTo("Confirmed");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
ok((await sql`select status from shifts s join people p on p.id = s.person_id where p.first_name = 'Priya' and date >= ${weekSunday}`)[0]?.status === "confirmed", "status change from the menu");
ok((await cell(5, 2).locator(".shift-chip").textContent()).includes("Confirmed"), "chip shows its status");
ok((await cell(5, 2).locator(".shift-chip").evaluate((el) => el === document.activeElement)) === true, "focus returns to the chip after choosing");
await page.keyboard.press("Enter");
await page.keyboard.press("Escape");
ok((await page.locator(".shift-menu").count()) === 0 && (await cell(5, 2).locator(".shift-chip").evaluate((el) => el === document.activeElement)) === true, "Escape closes the menu and returns focus");

ok((await page.locator(".shift-grid[role=table] [role=row]").count()) === 4, "board is a table: a header row and three slot rows");
ok((await page.locator(".shift-grid [role=columnheader]").count()) === 8, "corner cell is a column header too");
const badId = await page.evaluate(() => fetch("/api/admin/shifts/not-a-uuid", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) }).then((r) => r.status));
ok(badId === 404, "PATCH with a bad id is a 404");

// ── Openings panel ──
await page.click("text=+ New opening");
await page.fill("#op-title", "Door-knocking in Newton");
await page.fill("#op-date", saturdayAfter(weekSunday));
await page.selectOption("#op-slot", "morning");
await page.selectOption("#op-neighbourhood", "Newton");
await page.fill("#op-capacity", "4");
await page.fill("#op-location", "Newton Seniors Centre");
await page.click('button:has-text("Add opening")');
await page.locator(".opening-row", { hasText: "Door-knocking in Newton" }).waitFor();
const opening = (await sql`select * from shift_openings where title = 'Door-knocking in Newton'`)[0];
ok(opening && opening.capacity === 4 && opening.neighbourhood === "Newton" && opening.published && opening.slot === "morning", "opening created from the panel");
const row = page.locator(".opening-row", { hasText: "Door-knocking in Newton" });
ok((await row.locator(".opening-row-count").textContent()).includes("0 of 4"), "panel shows the sign-up count");
await row.locator("button", { hasText: "Sign-ups" }).click();
const emptyShown = await row.locator(".opening-signups", { hasText: "Nobody has signed up yet" }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
ok(emptyShown, "sign-ups list is empty for a new opening");
await row.locator("button", { hasText: "Unpublish" }).click();
await page.waitForTimeout(500);
ok((await sql`select published from shift_openings where id = ${opening.id}`)[0].published === false, "unpublish from the panel");
ok((await page.locator(".opening-row.is-draft", { hasText: "Door-knocking in Newton" }).count()) === 1, "draft openings are marked");

// A shift on an opening that is moved to another day or time leaves the opening (frees its spot); a status change does not.
const [mover] = await sql`insert into people (email, first_name) values ('mover-e2e@example.com', 'Mover') on conflict (email) do update set first_name = 'Mover' returning id`;
const [onOpening] = await sql`insert into shifts (person_id, date, slot, opening_id, status) select ${mover.id}, date, slot, id, 'scheduled' from shift_openings where id = ${opening.id} returning id`;
const patchShift = (id, body) => page.evaluate(([id, body]) => fetch(`/api/admin/shifts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status), [id, body]);
ok((await patchShift(onOpening.id, { status: "confirmed" })) === 200 && (await sql`select opening_id from shifts where id = ${onOpening.id}`)[0].opening_id === opening.id, "a status change keeps the shift on its opening");
ok((await patchShift(onOpening.id, { slot: "evening" })) === 200 && (await sql`select opening_id from shifts where id = ${onOpening.id}`)[0].opening_id === null, "moving the shift to another time takes it off the opening");
await sql`delete from shifts where id = ${onOpening.id}`;

const anon = await (await fetch(BASE + "/api/admin/shifts", { method: "POST", body: "{}" })).status;
ok(anon === 401, "shift API requires admin sign-in");
const csv = await page.evaluate(async () => (await fetch("/api/admin/export/shifts")).text());
ok(csv.startsWith("date,slot,volunteer") && csv.includes("Priya Sandhu") && csv.includes("Office"), "shifts CSV export");

const mobile = await browser.newPage({ viewport: { width: 390, height: 900 } });
await mobile.context().addCookies(await page.context().cookies());
await mobile.goto(BASE + "/admin/shifts");
const phone = await mobile.evaluate(() => {
  const wide = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.right > 390.5 && el.closest(".shift-grid-wrap") === null) wide.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")}@${Math.round(r.right)}`);
  }
  return { width: document.documentElement.scrollWidth, wide: wide.slice(0, 6) };
});
ok(phone.width <= 390, `shift board has no sideways scroll on a phone${phone.width > 390 ? ` (${phone.width}px: ${phone.wide.join(", ")})` : ""}`);

await browser.close();
await finish();
