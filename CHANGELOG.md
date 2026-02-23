# Changelog

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
