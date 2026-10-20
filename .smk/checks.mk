# smk { overwrite: true }
# The checks every smk project runs before a change merges, and the targets behind them. smk proj
# rewrites this file on every render; the repository's Makefile includes it and owns the rest:
#
#   include $(ROOT_DIR)/.smk/checks.mk
#   ci: build test
#
# Make joins the prerequisites of every rule for a target and lets only one of them give it a recipe,
# so `ci: checks` below and the Makefile's own `ci:` line add up, and neither overrides the other.
# Which checks run is smkproj.toml's Checks, rendered into `checks` below: a project that runs a
# different set declares it there, as `Checks = ["format", "lint"]`, and smk proj renders it here.
# Every recipe is one line that starts from this file's repository, so it runs the same whether or not
# the including Makefile sets .ONESHELL.
SMK_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))..)

.PHONY: checks ci format check-format lint check-types hooks
# Every check smk runs before a change merges, as smkproj.toml's Checks names them.
checks: check-format lint check-types
ci: checks

# Layout is whatever `smk format` produces: run `make format` before staging. check-format and lint
# change nothing. `smk format --list` shows how every tracked file is classified, and a file no
# language claims fails both until its language is named or it is excluded in smkproj.toml.
format:
	cd "$(SMK_ROOT)" && smk format

# Fails on any file smk format would change, and changes none.
check-format:
	cd "$(SMK_ROOT)" && smk format --check

# Each language's linter over the tracked files, changing none.
lint:
	cd "$(SMK_ROOT)" && smk lint

# Every project's types, by its language's checker: smk typecheck builds each C# solution, runs each
# TypeScript project's own tsc, checks Python strictly and vets each Go module. A typed file
# with no project above it fails; languages without static types are listed and pass.
check-types:
	cd "$(SMK_ROOT)" && smk typecheck

# Registers .githooks/pre-commit, which checks the staged files' formatting as the index holds them.
# It stops a commit to review and restage, and never rewrites or stages anything itself. A configured
# hook runs beside .git/hooks, where core.hooksPath would replace it and drop Git LFS's hooks; a clone
# an earlier version pointed at .githooks goes back to .git/hooks, or it runs twice.
hooks:
	git -C "$(SMK_ROOT)" config hook.smk-format.event pre-commit && git -C "$(SMK_ROOT)" config hook.smk-format.command .githooks/pre-commit && if [ "$$(git -C "$(SMK_ROOT)" config core.hooksPath)" = .githooks ]; then git -C "$(SMK_ROOT)" config --unset core.hooksPath; fi
