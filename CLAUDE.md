# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

hot-shots is a Node.js client library for StatsD, DogStatsD (Datadog), and Telegraf (InfluxDB) metrics collection. It provides a comprehensive API for sending various types of metrics (counters, gauges, histograms, etc.) over UDP, TCP, UDS (Unix Domain Sockets), or raw streams.

## Key Architecture

### Core Components
- **lib/statsd.js**: Main Client class and constructor logic
- **lib/transport.js**: Protocol implementations (UDP, TCP, UDS, stream)
- **lib/statsFunctions.js**: Core metric methods (timing, increment, gauge, etc.)
- **lib/helpers.js**: Tag formatting, sanitization, and utility functions
- **lib/constants.js**: Protocol constants and error codes
- **lib/telemetry.js**: Client-side telemetry for DogStatsD (tracks metrics/bytes sent/dropped)
- **index.js**: Main entry point (exports lib/statsd.js)
- **types.d.ts**: TypeScript type definitions

### Protocol Support
The library supports multiple transport protocols:
- **UDP**: Default protocol using dgram sockets
- **TCP**: Persistent connection with graceful error handling
- **UDS**: Unix Domain Sockets (requires unix-dgram optional dependency)
- **Stream**: Raw stream protocol for custom transports

### Client Architecture
- Main Client class handles initialization and configuration
- Transport layer abstracts protocol differences
- Stats functions are mixed into Client prototype
- Child clients inherit parent configuration with overrides

## Development Commands

### Testing
```bash
npm test                    # Run all tests with linting
npm run lint               # Run ESLint on lib and test files
npm run coverage          # Run tests with coverage report
```

### Linting
The project uses ESLint 8.x with pretest hooks. All code must pass linting before tests run.

Key linting rules to follow:
- Use single quotes for strings (not double quotes or backticks for simple strings)
- Always use curly braces for if/else blocks, even single-line ones
- Ternary operators: put `?` and `:` at the end of lines, not the beginning
- No trailing spaces or mixed indentation

### Running Single Tests
```bash
npx mocha test/specific-test.js --timeout 5000
```

## Key Development Patterns

### Error Handling
- Uses errorHandler callback pattern for transport errors
- Graceful error handling for TCP/UDS with restart rate limiting
- Different error handling strategies per protocol

### Metric Buffering
- Optional buffering with maxBufferSize and bufferFlushInterval
- Automatic flushing on buffer size or time intervals
- Buffer management in transport layer

### Tag System
- Supports both object and array tag formats
- Tag sanitization prevents protocol-breaking characters
- Global tags merged with per-metric tags
- Special handling for Telegraf vs StatsD/DogStatsD tag formats

### Child Clients
- Inherit parent configuration
- Can override prefix, suffix, globalTags
- Nested child clients supported

## Protocol-Specific Features

### DataDog (DogStatsD)
- Events and service checks
- Distribution metrics
- Automatic DD_* environment variable tag injection
- Unix Domain Socket support
- Client-side telemetry (opt-in via `includeDatadogTelemetry`)

### DogStatsD-Only Features Pattern
Features specific to DogStatsD (not Telegraf) should:
1. Check `this.telegraf` and throw/return error if true
2. Be disabled in mock mode where appropriate
3. Child clients should inherit parent behavior (e.g., share telemetry instance)

### Telegraf
- Different tag separator format
- Histogram support
- Modified tag sanitization rules

## Testing Approach

The project uses Mocha with 5-second timeouts. Tests are organized by feature:
- Protocol-specific tests (UDP, TCP, UDS)
- Metric type tests (counters, gauges, histograms)
- Error handling and edge cases
- Child client functionality
- Buffering and performance tests
- Telemetry tests

### Test Helpers
Tests use helpers from `test/helpers/helpers.js`:
- `createServer(serverType, callback)` - Creates a test server for the given protocol
- `createHotShotsClient(opts, clientType)` - Creates a client ('client', 'child client', etc.)
- `closeAll(server, statsd, allowErrors, done)` - Properly closes server and client in afterEach
- `testTypes()` - Returns all protocol/client combinations for parameterized tests

## Dependencies

- **Production**: No runtime dependencies (unix-dgram is optional)
- **Development**: eslint, mocha, nyc for testing and linting
- **Optional**: unix-dgram for Unix Domain Socket support

## Important Notes

- TypeScript definitions in types.d.ts must be updated for API changes
- Constructor parameter expansion is deprecated - use options object
- Mock mode available for testing (prevents actual metric sending)
- Add debug logging that can be enabled with "NODE_DEBUG=hot-shots"
- Updates should be noted in CHANGES.md
- API changes should be noted in README.md
