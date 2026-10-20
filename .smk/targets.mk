# smk { overwrite: true }
# The build, test and clean of each language smkproj.toml's Languages lists, and the targets of each feature it names.
# smk proj rewrites this file on every render; the repository's Makefile includes it beside .smk/checks.mk and owns
# the rest:
#
#   include $(ROOT_DIR)/.smk/checks.mk
#   include $(ROOT_DIR)/.smk/targets.mk
#   ci: build test
#
# Each language has one file under .smk/lang/ and each feature one under .smk/features/, included here in the
# descriptor's order, languages first. A file hooks its targets in by prerequisite (build: build-csharp), which make
# joins with the Makefile's own rule, so the Makefile keeps no copy of any language's recipe, listing a language adds
# one line here and one file, and dropping it removes them. A language or feature with no targets has no file, and
# -include passes it by.
SMK_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))..)

-include $(SMK_ROOT)/.smk/lang/Shell.mk
-include $(SMK_ROOT)/.smk/features/nixshell.mk
