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
        in
        {
          default = pkgs.mkShell (
            smkShell.env
            // {
              # Deno runs, type-checks and tests the Swamp extensions under extensions/; swamp's own bundled
              # copy lives outside the repository (~/.swamp/deno), so the shell pins its own.
              buildInputs = smkShell.packages ++ (with pkgs; [ deno ]);
            }
          );
        }
      );
    };
}
