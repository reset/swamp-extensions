# smk { overwrite: true }
# The common command-line tools, included by smk-tools.nix for every language's dev shell.
{ pkgs }:
with pkgs;
[
  bash
  coreutils
  findutils
  gawk
  gnugrep
  gnused
  ripgrep
]
