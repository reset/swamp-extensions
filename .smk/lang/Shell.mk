# smk { overwrite: true }
# Shell's test, rewritten on every render. .smk/targets.mk includes this file, and make joins its hook
# (test: test-shell) with the Makefile's own test. A shell repository has no build step.
.PHONY: test-shell
test: test-shell

# bin/test is the repository's to write, since shell has no test runner to call: it exits 1 until it is written, so
# a repository with no tests has a failing build. TEST_ARGS goes to the script.
test-shell:
	"$(SMK_ROOT)/bin/test" $(TEST_ARGS)
