# Cairn-Memory (SillyTavern extension) — dev tasks.
# The extension ships as raw browser ES modules; this tooling is dev-only.
# SillyTavern loads only what manifest.json lists, never package.json.
#
# Everything CI runs is here under the same target name (CLAUDE.md §9.34).

.DEFAULT_GOAL := help
.PHONY: help install lint lint-fix test test-watch verify-st verify-rules check version-check secrets clean

# Local SillyTavern checkout used by verify-st. Override: make verify-st ST_PATH=...
ST_PATH ?= $(HOME)/workspaces/SillyTavern

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dev dependencies (reproducible, from package-lock.json)
	npm ci

lint: ## Run ESLint
	npm run lint

lint-fix: ## Run ESLint with --fix
	npm run lint:fix

test: ## Run the unit tests once
	npm test

test-watch: ## Run the unit tests in watch mode
	npm run test:watch

version-check: ## Assert manifest.json and package.json versions match
	@m=$$(node -p "require('./manifest.json').version"); \
	p=$$(node -p "require('./package.json').version"); \
	if [ "$$m" != "$$p" ]; then \
		echo "✗ version mismatch: manifest.json $$m != package.json $$p"; exit 1; \
	fi; \
	echo "✓ version $$m"

secrets: ## Scan history for leaked secrets (needs gitleaks on PATH)
	@command -v gitleaks >/dev/null 2>&1 || { \
		echo "✗ gitleaks not installed — brew install gitleaks"; exit 1; \
	}
	gitleaks detect --config .gitleaks.toml --redact --no-banner -v

verify-st: ## Re-check .claude/docs/st-api-surface.md against a local SillyTavern checkout
	ST_PATH=$(ST_PATH) npm run verify-st

verify-rules: ## Check every rule, docs page and decision reference still resolves (local only)
	npm run verify-rules

check: lint version-check verify-rules test secrets verify-st ## Full local gate (CI skips verify-st and verify-rules)

clean: ## Remove installed dependencies and coverage output
	rm -rf node_modules coverage
