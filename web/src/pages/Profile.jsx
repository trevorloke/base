// Your profile (anyone, in either app; the account menu's first item): who
// you are here — name, email, role, campaign — and two-step sign-in, which
// anyone can turn on for themselves (components/TwoStep.jsx), and their
// shifts in their own calendar (components/CalendarFeed.jsx), and Google
// (components/GoogleCard.jsx), when this server has it.
import { useOutletContext } from 'react-router-dom';
import TwoStepCard from '../components/TwoStep.jsx';
import CalendarFeedCard from '../components/CalendarFeed.jsx';
import GoogleCard from '../components/GoogleCard.jsx';
import '../components/two-step.css';

const ROLE_WORD = { manager: 'Manager', treasurer: 'Treasurer', staff: 'Staff', volunteer: 'Volunteer' };

export default function Profile() {
  const { me } = useOutletContext();
  // The field app shows a desk role as a volunteer; their real role is admin_role.
  const role = me.admin_role || me.role;
  return (
    <div className="me-page">
      <h1>Your profile</h1>
      <dl className="me-who">
        <div><dt>Name</dt><dd>{me.user.name}</dd></div>
        <div><dt>Email</dt><dd className="me-email">{me.user.email}</dd></div>
        <div><dt>Role</dt><dd>{ROLE_WORD[role] || role} · {me.workspace.name}</dd></div>
      </dl>
      <TwoStepCard me={me} />
      <CalendarFeedCard me={me} />
      <GoogleCard />
    </div>
  );
}
