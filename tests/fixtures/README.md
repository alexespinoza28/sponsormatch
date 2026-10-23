Synthetic `qloo mcp` result envelopes for unit tests. The envelope shape
follows the harness tools' outputSchema (result schema 1.0-preview.1) and the
compact result shapes in @qloo/qloo-harness 0.1.26. Every name, ID and score is
invented; none of it is Qloo data (Qloo responses may not be committed).

Shapes confirmed by the Oct 22 live test and mirrored here:
- `capabilities-ready.json`: ready=true, all 9 operations allowed.
- `recommend-needs-input-artist-person.json`: a bare act name in `signals`
  matches an artist and a person; candidates carry id/type/name/popularity.
- `recommend-brands-explain.json`, `rank-brands-ok.json`: result keys
  entity_id, name, type, subtype, popularity, affinity, explainability,
  properties; explainability is `{"signal.interests.entities":[{entity_id, score}]}`.

Assumed (not yet seen live): `compare-brands.json` (the harness passes
/v2/analysis/compare `results` through unchanged) and `trends.json` (raw
/v2/trending points). The parsers in src/lib/optimizer/parse.ts accept several
layouts and report an unrecognized one instead of guessing.
