# Public tour packet

The existing share session reads sealed PublicTourProjection facts through `/api/share/report` and verified points through `/api/share/map`. CARR owns sourcing, sealing, safety and grants. The app owns the fixed presentation. No new data contract or publication authority is introduced.

Two designs were considered. Separate report, map and print adapters repeat membership decisions. One parsed ordered packet with fixed display cells lets the web and print share the same DOM, while map points must match every identity, sequence and label. The second design removes the unregistered `items` and `properties` fallbacks and the summary/status fallback.

The typed shape is an ordered array of public stop identities, names, addresses and fixed facts. Unknown facts display `Unknown`. Only the eight CARR client fields enter it. Nested metric keys are selected explicitly. Source evidence stays in CARR and never prints in the client copy.

The current session lifecycle remains owned by reports/share.js. The new parsing and parity work is synchronous, bounded to 50 properties, with no cache, writes, queue, retries or external calls. Existing parallel reads have a 15-second deadline and no retry. At 10x load the API remains the first shared dependency. Each page performs constant-count reads and linear local work, with no N+1 requests. Read failures or parity failures refuse output. Map-only grants retain their existing behavior and cannot print a packet.

The print action uses the browser's Save as PDF facility, with the same property DOM and a low-ink, one-property-per-page layout. It does not replace CARR's reviewed server PDF generation or grant PDF download authority. The server PDF pipeline remains independently governed.
