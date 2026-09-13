// src/facts/version.js
// The import-facts document's schema version — a SEPARATE version line from
// `src/schema.js`'s `SCHEMA_VERSION` (the findings envelope's), so a change
// to the facts shape never implies one to the findings envelope and vice
// versa. Both are `1.0` today; a field added to the facts document bumps its
// minor, a renamed or removed one its major.
//
// A dependency-free leaf on purpose: `src/schema.js` (loaded by every
// lockfile command) imports THIS file to stamp `buildFactsEnvelope`, and the
// facts barrel re-exports it — neither side pulls the other's imports in.
export const FACTS_SCHEMA_VERSION = '1.0';
