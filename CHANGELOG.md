# Changelog

## [2.1.0] - 2026-02-23
### Added
- Budget airline section in Disney Discord embeds ("Peasant Plane Options")
- Spirit and Frontier flights now tracked and displayed separately below premium options
- "Classy Plane Options" header for premium airline flights in Disney trip
- DB helper functions for querying best budget vs non-budget flights per leg

### Changed
- Fetcher now stores all flights including budget airlines (previously excluded)
- `excludeAirlines` config renamed to `budgetAirlines` (tag instead of filter)
- Daily summary includes both classy and budget sections for Disney
- Trip totals still based on classy options only

## [2.0.0] - 2026-02-23
### Added
- Disney World Orlando trip tracking (BOS ↔ MCO, Mar 14–21 2026, 2 passengers)
- Per-trip configuration: passengers, airline exclusions, departure time preferences
- Separate Discord embeds per trip (NZ and Disney independent)
- Per-trip booking links and price totals
- Spirit/Frontier airline exclusion filter for Disney flights
- Morning/evening departure time preference filtering

### Changed
- Alerts system rewritten for multi-trip support with per-trip cooldowns
- SerpAPI now passes per-leg passenger count (adults=N)
- Price totals correctly reflect SerpAPI's all-passenger pricing (no double-counting)
- Daily summary now generates separate embeds per trip with days-until-departure

## [1.0.0] - 2026-02-22
### Added
- Initial release of Flight Price Tracker
- SerpAPI Google Flights integration with retry logic and rate limiting
- SQLite database with WAL mode for price snapshot storage
- Discord webhook alerts: all-time low, price drops, spikes, below-typical, daily summary
- node-cron scheduler polling every 30 minutes with 8 PM daily summary
- Express dashboard with Chart.js price history visualization
- Multi-airport NYC support (JFK/EWR/LGA round-robin)
- Price insights integration from SerpAPI for deal detection
- Total trip cost tracking across all 4 flight legs
