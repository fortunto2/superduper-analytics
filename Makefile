# superduper-analytics — canonical command interface.
# Every target must work from a clean checkout; `test` and `integration` must not need
# network or Cloudflare credentials.

.PHONY: help install gen check dev test typecheck lint format integration sync deploy tail clean

help: ## list targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

install: ## install dependencies
	pnpm install

gen: ## regenerate code from the registry and from wrangler.jsonc
	pnpm tsx cli/main.ts gen --registry registry/sources.yaml
	pnpm wrangler types --path=worker-configuration.d.ts

check: ## validate the registry and that generated code is not stale
	pnpm tsx cli/main.ts check --registry registry/sources.yaml

dev: gen ## local Worker on :8787
	pnpm wrangler dev

test: check ## unit tests (vitest + workers pool)
	pnpm vitest run

typecheck: gen ## tsc --noEmit
	pnpm tsc --noEmit

lint: ## eslint
	pnpm eslint .

format: ## prettier
	pnpm prettier --write .

integration: check ## replay fixtures through the pipeline — no network, no credentials
	pnpm tsx cli/main.ts replay --fixtures cli/fixtures

sync: ## apply registry/sources.yaml — allowed origins, write keys, partitions
	pnpm tsx cli/main.ts sync --registry registry/sources.yaml

db: ## apply db/schema.sql to the store-reports database (idempotent)
	pnpm wrangler d1 execute superduper-stores --remote --file db/schema.sql

stores: ## run the daily store-report job now, against production
	@curl -fsS -X POST -H "Authorization: Bearer $$DASHBOARD_KEY" \
	  "https://analytics.superduperai.co/v1/stores/sync$${FROM:+?from=$$FROM}" | python3 -m json.tool

deploy: gen ## deploy the Worker
	pnpm wrangler deploy

tail: ## stream production logs
	pnpm wrangler tail --format=pretty

clean: ## remove build artefacts
	rm -rf dist .wrangler node_modules/.vite
