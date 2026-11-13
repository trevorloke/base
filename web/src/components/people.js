// Small words about a person shared by People and the person search.
//
//   streetLine(p)   "4 – 14520 72 Ave": the unit, then the street
export const streetLine = (p) => [p.unit ? `${p.unit} –` : null, p.address].filter(Boolean).join(' ');
