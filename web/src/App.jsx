// Routes + auth gate, for two apps (mode.js):
//   field  (/)        Today · Map · Calls · Shifts · ImagineU — a volunteer's
//                     screens, for every role (a manager sees them as a
//                     volunteer would). A desk address typed here goes to
//                     the admin.
//   admin  (/admin/…) the desk: everything, for desk roles and volunteers
//                     given an area; a plain volunteer is told it's not theirs.
// Real URLs are the point: every screen, form-open state, selected door, and
// preselected donor lives in the address bar. Screens past Today load on
// demand — the map (Leaflet) is the heaviest and phones in the field
// shouldn't pay for it until they open it.
// Desk-only screens sit under one area guard: someone without the area lands
// back on Today (the server refuses their data anyway).
import { lazy, useState } from 'react';
import { Routes, Route, Navigate, Outlet, useOutletContext, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, noAnswer } from './api.js';
import Shell, { isDesk, hasArea } from './Shell.jsx';
import { ADMIN_BASE, fieldView, mayAdmin } from './mode.js';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Today from './pages/Today.jsx';
const MapPage = lazy(() => import('./pages/Map.jsx'));
const TextingInbox = lazy(() => import('./pages/TextingInbox.jsx'));
const ImagineU = lazy(() => import('./pages/ImagineU.jsx'));
const Banks = lazy(() => import('./pages/Banks.jsx'));
const Lists = lazy(() => import('./pages/Lists.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const TextingThread = lazy(() => import('./pages/TextingThread.jsx'));
const TextingSettings = lazy(() => import('./pages/TextingSettings.jsx'));
const People = lazy(() => import('./pages/People.jsx'));
const Person = lazy(() => import('./pages/Person.jsx'));
const Shifts = lazy(() => import('./pages/Shifts.jsx'));
const Volunteers = lazy(() => import('./pages/Volunteers.jsx'));
const Money = lazy(() => import('./pages/Money.jsx'));
const Signs = lazy(() => import('./pages/Signs.jsx'));
const Outreach = lazy(() => import('./pages/Outreach.jsx'));
const Media = lazy(() => import('./pages/Media.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const ImportPeople = lazy(() => import('./pages/ImportPeople.jsx'));
const Turfs = lazy(() => import('./pages/Turfs.jsx'));
const Receipts = lazy(() => import('./pages/Receipts.jsx'));
const ReceiptsOne = lazy(() => import('./pages/ReceiptsOne.jsx'));
const Ladders = lazy(() => import('./pages/Ladders.jsx'));
const LaddersEdit = lazy(() => import('./pages/LaddersEdit.jsx'));
const LaddersFollowups = lazy(() => import('./pages/LaddersFollowups.jsx'));
const Surveys = lazy(() => import('./pages/Surveys.jsx'));
const SurveysEdit = lazy(() => import('./pages/SurveysEdit.jsx'));
const SurveysResults = lazy(() => import('./pages/SurveysResults.jsx'));
const Scripts = lazy(() => import('./pages/Scripts.jsx'));
const Duplicates = lazy(() => import('./pages/Duplicates.jsx'));
const MembershipForm = lazy(() => import('./pages/MembershipForm.jsx'));
const DataPage = lazy(() => import('./pages/Data.jsx'));
const Stewardship = lazy(() => import('./pages/Stewardship.jsx'));
const ImportGifts = lazy(() => import('./pages/ImportGifts.jsx'));
const GiftsWaiting = lazy(() => import('./pages/GiftsWaiting.jsx'));
const RatingScale = lazy(() => import('./pages/RatingScale.jsx'));
const Fields = lazy(() => import('./pages/Fields.jsx'));
const MyPeople = lazy(() => import('./pages/MyPeople.jsx'));
const Share = lazy(() => import('./pages/Share.jsx'));
const Mainstreet = lazy(() => import('./pages/Mainstreet.jsx'));
const PeopleConnected = lazy(() => import('./pages/PeopleConnected.jsx'));
const Passes = lazy(() => import('./pages/Passes.jsx'));
const Voted = lazy(() => import('./pages/Voted.jsx'));
const Requests = lazy(() => import('./pages/Requests.jsx'));
const FieldReport = lazy(() => import('./pages/FieldReport.jsx'));
const WebsiteHome = lazy(() => import('./pages/WebsiteHome.jsx'));
const WebsitePages = lazy(() => import('./pages/WebsitePages.jsx'));
const WebsitePage = lazy(() => import('./pages/WebsitePage.jsx'));
const WebsiteTheme = lazy(() => import('./pages/WebsiteTheme.jsx'));
const WebsiteSettings = lazy(() => import('./pages/WebsiteSettings.jsx'));
const WebsitePosts = lazy(() => import('./pages/WebsitePosts.jsx'));
const WebsiteCampaigns = lazy(() => import('./pages/WebsiteCampaigns.jsx'));
const WebsiteSites = lazy(() => import('./pages/WebsiteSites.jsx'));
const WebsiteSite = lazy(() => import('./pages/WebsiteSite.jsx'));
const WebsiteSiteDomain = lazy(() => import('./pages/WebsiteSite.jsx').then((m) => ({ default: m.WebsiteSiteDomain })));
const PathToWin = lazy(() => import('./pages/PathToWin.jsx'));
import Join from './pages/Join.jsx';
import { TwoStepRequired } from './components/TwoStep.jsx';
import AuthPage from './components/AuthPage.jsx';
const Profile = lazy(() => import('./pages/Profile.jsx'));

// No answer from the server (wifi with no internet, a restart) is not a
// sign-out: the app opens as who signed in here (main.jsx), on the copies
// kept for them, and asks again every 15 s. Only a refusal goes to Sign in.
const askAgain = (q) => ((q.state.data !== undefined && q.state.dataUpdatedAt === 0)
  || (q.state.status === 'error' && noAnswer(q.state.error)) ? 15_000 : false);
function RequireAuth({ mode }) {
  // The two-step set-up's recovery codes on screen: it stays until they're saved.
  const [twoStepHeld, setTwoStepHeld] = useState(false);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => apiGet('/auth/me'),
    retry: false,
    staleTime: 60_000,
    refetchInterval: askAgain,
  });
  if (me.isLoading) return null;
  if (me.isError && !(noAnswer(me.error) && me.data)) return <Navigate to="/login" replace />;
  // The campaign requires two-step sign-in for this role and it isn't on
  // yet: its set-up stands before everything else (components/TwoStep.jsx).
  if (me.data?.two_step?.must_set_up || twoStepHeld) return <TwoStepRequired me={me.data} onHold={setTwoStepHeld} />;
  if (mode === 'admin' && me.data?.user && !mayAdmin(me.data)) return <NotForYou me={me.data} />;
  return <Shell me={me.data} mode={mode} />;
}

// The admin, opened by a volunteer: not theirs — the field app is.
function NotForYou({ me }) {
  return (
    <AuthPage org={me?.workspace?.name}>
      <h1>Not for your role</h1>
      <p className="muted">The admin is the campaign office’s. You are signed in as {me?.user?.name} (volunteer) — your app is the field app.</p>
      <p><a className="btn btn-primary" href="/">Open the field app</a></p>
    </AuthPage>
  );
}

// A desk address typed into the field app (an old bookmark, a link in an
// email): the admin has it. Volunteers go home, as before.
const DESK_PATHS = /^\/(people(\/(import|fields|connected|duplicates|membership-form))?|shifts\/volunteers|money|lists|reports|data|outreach|media|ladders|follow-ups|surveys|scripts|rating-scale|settings|team|admin|inbox\/settings|passes|voted|requests|field-report|banks\/new|website)(\/|$)/;
function FieldFallback() {
  const ctx = useOutletContext();
  const { pathname, search } = useLocation();
  if (DESK_PATHS.test(pathname) && mayAdmin({ ...ctx?.me, role: ctx?.me?.admin_role || ctx?.me?.role, areas: ctx?.me?.admin_areas || ctx?.me?.areas })) {
    window.location.replace(`${ADMIN_BASE}${pathname}${search}`);
    return null;
  }
  return <Navigate to="/" replace />;
}

// Staff, treasurers and managers only. The Shell's outlet context is passed
// straight through, so pages keep reading { me } from useOutletContext().
// Desk screens: a desk role, or anyone given the screen's area (Admin →
// Permissions); a desk role denied the area is sent home too.
const ROUTE_AREA = [
  [/^\/people\/(import|connected)|^\/lists/, 'people'], [/^\/people\/fields/, 'admin'], [/^\/reports|^\/data(\/|$)/, 'data'],
  [/^\/money/, 'money'], [/^\/outreach|^\/ladders|^\/follow-ups|^\/surveys|^\/scripts|^\/inbox\/settings/, 'outreach'],
  [/^\/team|^\/settings|^\/rating-scale/, 'admin'],
  [/^\/passes/, 'map'],
  [/^\/voted/, 'people'],
  [/^\/requests/, 'people'],
  [/^\/field-report/, 'data'],
  [/^\/website/, 'site'],
  [/^\/media/, 'media'],
  [/^\/path-to-win/, 'data'],
];
function DeskOnly() {
  const ctx = useOutletContext();
  const { pathname } = useLocation();
  const area = ROUTE_AREA.find(([re]) => re.test(pathname))?.[1];
  const ok = area ? hasArea(ctx?.me, area) && (area !== 'admin' || ctx?.me?.role === 'manager') : isDesk(ctx?.me);
  if (!ok) return <Navigate to="/" replace />;
  return <Outlet context={ctx} />;
}

export default function App({ mode = 'field' }) {
  if (mode === 'field') {
    return (
      <Routes>
        <Route path="/login" element={<Login mode={mode} />} />
        <Route path="/signup" element={<Signup mode={mode} />} />
        <Route path="/join/:token" element={<Join mode={mode} />} />
        <Route element={<RequireAuth mode={mode} />}>
          <Route path="/" element={<Today />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/calls" element={<People key="calls" mode="calls" />} />
          {/* Desk addresses that would otherwise read as an id. */}
          <Route path="/people/import" element={<FieldFallback />} />
          <Route path="/people/fields" element={<FieldFallback />} />
          <Route path="/people/connected" element={<FieldFallback />} />
          <Route path="/people/duplicates" element={<FieldFallback />} />
          <Route path="/people/membership-form" element={<FieldFallback />} />
          <Route path="/shifts/volunteers" element={<FieldFallback />} />
          <Route path="/data" element={<FieldFallback />} />
          <Route path="/inbox/settings" element={<FieldFallback />} />
          <Route path="/banks/new" element={<FieldFallback />} />
          <Route path="/people/:id" element={<Person />} />
          <Route path="/shifts" element={<Shifts />} />
          <Route path="/shifts/:id" element={<Shifts />} />
          <Route path="/turfs" element={<Turfs />} />
          <Route path="/turfs/:id" element={<Turfs />} />
          <Route path="/signs" element={<Signs />} />
          <Route path="/inbox" element={<TextingInbox />} />
          <Route path="/inbox/:id" element={<TextingThread />} />
          <Route path="/my-people" element={<MyPeople />} />
          <Route path="/share" element={<Share />} />
          <Route path="/profile" element={<Profile />} />
        <Route path="/mainstreet" element={<Mainstreet />} />
          <Route path="/mainstreet" element={<Mainstreet />} />
          <Route path="/imagineu" element={<ImagineU />} />
          <Route path="/imagineu/:id" element={<ImagineU />} />
          <Route path="/banks" element={<Banks />} />
          <Route path="/banks/:id" element={<Banks />} />
          <Route path="*" element={<FieldFallback />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Login mode={mode} />} />
      <Route path="/signup" element={<Signup mode={mode} />} />
      <Route path="/join/:token" element={<Join mode={mode} />} />
      <Route element={<RequireAuth mode={mode} />}>
        <Route path="/" element={<Today />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/calls" element={<People key="calls" mode="calls" />} />
        <Route path="/people" element={<People />} />
        <Route path="/people/:id" element={<Person />} />
        <Route path="/shifts" element={<Shifts />} />
        <Route path="/shifts/:id" element={<Shifts />} />
        <Route path="/turfs" element={<Turfs />} />
        <Route path="/turfs/:id" element={<Turfs />} />
        <Route path="/signs" element={<Signs />} />
        <Route path="/inbox" element={<TextingInbox />} />
        <Route path="/inbox/:id" element={<TextingThread />} />
        <Route path="/my-people" element={<MyPeople />} />
        <Route path="/share" element={<Share />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/imagineu" element={<ImagineU />} />
        <Route path="/imagineu/:id" element={<ImagineU />} />
        <Route path="/banks" element={<Banks />} />
        <Route path="/banks/:id" element={<Banks />} />
        <Route element={<DeskOnly />}>
          <Route path="/shifts/volunteers" element={<Volunteers />} />
          <Route path="/people/import" element={<ImportPeople />} />
          <Route path="/people/fields" element={<Fields />} />
          <Route path="/people/connected" element={<PeopleConnected />} />
          <Route path="/lists" element={<Lists />} />
          <Route path="/lists/:id" element={<Lists />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/inbox/settings" element={<TextingSettings />} />
          <Route path="/money" element={<Money />} />
          <Route path="/money/receipts" element={<Receipts />} />
          <Route path="/money/receipts/:id" element={<ReceiptsOne />} />
          <Route path="/outreach" element={<Outreach />} />
          <Route path="/outreach/:tab" element={<Outreach />} />
          <Route path="/media" element={<Media />} />
          <Route path="/media/contacts" element={<Media />} />
          <Route path="/media/releases/:id" element={<Media />} />
          {/* Settings: members, teams, permissions (the old /admin and /team). */}
          <Route path="/team" element={<Navigate to="/settings" replace />} />
          <Route path="/admin" element={<Navigate to="/settings" replace />} />
          <Route path="/admin/:tab" element={<SettingsRedirect />} />
          <Route path="/settings" element={<Admin />} />
          <Route path="/settings/:tab" element={<Admin />} />
          <Route path="/ladders" element={<Ladders />} />
          <Route path="/ladders/:id" element={<LaddersEdit />} />
          <Route path="/follow-ups" element={<LaddersFollowups />} />
          <Route path="/surveys" element={<Surveys />} />
          <Route path="/scripts" element={<Scripts />} />
          <Route path="/people/duplicates" element={<Duplicates />} />
          <Route path="/people/membership-form" element={<MembershipForm />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/money/stewardship" element={<Stewardship />} />
          {/* Gifts made in another tool, from its file — and those that need a donor. */}
          <Route path="/money/import" element={<ImportGifts />} />
          <Route path="/money/import/waiting" element={<GiftsWaiting />} />
          <Route path="/surveys/:id" element={<SurveysEdit />} />
          <Route path="/surveys/:id/results" element={<SurveysResults />} />
          <Route path="/rating-scale" element={<RatingScale />} />
          <Route path="/passes" element={<Passes />} />
          <Route path="/voted" element={<Voted />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/field-report" element={<FieldReport />} />
          {/* Website (the 'site' area): the campaign's public site. */}
          <Route path="/website" element={<WebsiteHome />} />
          <Route path="/website/pages" element={<WebsitePages />} />
          <Route path="/website/pages/:id" element={<WebsitePage />} />
          <Route path="/website/theme" element={<WebsiteTheme />} />
          <Route path="/website/settings" element={<WebsiteSettings />} />
          <Route path="/website/news" element={<WebsitePosts />} />
          <Route path="/website/news/:id" element={<WebsitePosts />} />
          <Route path="/website/petitions" element={<WebsiteCampaigns />} />
          <Route path="/website/petitions/:id" element={<WebsiteCampaigns />} />
          {/* The campaign's other websites: their pages and look are the screens above, with the site. */}
          <Route path="/website/sites" element={<WebsiteSites />} />
          <Route path="/website/sites/:siteId" element={<WebsiteSite />} />
          <Route path="/website/sites/:siteId/pages" element={<WebsitePages />} />
          <Route path="/website/sites/:siteId/look" element={<WebsiteTheme />} />
          <Route path="/website/sites/:siteId/domain" element={<WebsiteSiteDomain />} />
          <Route path="/path-to-win" element={<PathToWin />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function SettingsRedirect() {
  const { pathname } = useLocation();
  return <Navigate to={pathname.replace(/^\/admin/, '/settings')} replace />;
}
