# The release `swamp serve` runs from on a Linux host: swamp's own binary, the Godot editor the
# godot-build flight drives, and the user unit that starts serve against a checkout of this
# repository. It is a flake of its own, with nixpkgs as its only input, so a host builds it from a
# public checkout with no credential: the dev shell's flake in ../.nix takes smk and trees over ssh.
# nixpkgs is the revision ../.nix/flake.lock pins; move both together.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/7fd4004d0511991fff3a0524856a9be09e28c5f0";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      # The version and hash swamp-club's Homebrew tap names for linux/x86_64 (Formula/swamp.rb), the
      # release .swamp.yaml's swampVersion records and the dev shell (../.nix/flake.nix) pins. Move all
      # three together.
      version = "20261020.024627.0-sha.26dc044f";
      # The project's config/features names 4.3 (extensions/behaviors/godot/example-project), so the
      # editor is 4.3's: a newer one would rewrite the project on import.
      godot = pkgs.godot_4_3;
    in
    {
      # One derivation, the binary in it rather than linked: smk service install accepts a release once
      # the unit's main process runs from the release's own store path.
      packages.${system}.default = pkgs.stdenvNoCC.mkDerivation {
        pname = "swamp-serve";
        inherit version;
        src = pkgs.fetchurl {
          url = "https://artifacts.swamp-club.com/swamp/${version}/binary/linux/x86_64/swamp-${version}-binary-linux-x86_64.tar.gz";
          sha256 = "72af2387944486dc3408b065397272071e40857ff4db9095c166b42cbe09a3ce";
        };
        sourceRoot = ".";
        # A compiled single binary carries its program after the ELF image: strip or patchelf would
        # cut it off. It links only the host's glibc, which every target host has.
        dontFixup = true;
        installPhase = ''
          install -Dm755 swamp $out/bin/swamp
          ln -s ${pkgs.lib.getExe godot} $out/bin/godot
          mkdir -p $out/lib/systemd/user
          substitute ${./swamp-serve.service} $out/lib/systemd/user/swamp-serve.service \
            --subst-var out
        '';
      };
    };
}
