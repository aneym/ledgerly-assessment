# Part 3: debugging answers

## The consumer mismatch

The missing account_id looks like a payload-contract mismatch: this event provides company_id, which we need to map to the seller. We'll validate against the schema for the supplied API version and handle unexpected payloads without crashing the consumer.

## The duplicate posting

For the double-posting, I'll confirm how withdrawal.updated and payout.updated relate in your API version rather than assume they're interchangeable. Regardless, our ledger must ensure the same underlying money movement isn't posted twice. We'll deduplicate deliveries and enforce idempotency on the withdrawal and financial transition, not just the event name.

## The pending withdrawal

I'll investigate the pending withdrawal before giving you a timeline. Two days alone doesn't establish a problem. I'll check its expected arrival, processing status, payout method, and any outstanding verification requirements.

## My first reply

> Thanks for flagging this. We'll investigate the consumer mismatch and duplicate postings separately from the pending withdrawal. Please send the withdrawal ID and both webhook event IDs so we can trace them. We'll check the seller's verification status and expected arrival before confirming a timeline. Please don't retry the withdrawal while we investigate.
