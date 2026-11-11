# Public packet producer recording

`response.json` is the synthetic `projectTourClientPacket({stops})` response
re-recorded from CARR PR 3182 at `fe5a1c1c4c56aa0a6c74b215576d0d667f51c007`.
Its input is its own `stops` array. No database or live records are used.

`tour-packet-template.ts` is the exact producer source at that revision.
`producer.json` pins its path, revision and SHA-256. The fixture helper executes
this source for parameterized isolation tests instead of maintaining another
formatter. Production app code never imports the snapshot.

`test/packet-presentation.test.ts` checks the source digest, compares the entire
parameterized response with the recording, runs both through the production
parser, and checks range economics, distinct size quantities and Unknown.
The browser test drives web, map and browser PDF with this recording.

To refresh, check out the pinned CARR revision in an isolated tree, import
`mcp-server/src/tour-sharing.js`, and serialize
`projectTourClientPacket({stops: recording.stops})`. Copy the exact template
source and update the producer pin and digest together. Run the contract and
browser tests before accepting a producer revision change. Tests read only
committed files and require neither a CARR checkout nor historical Git objects.
