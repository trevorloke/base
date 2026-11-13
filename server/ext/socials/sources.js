// A sign-up's source as people read it: a share kit's "kit-<code>" is the
// post's own name ("Share: Sign for SkyTrain"), or "Share kit" when no post
// has that code; any other source as it was kept. No imports, so History
// and the website reads can use it without loading the rest of socials.
export const KIT_SOURCE = /^kit-([a-z0-9]{6})$/;

// SQL: the kit code inside a source column, null for any other source.
export const kitCodeSql = (source) => `substring(${source} from '^kit-([a-z0-9]{6})$')`;

export const sourceWords = (source, kitTitle = null) => (KIT_SOURCE.test(String(source || ''))
  ? (kitTitle ? `Share: ${kitTitle}` : 'Share kit')
  : source);
