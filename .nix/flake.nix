# smk { overwrite: false }
#########################################################################
#
#                 -- Generated with smk --
#      (do not edit unless you know what you're doing)
#
#########################################################################

{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # smk and trees: each tool's own published package, from its repo's flake in .nix/: the derivation
    # that repo's main build pushes to the smk cache, built with that repo's pinned nixpkgs, so this
    # shell substitutes it rather than building it. `smk pkg bump smk` and `smk pkg bump trees` move
    # these pins.
    # smk and trees each take the other for their own dev shells, and each locked revision pins an older one
    # of the other, so without the follows the lock nests a copy of each per revision; one of each serves all.
    smk = {
      url = "git+ssh://git@git.reset.dev:2222/smk/smk-cli?dir=.nix";
      inputs.trees.follows = "trees";
    };
    trees = {
      url = "git+ssh://git@git.reset.dev:2222/smk/trees?dir=.nix";
      inputs = {
        smk.follows = "smk";
        trees.follows = "trees";
      };
    };
  };

  outputs =
    inputs@{ nixpkgs, ... }:
    let
      forEachSystem = nixpkgs.lib.genAttrs [
        # The systems smk and trees are built and published for.
        "aarch64-darwin"
        "x86_64-linux"
      ];
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
            };
          };
          smk = inputs.smk.packages.${system}.smk;
          # Managed git worktrees, one per task (smk/trees): `trees add <name>`.
          trees = inputs.trees.packages.${system}.trees;
          # smk's tools, each language's toolchain and smk's variables, from smk.nix, which smk rewrites on every
          # render. This repository's own packages join them as
          # `buildInputs = smkShell.packages ++ (with pkgs; [ ... ]);`.
          smkShell = import ./smk.nix { inherit pkgs smk trees; };
          # swamp, which bin/test runs to validate every behavior and workflow, so a build agent has it as a
          # developer does. The version and hashes are those swamp-club's Homebrew tap names (Formula/swamp.rb) for
          # the release .swamp.yaml's swampVersion records, which ../serve/flake.nix runs too; move all three
          # together.
          swampVersion = "20261020.024627.0-sha.26dc044f";
          swampTarget =
            {
              aarch64-darwin = {
                platform = "darwin-aarch64";
                hash = "sha256-/VXNcPttFfXnF0JpVuKgecWvUs3S9y/ljG5SnIrJjAI=";
              };
              x86_64-linux = {
                platform = "linux-x86_64";
                hash = "sha256-cq8jh5REhtw0CLBlOXJyBx5AhX/025CVwWa0LL4Jo84=";
              };
            }
            .${system};
          swamp = pkgs.stdenvNoCC.mkDerivation {
            pname = "swamp";
            version = swampVersion;
            src = pkgs.fetchurl {
              url = "https://artifacts.swamp-club.com/swamp/${swampVersion}/binary/${
                builtins.replaceStrings [ "-" ] [ "/" ] swampTarget.platform
              }/swamp-${swampVersion}-binary-${swampTarget.platform}.tar.gz";
              inherit (swampTarget) hash;
            };
            sourceRoot = ".";
            # A compiled single binary carries its program after the executable image: strip or patchelf would
            # cut it off. On Linux it links only the host's glibc, which the build agents' Ubuntu has.
            dontFixup = true;
            installPhase = ''
              install -Dm755 swamp $out/bin/swamp
            '';
          };
        in
        {
          default = pkgs.mkShell (
            smkShell.env
            // {
              # Deno runs, type-checks and tests the Swamp extensions under extensions/; swamp's own bundled
              # copy lives outside the repository (~/.swamp/deno), so the shell pins its own.
              buildInputs = smkShell.packages ++ [
                pkgs.deno
                swamp
              ];
            }
          );
        }
      );
    };
}
