CHANGELOG
=========

* [@72636c](https://github.com/72636c) Omit Claude and GitHub dev files from bundle
* [@bdeitte](https://github.com/bdeitte) Fix TypeScript error from ESM support changes and add TypeScript tests ([#316](https://github.com/bdeitte/hot-shots/issues/316))

## 14.3.0 (2026-4-3)

* [@bdeitte](https://github.com/bdeitte) Add ESM support via `exports` field in package.json and `index.mjs` wrapper, enabling `import StatsD from 'hot-shots'` in ES module projects

## 14.2.0 (2026-3-14)

* [@bdeitte](https://github.com/bdeitte) Upgrade mocha from 10.x to 11.x and fix all dev dependency security vulnerabilities (serialize-javascript, ajv)
* [@bdeitte](https://github.com/bdeitte) BREAKING: Drop Node.js 16 support, now requires Node.js >= 18.0.0. Usually this type of change only goes in a major update, but given how very old this is, making this a minor update.

## 14.1.1 (2026-3-1)

* [@bdeitte](https://github.com/bdeitte) Version 14.1.0 published without a README for an unknown reason. Ensuring everything is reset locally and running publish again to attempt to fix.

## 14.1.0 (2026-3-1)

* [@bdeitte](https://github.com/bdeitte) Fill in some missing areas for automated tests
* [@bdeitte](https://github.com/bdeitte) CPU performance improvements: cache byteLength in sendMessage, use hrtime.bigint in timer functions, use Map in overrideTags

## 14.0.0 (2026-2-15)

* [@bdeitte](https://github.com/bdeitte) Fix methods losing parameters when given empty object for sampleRate. Fixes [#43](https://github.com/bdeitte/hot-shots/issues/43)
* [@bdeitte](https://github.com/bdeitte) Fix increment/decrement losing tags when called with tags and callback but no value. Fixes [#139](https://github.com/bdeitte/hot-shots/issues/139)
* [@bdeitte](https://github.com/bdeitte) BREAKING: Add dynamic tag support for timer/asyncTimer/asyncDistTimer via context object. Wrapped functions now receive an additional `ctx` parameter as the last argument. Fixes [#202](https://github.com/bdeitte/hot-shots/issues/202)
* [@bdeitte](https://github.com/bdeitte) Fix TCP graceful reconnection not triggering due to string error comparison. Fixes [#301](https://github.com/bdeitte/hot-shots/issues/301)
* [@bdeitte](https://github.com/bdeitte) Allow ':' in telegraph values and add more tag tests. Fixes [#303](https://github.com/bdeitte/hot-shots/issues/303)

## 13.2.0 (2026-2-1)

* [@boblauer](https://github.com/boblauer) Calculate buffer and message size in a way that accounts for non-ASCII characters

## 13.1.0 (2026-1-24)

* [@bdeitte](https://github.com/bdeitte) Add documentation for OpenTelemetry Collector StatsD receiver compatibility
* [@bdeitte](https://github.com/bdeitte) Sanitize protocol-breaking characters in metric names and tags. Fixes [#238](https://github.com/bdeitte/hot-shots/issues/238). Characters like `|`, `:`, `\n`, `#`, and `,` in metric names or tags are now replaced with `_` to prevent malformed packets.
* [@bdeitte](https://github.com/bdeitte) Document how to handle metrics on shutdown
* [@bdeitte](https://github.com/bdeitte) Prevent "socket ended" errors and handle the client disconnection errors more gracefully. Fixes [#247](https://github.com/bdeitte/hot-shots/issues/247)

## 13.0.0 (2026-1-19)

* [@bdeitte](https://github.com/bdeitte) Breaking: Prefix and suffix now automatically include period separators if needed. If you specify `prefix: 'myapp'`, it will be normalized to `'myapp.'`. Similarly, `suffix: 'prod'` becomes `'.prod'`. This ensures metrics like `myapp.request.time` instead of `myapprequest.time`. If your prefix/suffix already includes the period, no change is needed.
* [@bdeitte](https://github.com/bdeitte) Auto-detect UDP socket type (udp4/udp6) based on host IP address. IPv6 addresses like `::1` will automatically use `udp6` sockets, fixing issues on Node.js 17+ where `localhost` may resolve to IPv6.
* [@bdeitte](https://github.com/bdeitte) Add DogStatsD timestamp support via options object. Metric methods now accept an options object with `sampleRate`, `tags`, and `timestamp` properties. Timestamp can be a Date object or Unix seconds.
* [@bdeitte](https://github.com/bdeitte) Add Sinon.js for fake timers in tests, speeding up DNS cache and UDP socket options tests

## 12.1.0 (2026-1-4)

* [@bdeitte](https://github.com/bdeitte) Add client-side telemetry support with `includeDatadogTelemetry` option (disabled by default and in beta) and telemetryFlushInterval

## 12.0.0 (2025-12-16)

* [@bdeitte](https://github.com/bdeitte) event calls now use prefix and suffix
* [@bdeitte](https://github.com/bdeitte) mock mode no longer creates a socket
* [@bdeitte](https://github.com/bdeitte) using an IP no longer invokes DNS lookup
* [@bdeitte](https://github.com/bdeitte) client close no longer fails when errorHandler is defined but socket is null
* [@bdeitte](https://github.com/bdeitte) tags ending with '\\' no longer breaks telegraph

## 11.4.0 (2025-12-7)

* [@bdeitte](https://github.com/bdeitte) Add debug logging that can be enabled with "NODE_DEBUG=hot-shots"

## 11.3.0 (2025-11-30)

* [@bdeitte](https://github.com/bdeitte) Revert some buffering code to fix tag duplication issue seen with Datadog

## 11.2.0 (2025-8-23)

* [@manishrjain](https://github.com/manishrjain) Add retry mechanism for UDS with udsRetryOptions

## 11.1.1 (2025-8-10)

* [@bdeitte](https://github.com/bdeitte) Revert change to improve memory/performance of overrideTags and add more tests
* [@bdeitte](https://github.com/bdeitte) Upgrade node-unix-dram to support latest Node

## 11.1.0 (2025-6-22)

* [@bdeitte](https://github.com/bdeitte) Add more tests for uncovered areas
* [@bdeitte](https://github.com/bdeitte) When DD_AGENT_HOST is set to empty string, consider it to be undefined
* [@bdeitte](https://github.com/bdeitte) Set max size for maxBufferSize to 8192 when using UDS
* [@bdeitte](https://github.com/bdeitte) Improve memory/performance of overrideTags (reverted in 11.1.1)

## 11.0.0 (2025-6-20)

* [@bdeitte](https://github.com/bdeitte) Stop testing much older Node.js versions and test latest: now testing Node 16 to Node 24
* [@bdeitte](https://github.com/bdeitte) Enable buffering by default (as 8192) for UDS connections
* [@bdeitte](https://github.com/bdeitte) Stop adding extra newline in buffering cases where it's not needed
* [@bdeitte](https://github.com/bdeitte) Flush buffering earlier when possible (reverted in 11.3.0)
* [@bdeitte](https://github.com/bdeitte) Add CLAUDE.md for easlier Claude usage
* [@bdeitte](https://github.com/bdeitte) Ensure client.close() does not throws errors when mock: true is set

## 10.2.1 (2024-10-19)

* [@thiago-negri](https://github.com/thiago-negri) Add 'includeDataDogTags' property to 'ClientOptions' type

## 10.2.0 (2024-10-13)

* [@thiago-negri](https://github.com/thiago-negri) Add option 'includeDataDogTags'
* [@bdeitte](https://github.com/bdeitte) Upgrade dependencies for security warning and a few README updates

## 10.1.1 (2024-9-12)

* [@matteosb](https://github.com/matteosb) Handle synchronous socket.send error in sendUsingDnsCache

## 10.1.0 (2024-9-6)

* [@lachlankidson](https://github.com/lachlankidson) Add gaugeDelta function
* [@bdeitte](https://github.com/bdeitte) Various dev library updates
* [@bdeitte](https://github.com/bdeitte) Add Node 20 testing

## 10.0.0 (2023-2-3)
* [@imyourmanzi](https://github.com/imyourmanzi) In TypeScript, narrow callback parameter types
* [@bdeitte](https://github.com/bdeitte) Remove Node 8 from supported list and add testing of Node 18

## 9.3.0 (2022-10-23)
* [@albert-mirzoyan](https://github.com/albert-mirzoyan) add stream property type to ClientOptions
* [@bdeitte](https://github.com/bdeitte) Upgrade unix-dgram to support Node 18

## 9.2.0 (2022-7-30)
* [@hjr3](https://github.com/hjr3) Add udpSocketOptions to control how UDP socket is created

## 9.1.0 (2022-6-20)
* [@zhyu](https://github.com/zhyu) Append standard Datadog tags from env vars (DD_ENTITY_ID, DD_ENV, DD_SERVICE, and DD_VERSION)
* [@bdeitte](https://github.com/bdeitte) Check if client is undefined before closing to fix error
* [@bdeitte](https://github.com/bdeitte) Start using GitHub Actions for tests and remove now-broken travis file
* [@bdeitte](https://github.com/bdeitte) Update testing dependencies

## 9.0.0 (2021-10-31)
* [@cesarfd](https://github.com/cesarfd) Add TCP reconnections, similar to how it's done for UDS. Enabled by default and configurable through tcpGracefulErrorHandling/tcpGracefulRestartRateLimit.
* [@sambostock](https://github.com/sambostock) Document explicit prefix/suffix separators

## 8.5.2 (2021-9-26)
* [@amc6](https://github.com/amc6) TypeScript: add missing decrement overload type

## 8.5.1 (2021-9-2)
* [@tim-crisp](https://github.com/tim-crisp) TypeScript: add stream to protocol string union type
* [@bdeitte](https://github.com/bdeitte) Bump path-parse (used just in dev builds) from 1.0.6 to 1.0.7

## 8.5.0 (2021-7-16)
* [@maxday](https://github.com/maxday) Add a closingFlushInterval option which allows stopping quicker

## 8.4.0 (2021-7-3)
* [@roim](https://github.com/roim) Use errorHandler when possible on UDS socket replace error

## 8.3.2 (2021-5-29)
* [@cmaddalozzo](https://github.com/cmaddalozzo) Close unix domain socket after unsuccessful attempts to connect

## 8.3.1 (2021-4-1)
* [@dvd-z](https://github.com/dvd-z) Fix date_happened to allow usage of numbers

## 8.3.0 (2020-12-16)
* [@chotiwat](https://github.com/chotiwat) Handle UDS errors occurring when sending metrics

## 8.2.1 (2020-12-1)
* [@stephenmathieson](https://github.com/stephenmathieson) Make close callback optional in TypeScript definition

## 8.2.0 (2020-9-30)
* [@dhermes](https://github.com/dhermes) Making UDS error handling and recovery more robust. Note these look to be ok in a minor release but are signficant upgrades to how UDS works. Thanks as well to [@prognant](https://github.com/prognant) for an overlapping PR.

## 8.1.0 (2020-9-25)
* [@maleblond](https://github.com/maleblond) Support multiple values for the same tag key

## 8.0.0 (2020-9-23)
* [@naseemkullah](https://github.com/naseemkullah) Change default value for 'host' from 'localhost' to
  undefined. This means the default host will now be 127.0.0.1 or ::1,
  which has cases where it will speed up sending metrics. This should be a
  non-breaking change, but bumping to a major version for it given
  it's a very base change to the library.
* [@naseemkullah](https://github.com/naseemkullah) Switch from equals to strictEquals in tests

## 7.8.0 (2020-8-28)
* [@bdeitte](https://github.com/bdeitte) Fix some flaky tests
* [@ralphiech](https://github.com/ralphiech) Add missing error handler when socket is not created
* [@ralphiech](https://github.com/ralphiech) Add missing socket checks
* [@dependabot](https://github.com/dependabot) Bump lodash from 4.17.15 to 4.17.19
* [@DerGut](https://github.com/DerGut) Add "Congestion error" section to README

## 7.7.1 (2020-8-4)
* [@DerGut](https://github.com/DerGut) Fix udsGracefulErrorHandling default value

## 7.7.0 (2020-7-29)
* [@tebriel](https://github.com/tebriel) Add asyncDistTimer function

## 7.6.0 (2020-6-16)
* [@Impeekay](https://github.com/Impeekay) Add date type to timing function

## 7.5.0 (2020-6-5)
* [@benblack86](https://github.com/benblack86) Unreference underlying socket/interval to prevent process hangs

## 7.4.2 (2020-5-5)
* [@kazk](https://github.com/kazk) Fix types for set/unique

## 7.4.1 (2020-4-28)
* [@lbeschastny](https://github.com/lbeschastny) Sanitize ',' tags characters for telegraf

## 7.4.0 (2020-4-3)
* [@MichaelSitter](https://github.com/MichaelSitter) add tagPrefix and tagSeparator options

## 7.3.0 (2020-4-1)
* [@marciopd](https://github.com/marciopd) Use Date.now() instead of new Date()
* [@chotiwat](https://github.com/chotiwat) Add UDS graceful error handling options to typescript
* [@bdeitte](https://github.com/bdeitte) Update packages, most notably getting node-unix-dgram 2.0.4

## 7.2.0 (2020-3-19)
* [@marciopd](https://github.com/marciopd) Add cacheDnsTtl
* [@dependabot](https://github.com/dependabot) Bump acorn from 6.3.0 to 6.4.1

## 7.1.0 (2020-3-4)
* [@wision](https://github.com/wision) Actually fix cachedDns with udp
* [@casey-chow](https://github.com/casey-chow) TypeScript: parameterize function types in timer and asyncTimer

## 7.0.0 (2020-2-13)
* [@tomruggs](https://github.com/tomruggs) Remove support for Node 6- now supporting Node 8.x or higher
* [@tomruggs](https://github.com/tomruggs) Update to the latest mocha version to get rid of a security warning

## 6.8.7 (2020-2-10)
* [@mrknmc](https://github.com/mrknmc) Fix TypeError when increment called without a callback argument

## 6.8.6 (2020-1-28)
* [@ericmustin](https://github.com/ericmustin) callback is not properly passed bytes argument

## 6.8.5 (2019-12-19)
* [@bdeitte](https://github.com/bdeitte) Fix for socket on reading when cacheDns and udp in use

## 6.8.4 (2019-12-18)
* [@bdeitte](https://github.com/bdeitte) Fix cacheDns with udp

## 6.8.3 (2019-12-15)
* [@gleb-rudenko](https://github.com/gleb-rudenko) Fix StatsD constructor typing

## 6.8.2 (2019-11-12)
* [@almandsky](https://github.com/almandsky) Fix useDefaultRoute to work again after abstract transports

## 6.8.1 (2019-10-16)
* [@hayes](https://github.com/hayes) Add unref method to transport interface

## 6.8.0 (2019-10-14)
* [@runk](https://github.com/runk) Add new protocol, stream, and a stream parameter for
  specifying it.

## 6.7.0 (2019-10-9)
* [@runk](https://github.com/runk) Code refactoring to have abstract transports

## 6.6.0 (2019-10-7)
* [@NinjaBanjo](https://github.com/NinjaBanjo) [@msiebuhr](https://github.com/msiebuhr) Add udsGracefulErrorHandling, ensuring uds
  handles socket errors gracefully

## 6.5.1 (2019-9-28)
* [@msiebuhr](https://github.com/msiebuhr) Fix crasher when closing Unix Datagram Sockets without callback

## 6.5.0 (2019-9-22)
* [@bdeitte](https://github.com/bdeitte) Update decrement to handle missing arguments the same way
that increment does
* [@bdeitte](https://github.com/bdeitte) Document that memory may grow unbounded in mock mode
* [@bdeitte](https://github.com/bdeitte) Only load in unix-dgram library when uds protocol in use

## 6.4.1 (2019-9-19)
* [@jfirebaugh](https://github.com/jfirebaugh) Fix cacheDns option when obtaining host from DD_AGENT_HOST

## 6.4.0 (2019-6-28)
* [@tghaas](https://github.com/tghaas) Add Node 12 support to uds protocol support
* [@jhoch](https://github.com/jhoch) README clarifications

## 6.3.0 (2019-5-18)
* [@paguillama](https://github.com/paguillama) Fix user defined tag example on README optional parameters
* [@gabsn](https://github.com/gabsn) Initial support for uds protocol
* [@bdeitte](https://github.com/bdeitte) Updated and fixed up uds protocol support

## 6.2.0 (2019-4-10)
* [@ahmed-mez](https://github.com/ahmed-mez) Add support for env variables DD_AGENT_HOST,
DD_DOGSTATSD_PORT, and DD_ENTITY_ID
* [@JamesMGreene](https://github.com/JamesMGreene) Fix syntax in README example

## 6.1.1 (2019-1-8)
* [@bdeitte](https://github.com/bdeitte) Fix errorHandler to only happen again on errors
* [@Ithildir](https://github.com/Ithildir) Readme fixes

## 6.1.0 (2019-1-5)
* [@bdeitte](https://github.com/bdeitte) Ensure close() call always sends data before closing
* [@bdeitte](https://github.com/bdeitte) Recommend errorHandler over client.socket.on() for handling
errors
* [@mbellerose](https://github.com/mbellerose) Fix the timer function type definition

## 6.0.1 (2018-12-17)
* [@msmnc](https://github.com/msmnc) Fix regression when tag value is a number
* [@bdeitte](https://github.com/bdeitte) Make non-options in constructor more deprecated

## 6.0.0 (2018-12-15)
[@bdeitte](https://github.com/bdeitte) Major upgrade to the codebase to be more modern,
overhaul tests, and many small tweaks.  Most of this is internal to
the project, but there are a few changes to note for everyone:
* Now requires Node 6 or above
* Update close() to handle errors better, not doubling up in error
messages and not leaving uncaught errors

Everything else done here should be internal facing.  Those changes
include:
* Use "lebab" to ES6-ify the project
* Switch from jshint and eslint and make syntax updates based on this
* Remove a lot of duplication in tests and many small fixups in tests
* Start using Mocha 4
* Stop using index.js for testing
* Start using the code coverage report as part of the build
* Remove the ignoring of errors on close of tests, and tear down tests in general better
* Stop using "new Buffer", that is deprecated, and use Buffer.from() instead

## 5.9.2 (2018-11-10)
* [@stieg](https://github.com/stieg) Add mockBuffer to types

## 5.9.1 (2018-9-18)
* [@etaoins](https://github.com/etaoins) Add asyncTimer types
* [@blimmer](https://github.com/blimmer): Add increment doc snippet

## 5.9.0 (2018-7-27)
* [@chrismatheson](https://github.com/chrismatheson): Fix timer to have duration in microseconds (was nanoseconds)
* [@chrismatheson](https://github.com/chrismatheson): Add asyncTimer functionality

## 5.8.0 (2018-7-17)
* [@michalholasek](https://github.com/michalholasek) Clean up code formatting and split up tests
* [@michalholasek](https://github.com/michalholasek) Add tcp protocol support
* [@remie](https://github.com/remie) Add tcp protocol support

## 5.7.0 (2018-7-4)
* [@Willyham](https://github.com/Willyham) Add support for recording buffers in mock mode

## 5.6.3 (2018-6-20)
* [@singerb](https://github.com/singerb) correct close() type definition

## 5.6.2 (2018-6-15)
* [@mjesuele](https://github.com/mjesuele) Fix time in timer

## 5.6.1 (2018-6-4)
* [@MattySheikh](https://github.com/MattySheikh) Typescript: add socket type for StatsD class

## 5.6.0 (2018-6-3)
* [@drewen](https://github.com/drewen) TypeScript: add overload types for stats functions

## 5.5.1 (2018-5-30)
* [@emou](https://github.com/emou) Typescript declaration for the 'timer' method

## 5.5.0 (2018-5-30)
* [@drewen](https://github.com/drewen) Split up single file, add code coverage capabilities

## 5.4.1 (2018-5-12)
* [@jasonsack](https://github.com/jasonsack) Fixups for new useDefaultRoute option
* [@bdeitte](https://github.com/bdeitte) Test against more modern set of Node versions in Travis

## 5.4.0 (2018-4-26)
* [@RobGraham](https://github.com/RobGraham) Added `distribution()` support for DataDog v6

## 5.3.0 (2018-4-3)
* [@tanelso2](https://github.com/tanelso2) Added support for using default route on Linux

## 5.2.0 (2018-2-28)
* [@ericapisani](https://github.com/ericapisani) Add timer decorator function

## 5.1.0 (2018-2-14)
* [@lautis](https://github.com/lautis) Pass key-value tags as objects

## 5.0.1 (2018-2-2)
* [@punya-asapp](https://github.com/punya-asapp) Add childClient to TypeScript types

## 5.0.0 (2017-11-9)
* [@jgwmaxwell](https://github.com/jgwmaxwell) TypeScript typings, resolving the default export issue and missing options from last time.  This is being marked as a major release, in caution given the revert last time, but it is not actually known to cause any backwards-compatible issues.

## 4.8.0 (2017-10-31)
* [@Jiggmin](https://github.com/Jiggmin) concat prefix and suffix in check function
* [@Jiggmin](https://github.com/Jiggmin) commit package-lock.json

## 4.7.1 (2017-10-31)
* [@Jiggmin](https://github.com/Jiggmin) Add backwards compatibility for global_tags

## 4.7.0 (2017-9-21)
* [@bdeitte](https://github.com/bdeitte) Revert TypeScript typings, which ended up not being semver minor

## 4.6.0 (2017-9-19)
* [@jgwmaxwell](https://github.com/jgwmaxwell) TypeScript typings

## 4.5.0 (2017-5-4)
* [@jsocol](https://github.com/jsocol) Support default value with tags in increment

## 4.4.0 (2017-3-23)
* [@RijulB](https://github.com/RijulB) Global sample rate

## 4.3.1 (2016-11-7)
* [@RandomSeeded](https://github.com/RandomSeeded) Fix callbacks not being triggered when using buffers

## 4.3.0 (2016-9-30)
* [@ggoodman](https://github.com/ggoodman) Allow socket errors to be handled with errorHandler

## 4.2.0 (2016-8-3)
* [@mhahn](https://github.com/mhahn) Add support for DataDog service checks

## 4.1.1 (2016-5-22)
* [@ash2k](https://github.com/ash2k) date_happened should be seconds, not milliseconds

## 4.1.0 (2016-5-8)
* [@ash2k](https://github.com/ash2k) Support multiline text in DataDog events

## 4.0.0 (2016-5-7)
* [@ash2k](https://github.com/ash2k) Provided tags, including `childClient()` tags, override global tags with same names.

## 3.1.0 (2016-5-3)
* [@ash2k](https://github.com/ash2k) Support a client-wide error handler used in case no callback is provided and to handle various exceptions.

## 3.0.1 (2016-4-28)
* [@bdeitte](https://github.com/bdeitte) Add 'use strict' to files and make changes needed for this.

## 3.0.0 (2016-4-27)
* [@ash2k](https://github.com/ash2k) Method to create child clients.  (This is not a backwards-incompatible change but is rather large.)
* [@ash2k](https://github.com/ash2k) Shrink npm package a bit more

## 2.4.0 (2016-2-26)
* [@arlolra](https://github.com/arlolra) Shrink npm package
* [@arlolra](https://github.com/arlolra)/[@bdeitte](https://github.com/bdeitte) Move DNS errors when caching them to send() and use callback when possible
* [@bdeitte](https://github.com/bdeitte) Use callback for Telegraf error when possible

## 2.3.1 (2016-2-3)
* [@Pchelolo](https://github.com/Pchelolo) Ensure messages not larger then maxBufferSize

## 2.3.0 (2016-1-17)
* [@bdeitte](https://github.com/bdeitte) Fix increment(name, 0) to send a 0 count instead of 1
* [@bdeitte](https://github.com/bdeitte) Flush the queue when needed on close()

## 2.2.0 (2016-1-10)
* [@bdeitte](https://github.com/bdeitte) Document and expand on close API
* [@bdeitte](https://github.com/bdeitte) Catch more error cases for callbacks

## 2.1.2 (2015-12-9)
* [@bdeitte](https://github.com/bdeitte) Even more doc updates
* [@mmoulton](https://github.com/mmoulton) Fix multiple tags with Telegraf

## 2.1.1 (2015-12-9)
* [@bdeitte](https://github.com/bdeitte) Doc updates

## 2.1.0 (2015-12-9)
* [@mmoulton](https://github.com/mmoulton) Add options.telegraf to enable support for Telegraf's StatsD line protocol format
* [@mmoulton](https://github.com/mmoulton) Ensure message callback is sent in buffered case, even when we just buffer.

## 2.0.0 (2015-10-22)
* [@jjofseattle](https://github.com/jjofseattle) Add options.maxBufferSize and options.bufferFlushInterval
* [@bdeitte](https://github.com/bdeitte) Change options.global_tags to options.globalTags for consistency

## 1.0.2 (2015-09-25)
* [@ainsleyc](https://github.com/ainsleyc) Thrown error when cacheDNS flag fails to resolve DNS name

## 1.0.1 (2015-09-24)
* [@bdeitte](https://github.com/bdeitte) Add the event API used by DogStatsD
* [@sivy](https://github.com/sivy) Start from the base of https://github.com/sivy/node-statsd
