# Export boundary

Prepared from the reviewed source snapshot identified in the external review manifest. This folder contains source files only and has no private Git history. A new repository must start with this content as a fresh initial commit.

Included: web application and tests, core/database/provider/demo/evidence libraries, migration SQL and journal, exact workspace dependency lockfile and Next patch, local runtime scripts, synthetic catalog and webhook test vectors, required evidence schemas, approved debugging prose and third-party notices.

Excluded: `.workflow`, private ledgers and worklogs, root evidence archives, original assessment attachment, provider response captures, live credential helper scripts, recording/screenshot archives, review-hub, historical decks, original Git data, configured environment files and personal/real-provider identifiers. The original assessment attachment is omitted because it is not required at runtime and redistribution permission is not established.

Privacy adaptations: reserved test-domain emails; synthetic provider IDs in seeds and matching assertions; loopback origin examples; fictional initial-letter SVG avatars; private handoff pages replaced with an export notice; minimal local deck landing page; one captured earnings-response test changed to an explicitly synthetic response. Account suspension behavior retains a synthetic example rather than the original provider identity. Captured-provider contract suites, private deck/media tests and two capture-dependent payout-session suites are omitted. SDK boundary/refusal tests remain; the vendored-byte test is omitted because the bundle itself is not redistributed.

These adaptations define a smaller source distribution, not a claim that omitted checks passed. The private application, its recorded evidence, current deployment and Linux CI status have separate acceptance records. This export is not a reproduction of its public media packet.

The public fake signing value in `tests/qa/fixtures/webhook_vectors.json`, test-only passwords, adversarial secret detector strings and invalid authentication examples are intentional fixtures. The ordinary local launcher generates ephemeral signing values instead. No captured provider payload is included.

No GitHub repository has been created by this preparation lane. Proposed name: `aneym/ledgerly-assessment`. Publication requires review of this exact content and the owner-controlled license disposition.
