// src/facts/version.js
// The import-facts document's schema version — a SEPARATE version line from
// `src/schema.js`'s `SCHEMA_VERSION` (the findings envelope's), so a change
// to the facts shape never implies one to the findings envelope and vice
// versa. `src/schema.js`'s version is still `1.0`; a field added to the
// facts document bumps its minor, a renamed or removed one its major. Bumped
// to `1.1` when `workspace.aliasScope` and `workspace.devDeclaredBy` were
// added — both are additive, so a consumer already reading `1.0` still
// parses the document, but can now tell "this producer predates these
// fields" apart from "no manifest made a dev claim", which is the whole
// point of tracking the minor at all.
//
// A dependency-free leaf on purpose: `src/schema.js` (loaded by every
// lockfile command) imports THIS file to stamp `buildFactsEnvelope`, and the
// facts barrel re-exports it — neither side pulls the other's imports in.
export const FACTS_SCHEMA_VERSION = '1.1';
