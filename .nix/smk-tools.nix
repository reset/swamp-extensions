# smk { overwrite: true }
# Common shell tools from smk-shell-tools.nix and the checkers smk runs for every language, whatever the
# repository's Languages: a Unity repository holds Python, PowerShell, Terraform and shell too, and smk
# runs each file's tool or fails naming it. Rewritten on every render, so a tool
# smk adds reaches the repository with its next render. A tool that needs a language's own toolchain (dotnet
# format, terraform fmt, gofmt, ktlint's Java) comes with that language's block in smk.nix, which imports
# this:
#
#   smkTools = import ./smk-tools.nix { inherit pkgs; };
#   packages = smkTools.packages ++ [ ... ];
{ pkgs }:
let
  # PSScriptAnalyzer formats and lints PowerShell, and ships only as a PowerShell Gallery module, which is a nupkg
  # (a zip), so this unpacks it into a module directory. Bump the version and
  # the hash together; nix store prefetch-file <url> prints the hash.
  psScriptAnalyzer = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "PSScriptAnalyzer";
    version = "1.25.0";
    src = pkgs.fetchurl {
      url = "https://www.powershellgallery.com/api/v2/package/PSScriptAnalyzer/${version}";
      hash = "sha256-FOY0yCjrmO+59AspGLqQ8TntXszfZjoqdHc22ZaZXWA=";
    };
    nativeBuildInputs = [ pkgs.unzip ];
    dontUnpack = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/PSScriptAnalyzer"
      unzip -q "$src" -d "$out/PSScriptAnalyzer"
      # The nupkg's packaging, which is not part of the module.
      rm -rf "$out/PSScriptAnalyzer/_rels" "$out/PSScriptAnalyzer/package" \
        "$out/PSScriptAnalyzer/[Content_Types].xml" "$out/PSScriptAnalyzer/.signature.p7s" \
        "$out/PSScriptAnalyzer"/*.nuspec
      runHook postInstall
    '';
  };
  # lua-language-server at the version the Lua editor extension bundles, whatever the repository's nixpkgs ships:
  # its diagnostics change between releases, and smk lint must report what a developer's editor shows (and a mod
  # author's, who edits with the extension and the repository's .luarc.json). Bump the version and the hash
  # together when the extension moves; nix store prefetch-file --unpack does not cover the submodules, so take the
  # hash from the build's mismatch error. The let binding outranks `with pkgs` in the list below.
  lua-language-server = pkgs.lua-language-server.overrideAttrs (_: rec {
    version = "3.19.1";
    src = pkgs.fetchFromGitHub {
      owner = "luals";
      repo = "lua-language-server";
      tag = version;
      hash = "sha256-3Sm958Fr5wn54B+aJMaK+cR/F10dPIcGvBrhjHTy2us=";
      fetchSubmodules = true;
    };
  });
  # clang-tools wraps each tool in a bash script that adds the toolchain's include paths (clang-tidy and clangd need
  # them). Some nixpkgs revisions (151fa4e8 fixed it) build it with strictDeps
  # and no shell in buildInputs, so patchShebangs leaves the wrapper's `#!/bin/sh` alone, and where /bin/sh is dash
  # (Ubuntu) every call prints `[[: not found` and adds no include path. A shell in buildInputs lets patchShebangs point
  # the wrapper at bash, as the fixed nixpkgs does; a fixed revision already has one and keeps the cached package.
  clang-tools =
    if pkgs.clang-tools.buildInputs or [ ] == [ ] then
      pkgs.clang-tools.overrideAttrs (old: {
        buildInputs = (old.buildInputs or [ ]) ++ [ pkgs.bashNonInteractive ];
      })
    else
      pkgs.clang-tools;
  # One package per checker (smk format --list shows which files each one owns).
  checkerPackages = with pkgs; [
    biome
    caddy
    clang-tools
    deadnix
    gdtoolkit_4
    hclfmt
    htmlhint
    lua-language-server
    markdownlint-cli2
    mypy
    nixfmt
    powershell
    prettier
    ruff
    shellcheck
    shfmt
    sqlfluff
    statix
    stylua
    taplo
    tflint
    yamlfmt
    yamllint
  ];
in
{
  env = {
    # smk's PowerShell runs put this first on PSModulePath, so Import-Module PSScriptAnalyzer finds the module.
    PSSCRIPTANALYZER_MODULE_PATH = "${psScriptAnalyzer}";
  };
  packages = checkerPackages ++ (import ./smk-shell-tools.nix { inherit pkgs; });
}
