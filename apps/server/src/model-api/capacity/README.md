# Durable capacity invariants

PostgreSQL rows are the reservation ledger: active `CapacityLease` rows consume physical and
membership capacity; `PoolMember` and `ExecutionTarget` rows define reservation and borrowing
policy; waiting `CapacityWaiter` rows determine whether reserved work is queued. No process-local
counter grants capacity.

The CI-gated integration suite uses independent clients for advisory-lock, admission, fencing,
restart, notification, and race proofs. Serialization (`40001`) and deadlock (`40P01`) retry logic is
tested through the production transaction runner with injected rollback attempts. A live
opposite-lock deadlock is intentionally not forced: PostgreSQL chooses the deadlock victim and
detection timing based on server configuration, making such a test nondeterministic and slow on
shared CI. The injected proof deterministically verifies the same driver error codes, retry bound,
and absence of state committed by failed attempts.
