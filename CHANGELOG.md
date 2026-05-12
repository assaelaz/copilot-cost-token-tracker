# Changelog

## [1.1.2] — 2026-05-12

### Fixed
- Analysis panel not rendering when the same session appears in both Latest and All Sessions views (duplicate DOM ID)
- Turns in Analysis now sorted chronologically (first → last)
- Turns are collapsed by default; expand manually by clicking

### Changed
- Details column shows **multiple** (with full list on hover) when a turn has more than one call type

---

## [1.1.1]

### Added
- **Analysis** per-session view: expandable turn-by-turn breakdown with call-level detail (model, tokens, cache, cost)
- **Expand all / Collapse all** toolbar controls in Analysis
- **30-day** and **Month-to-date** time window options
- Custom date-range picker
- Sub-agent call detection — badges distinguish main-agent vs. sub-agent calls

### Changed
- Analysis default sort by timestamp ascending

---

## [1.1.0]

### Added
- Initial release
- Latest Session, All Sessions, and Aggregate dashboard views
- Per-model token breakdown (fresh input, cached input, output)
- Bundled pricing table with automatic model-key matching
- Cross-platform storage path resolution (macOS, Windows, Linux)
