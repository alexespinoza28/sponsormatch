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

Also from the Oct 22 live probe:
- `rank-artists-ok.json`: `qloo_rank` with option_type artist, bare names as
  options and a brand ID in signals: ok with no needs_input; results carry
  entity_id, name, type "urn:entity", subtype "urn:entity:artist", popularity,
  affinity, properties.
- `compare-audiences.json`: `results` is an object `{tags, a, b, matchEntities}`.
  `tags[]` are shared tastes with `query.score`; `a[]`/`b[]` are each side's own
  tags with `query.count`. `target_type: "brand"` adds no brand rows
  (`matchEntities` empty), so there are no per-side affinities.
- `trends.json`: `series[].entity` has input/entityId/name/type/match; points are
  weekly and newest first with population_percentile (0..1), population_rank
  (a string), population_rank_velocity, velocity_fold_change,
  population_percent_delta. A window ending today returns `points: []` (data
  lags); the third series reproduces that. A big act can be flat (velocity 0),
  like the second series.
