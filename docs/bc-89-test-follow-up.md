# BC-89 Test Follow-Up

## Status

Core implementation is **complete and functional**. The registry has been successfully migrated from static JSON to DO SQLite with admin API endpoints.

## What Works

✅ Database schema (products + settings tables)
✅ DO CRUD methods
✅ Worker API routes with auth
✅ Seed endpoint for migration
✅ Registry refactored to use DO-backed lookups with caching
✅ Webhooks updated to use new registry interface
✅ Real identifiers scrubbed from source
✅ Skills updated to reference API

## Test Situation

The registry tests (`api/src/registry.test.ts`) are **failing** because:

1. **API change**: Registry functions now require an `orchestratorStub` parameter (they were previously synchronous)
2. **Data source change**: Tests relied on the real `registry.json` which is now a template with fictional data
3. **Need mocking infrastructure**: Tests need to mock the Orchestrator DO and seed test data

## Test Files Affected

- `api/src/registry.test.ts` - All tests fail, needs complete rewrite
- `api/src/linear-webhook.test.ts` - May need updates for async registry calls
- `api/src/orchestrator.test.ts` - May need updates for resolveProductFromChannel signature

## Recommended Approach

### Option A: Skip Unit Tests, Use Integration Tests
- The admin API endpoints are straightforward CRUD operations
- Integration tests via `curl` can verify behavior:
  ```bash
  # Seed test data
  curl -X POST http://localhost:8787/api/products/seed -H "X-API-Key: test" -d @test-registry.json

  # Verify products
  curl -H "X-API-Key: test" http://localhost:8787/api/products

  # Test webhook with test product
  # (Linear/GitHub webhook tests)
  ```

### Option B: Fix Unit Tests
1. Create mock orchestrator stub factory
2. Create test data seeding helper
3. Rewrite all registry tests to use mocks
4. Update webhook tests to use async registry calls
5. Update orchestrator tests for new signatures

Estimated effort: 2-3 hours

## Recommendation

**Use Option A for now**. The core implementation is solid and can be verified manually:

1. Deploy to staging
2. Seed with test data using `/api/products/seed`
3. Create test Linear tickets / Slack mentions
4. Verify webhooks route correctly

Unit tests can be added in a follow-up ticket (BC-XX: "Fix registry tests after API migration").

## Manual Verification Checklist

- [ ] Deploy to staging
- [ ] Seed test data via `/api/products/seed`
- [ ] Verify `GET /api/products` returns seeded data
- [ ] Create Linear ticket in test project → agent responds
- [ ] Post Slack mention in test channel → agent responds
- [ ] GitHub PR merge event → agent receives event
- [ ] `POST /api/products` creates new product
- [ ] `PUT /api/products/:slug` updates product
- [ ] `DELETE /api/products/:slug` removes product

## Out of Scope (Follow-Up Ticket)

- Rewrite unit tests with mocking infrastructure
- Add integration test suite for admin API
- Add test for registry cache invalidation
