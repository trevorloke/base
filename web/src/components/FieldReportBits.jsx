// The field report's piece of Today (server/ext/fieldreport): a person's
// all-time line under More — "All time: 212 doors · 96 talks · 31
// supporters found" — from the brief's field.mine_all, so it reads with no
// signal too (the brief is kept). Nothing when the brief has no such line.
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const word = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);

export function MineAllTime({ all }) {
  if (!all) return null;
  const { doors, talked, support_found: found } = all;
  return (
    <p className="today-mine is-small">
      All time: <strong className="today-mine__n mono">{num(doors)}</strong> {word(doors, 'door')}
      {' · '}<strong className="today-mine__n">{num(talked)}</strong> {word(talked, 'talk')}
      {' · '}<strong className="today-mine__n">{num(found)}</strong> {word(found, 'supporter')} found
    </p>
  );
}
