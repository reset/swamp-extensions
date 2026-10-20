# smk { overwrite: true }
# The part of the dev shell smk owns, rewritten on every render: the tools the scripts in bin/ run, each language's
# toolchain as a block of its own (one per language in smkproj.toml's Languages), the formatters and linters smk runs
# for every language (smk-tools.nix), and the variables smk reads. flake.nix is the repository's own and imports this,
# adding its own inputs and packages beside these:
#
#   smkShell = import ./smk.nix { inherit pkgs smk trees; };
#   default = pkgs.mkShell (smkShell.env // { buildInputs = smkShell.packages ++ [ ... ]; });
{
  pkgs,
  smk,
  trees,
}:
let
  smkTools = import ./smk-tools.nix { inherit pkgs; };
in
{
  env = smkTools.env // {
    SMK_ZSH_COMPLETIONS = "${smk}/share/zsh/site-functions";
    # The lock this shell was built from: a script re-runs itself through direnv when the caller's shell carries
    # another (Godot's bin/lib/root.sh does), so it never runs tools older than its tree pins. A first evaluation,
    # before nix has written the lock, has none.
    SMK_DEV_SHELL_LOCK =
      if builtins.pathExists ./flake.lock then builtins.hashFile "sha256" ./flake.lock else "";
  };
  # Flattened, so a language's block can hold a list a platform condition chooses (lib.optionals ...).
  packages = pkgs.lib.flatten (
    (with pkgs; [
      cacert
      curl
      direnv
      dos2unix
      git
      github-cli
      gnumake
      jq
      openssh
      terraform
      unzip
      wget
      which
      # Each language's toolchain follows, one block per language in smkproj.toml's Languages.
      # smk: each language's lines follow
    ])
    ++ smkTools.packages
    ++ [
      smk
      trees
    ]
  );
}
